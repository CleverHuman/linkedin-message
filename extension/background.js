// LinkedIn Message Capture - Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  console.log("[LinkedIn Capture BG] Extension installed");
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "SEND_TO_WEBHOOK") {
    sendToWebhook(request.payload)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({ success: false, error: err.message })
      );
    return true; 
  }
});

async function sendToWebhook(payload) {
  // Read webhook URL from storage 
  const stored = await chrome.storage.local.get("webhook_url");
  const webhookUrl = stored.webhook_url;

  if (!webhookUrl || webhookUrl.includes("your-n8n-instance")) {
    console.warn("[LinkedIn Capture BG] Webhook URL not configured");
    return { success: false, error: "Webhook URL not configured" };
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[LinkedIn Capture BG] Webhook ${response.status}:`, text);
    return { success: false, error: `HTTP ${response.status}` };
  }

  console.log("[LinkedIn Capture BG] Webhook success for:", payload.contact_name);
  return { success: true };
}
