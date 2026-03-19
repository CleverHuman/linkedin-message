// LinkedIn Message Capture - Content Script
// Polls the sidebar conversation list every 5 seconds
// Detects when a contact's last message changes and sends to n8n

(function () {
  "use strict";

  const SEEN_FINGERPRINTS_KEY = "linkedin_msg_seen_fingerprints";
  const KNOWN_CONTACTS_KEY = "linkedin_msg_known_contacts";
  const POLL_INTERVAL = 5000;

  // Caches (loaded from chrome.storage.local once)
  let seenFingerprints = null;
  let knownContacts = null;

  async function getSeenFingerprints() {
    if (seenFingerprints === null) {
      const stored = await chrome.storage.local.get(SEEN_FINGERPRINTS_KEY);
      seenFingerprints = new Set(stored[SEEN_FINGERPRINTS_KEY] || []);
    }
    return seenFingerprints;
  }

  async function saveSeenFingerprints() {
    await chrome.storage.local.set({
      [SEEN_FINGERPRINTS_KEY]: Array.from(seenFingerprints),
    });
  }

  async function getKnownContacts() {
    if (knownContacts === null) {
      const stored = await chrome.storage.local.get(KNOWN_CONTACTS_KEY);
      knownContacts = new Set(stored[KNOWN_CONTACTS_KEY] || []);
    }
    return knownContacts;
  }

  async function addKnownContact(name) {
    const contacts = await getKnownContacts();
    contacts.add(name);
    await chrome.storage.local.set({
      [KNOWN_CONTACTS_KEY]: Array.from(contacts),
    });
  }

  // Parse timestamp text from sidebar
  function parseTimestamp(rawTime) {
    if (!rawTime) return new Date().toISOString();
    const trimmed = rawTime.trim();

    const directParse = new Date(trimmed);
    if (!isNaN(directParse.getTime())) {
      return directParse.toISOString();
    }

    const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (timeMatch) {
      const now = new Date();
      let hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const period = timeMatch[3].toUpperCase();
      if (period === "PM" && hours !== 12) hours += 12;
      if (period === "AM" && hours === 12) hours = 0;
      now.setHours(hours, minutes, 0, 0);
      return now.toISOString();
    }

    return new Date().toISOString();
  }

  // Extract conversation data from a sidebar list item
  function extractConversation(li) {
    if (li.classList.contains("msg-conversation-card--occluded")) {
      return null;
    }

    const nameEl = li.querySelector(
      "h3.msg-conversation-listitem__participant-names span.truncate"
    );
    const snippetEl = li.querySelector(
      "p.msg-conversation-card__message-snippet"
    );
    const timeEl = li.querySelector(
      "time.msg-conversation-listitem__time-stamp"
    );

    if (!nameEl || !snippetEl) return null;

    const contactName = nameEl.textContent.trim();
    const rawSnippet = snippetEl.textContent.trim();
    const rawTime = timeEl ? timeEl.textContent.trim() : "";

    const snippet = rawSnippet.replace(/\s+/g, " ").trim();
    if (!contactName || !snippet) return null;

    const direction = snippet.startsWith("You:") ? "outgoing" : "incoming";

    let message = snippet;
    const pillEl = snippetEl.querySelector(".msg-conversation-card__pill");
    const pillText = pillEl ? pillEl.textContent.trim() : "";
    if (pillText) {
      message = message.replace(pillText, "").trim();
    }

    return {
      contact_name: contactName,
      message: message,
      timestamp: parseTimestamp(rawTime),
      source: "linkedin",
      direction: direction,
      pill: pillText || null,
      // Fingerprint: unique combo of name + message content
      _fingerprint: contactName + "||" + message,
    };
  }

  // Send array payload via XHR
  function sendToWebhook(conversations) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", WEBHOOK_URL, true);
      xhr.setRequestHeader("Content-Type", "application/json");

      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          console.log(
            `[LinkedIn Capture] Sent ${conversations.length} updated contacts`
          );
          resolve(true);
        } else {
          console.warn(
            `[LinkedIn Capture] Webhook ${xhr.status}:`,
            xhr.responseText
          );
          resolve(false);
        }
      };

      xhr.onerror = function () {
        console.error("[LinkedIn Capture] Webhook network error");
        resolve(false);
      };

      xhr.send(JSON.stringify({ conversations }));
    });
  }

  // Get the profile URL from the active (open) conversation thread panel
  function getActiveConversationProfile() {
    // Find the name of the active conversation from sidebar
    const activeLi = document.querySelector(
      ".msg-conversations-container__convo-item-link--active"
    );
    if (!activeLi) return { name: null, url: null };

    const nameEl = activeLi.closest("li")?.querySelector(
      "h3.msg-conversation-listitem__participant-names span.truncate"
    );
    const activeName = nameEl ? nameEl.textContent.trim() : null;

    // Extract profile URL from the open thread panel
    const profileLink = document.querySelector(
      "a.msg-s-event-listitem__link[href*='/in/']"
    );
    const profileUrl = profileLink
      ? profileLink.getAttribute("href")
      : null;

    return { name: activeName, url: profileUrl };
  }

  // Main poll function
  async function pollConversations() {
    const listItems = document.querySelectorAll(
      "li.msg-conversation-listitem"
    );

    if (listItems.length === 0) return;

    const fingerprints = await getSeenFingerprints();
    const contacts = await getKnownContacts();
    const changedConversations = [];
    const activeProfile = getActiveConversationProfile();

    for (const li of listItems) {
      const data = extractConversation(li);
      if (!data) continue;

      // If we've already seen this exact name+message combo, skip
      if (fingerprints.has(data._fingerprint)) continue;

      // New message detected — mark fingerprint as seen
      fingerprints.add(data._fingerprint);

      const isNewContact = !contacts.has(data.contact_name);

      const payload = {
        contact_name: data.contact_name,
        message: data.message,
        timestamp: data.timestamp,
        source: "linkedin",
        direction: data.direction,
        is_new_contact: isNewContact,
      };

      // Add profile URL if this is the active conversation
      if (
        activeProfile.url &&
        activeProfile.name === data.contact_name
      ) {
        payload.profile_url = activeProfile.url;
      }

      if (data.pill) {
        payload.message_type = data.pill;
      }

      changedConversations.push(payload);

      // Mark contact as known (by name, for is_new_contact flag)
      if (isNewContact) {
        await addKnownContact(data.contact_name);
      }
    }

    if (changedConversations.length > 0) {
      await saveSeenFingerprints();
      console.log(
        `[LinkedIn Capture] ${changedConversations.length} contacts with new messages`
      );
      await sendToWebhook(changedConversations);
    }
  }

  // Initialize
  function init() {
    console.log("[LinkedIn Capture] Content script loaded");
    console.log("[LinkedIn Capture] Webhook URL:", WEBHOOK_URL);
    console.log(
      `[LinkedIn Capture] Polling sidebar every ${POLL_INTERVAL / 1000}s`
    );

    setTimeout(() => {
      pollConversations();
      setInterval(pollConversations, POLL_INTERVAL);
    }, 3000);
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
