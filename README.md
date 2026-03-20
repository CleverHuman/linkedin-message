# LinkedIn Message Capture - Chrome Extension

A Chrome extension that passively captures LinkedIn messages from the messaging sidebar and sends them to an n8n webhook for HubSpot activity logging.

## Architecture

```
+----------------------------------------------------------+
|  Chrome Browser                                          |
|                                                          |
|  linkedin.com/messaging/*                                |
|  +----------------------------------------------------+  |
|  |  Sidebar (Conversation List)    |  Thread Panel    |  |
|  |                                 |                  |  |
|  |  [Contact A] last msg...       |  Profile URL     |  |
|  |  [Contact B] last msg...  <--- |  (active only)   |  |
|  |  [Contact C] last msg...       |                  |  |
|  +----------------------------------------------------+  |
|       |                                                   |
|       | polls every 5s                                    |
|       v                                                   |
|  +------------------+                                     |
|  |  config.js       |  WEBHOOK_URL                        |
|  +------------------+                                     |
|       |                                                   |
|  +------------------+    +----------------------------+   |
|  |  content.js      |--->|  chrome.storage.local      |   |
|  |                  |    |                            |   |
|  |  - Poll sidebar  |    |  - seen fingerprints       |   |
|  |  - Extract data  |    |    (name+message combos)   |   |
|  |  - Detect changes|    |  - known contacts          |   |
|  |  - Send via XHR  |    |    (is_new_contact flag)   |   |
|  +------------------+    +----------------------------+   |
|       |                                                   |
|       | POST (XHR)                                        |
+-------|---------------------------------------------------+
        |
        v
+------------------+     +------------------+
|  n8n Webhook     |---->|  HubSpot         |
|                  |     |                  |
|  - Receive batch |     |  - Log activity  |
|  - Fuzzy match   |     |  - Create/update |
|  - Route contact |     |    contact       |
+------------------+     +------------------+
```

## File Structure

```
extension/
├── manifest.json        # Chrome Extension Manifest V3
├── config.js            # N8N Webhook URL configuration
├── content.js           # Core logic — DOM polling, extraction, webhook
├── background.js        # Service worker (minimal, lifecycle only)
└── .gitignore           # Ignores
```

## How It Works

### 1. Auto-Detection
The content script activates automatically when the user navigates to `linkedin.com/messaging/*`. No manual trigger needed.

### 2. Sidebar Polling (every 5 seconds)
The extension reads the **conversation list sidebar** — not individual message threads. For each conversation card it extracts:

| Field | DOM Selector | Description |
|---|---|---|
| Contact Name | `h3.msg-conversation-listitem__participant-names span.truncate` | Participant name |
| Message Snippet | `p.msg-conversation-card__message-snippet` | Last message preview |
| Timestamp | `time.msg-conversation-listitem__time-stamp` | Relative or absolute time |
| Direction | Snippet prefix `"You:"` | `outgoing` if starts with "You:", else `incoming` |
| Message Type | `.msg-conversation-card__pill` | `InMail`, `LinkedIn Offer`, etc. |
| Profile URL | `a.msg-s-event-listitem__link[href*='/in/']` | Only for active (open) conversation |

### 3. Change Detection (Fingerprinting)
Each conversation is fingerprinted as `contactName + "||" + messageSnippet`. This fingerprint is stored in `chrome.storage.local`.

- **Same fingerprint seen before** → skip (no change)
- **New fingerprint** → message changed → include in webhook payload
- **Persisted across page refreshes** — no duplicate sends on reload

### 4. New Contact Tracking
The `is_new_contact` flag is tracked by contact name in `chrome.storage.local`:
- First time a contact name appears → `is_new_contact: true`
- All subsequent sends for that name → `is_new_contact: false`

### 5. Webhook Payload
All changed conversations are batched into a **single POST request**:

```json
{
  "conversations": [
    {
      "contact_name": "Jason Wong",
      "message": "Exciting opportunity for a frontend developer",
      "timestamp": "2026-03-04T00:00:00.000Z",
      "source": "linkedin",
      "direction": "incoming",
      "is_new_contact": true,
      "message_type": "InMail",
      "profile_url": "https://www.linkedin.com/in/ACoAABqk..."
    },
    {
      "contact_name": "Michael Bruan",
      "message": "Michael: Ok I will check my email later.",
      "timestamp": "2026-03-12T00:00:00.000Z",
      "source": "linkedin",
      "direction": "incoming",
      "is_new_contact": true
    }
  ]
}
```

- `profile_url` is only included for the currently active (open) conversation
- `message_type` is only included when a pill label exists (InMail, LinkedIn Offer, etc.)
- If no conversations have changed, **no request is sent**

## Anti-Detection Strategy

- No LinkedIn API calls — pure DOM reading
- No automated scrolling or clicking
- Passive polling with `setInterval` (no MutationObserver overhead)
- No DOM modifications
- XHR requests go to external webhook only, not to LinkedIn

## Setup

1. Update `WEBHOOK_URL` in `config.js` with your n8n webhook URL
2. Go to `chrome://extensions/` → Enable Developer Mode
3. Click "Load unpacked" → Select the `extension/` folder
4. Navigate to `linkedin.com/messaging` — the extension activates automatically

## Storage Keys

| Key | Purpose |
|---|---|
| `linkedin_msg_seen_fingerprints` | Set of `name\|\|message` combos already sent |
| `linkedin_msg_known_contacts` | Set of contact names seen at least once |
| `webhook_url` | n8n webhook URL (set by config.js) |

To reset all state: `chrome.storage.local.clear()` in the extension's DevTools console.
