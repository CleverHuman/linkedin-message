// n8n webhook URL - update this with your actual webhook URL
const WEBHOOK_URL = "https://cleverhuman.app.n8n.cloud/webhook-test/40912a13-d318-4d0f-9e5c-fefb626e7d86";

chrome.storage.local.set({ webhook_url: WEBHOOK_URL });