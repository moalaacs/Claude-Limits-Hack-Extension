# Claude Limits Auto-Reset Hack Extension 🤖⏱️

A Manifest V3 Chrome extension that runs entirely in the background to monitor Claude.ai usage limits and automatically schedule a silent "Hi" message exactly when your limits reset. 

This automation maximizes your 5-hour usage windows, ensuring you get the absolute most out of your Claude token limits without manual tracking or disrupting your workflow.

---

## 💡 The "Why"
Claude's usage limits reset every 5 hours **from your first message**, not at midnight or on a rolling daily basis. 
* If you send your first message at 9 AM, your resets are at 2 PM and 7 PM (2 windows).
* If you send your first message at 6 AM, your resets are at 11 AM and 4 PM (3 windows).

This extension automates that 6 AM (or exact reset time) "Hi" message. It acts as an invisible API client, saving you from hitting the dreaded usage limit wall while deep into a complex coding session.

---

## ✨ Features
* **100% Headless Execution:** No DOM scraping, no popup windows, and no new tabs taking focus. It runs silently in the background.
* **Target Specific Conversations:** Select between starting a new chat or continuing an existing conversation thread (by entering its UUID) via a built-in UI.
* **Smart Network Interception:** Bypasses Manifest V3 restrictions by injecting a lightweight script into the `MAIN` world to intercept `window.fetch` responses and parse the exact `resets_at` timestamp directly from Claude's internal API.
* **Precision Scheduling:** Uses Chrome's native `chrome.alarms` API to trigger exactly 1 minute after your limit officially resets.
* **Session Cookie Authentication:** Utilizes your active browser session (`credentials: 'include'`) to authenticate requests securely.
* **Premium Glassmorphic Dashboard:** Built-in settings popup with live statuses showing the next scheduled reset alarm and details about the last executed trigger.

---

## 🏗️ Architecture
The extension is composed of the following files:
* [manifest.json](manifest.json): Configuration settings registering minimal permissions (`alarms`, `storage`, `webRequest`, `cookies`), service worker, popup action, and content scripts.
* [content-main.js](content-main.js): Injected into the page context (`MAIN` world). Overrides `window.fetch` to intercept responses to `/api/organizations/*/usage` and dispatches a custom DOM event.
* [content-isolated.js](content-isolated.js): Runs in the extension's isolated world. Listens for the DOM event and relays the payload to the background service worker.
* [background.js](background.js): The Service Worker. Manages state in `chrome.storage.local`, handles the alarm queue, and executes the silent requests. In specific chat mode, it fetches thread history first to extract the correct `parent_message_uuid` (the last message's UUID).
* [popup.html](popup.html): Dynamic glassmorphic UI allowing the user to select between "New Chat" and "Specific Chat" modes and specify a custom chat UUID.
* [popup.js](popup.js): Loads configuration from storage, handles user inputs, debounces text edits, and displays active alarms/execution log history.

---

## 🚀 Installation & Setup

1. Clone or download this repository to your local machine.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle switch in the top right corner.
4. Click the **Load unpacked** button in the top left corner.
5. Select the folder containing the extension files (`Claude-Limits-Extension`).
6. Click the extension icon in the toolbar to configure the trigger destination (defaults to starting a **New Chat**).
7. Open [Claude.ai](https://claude.ai) to initialize the interceptor. The extension will automatically catch your next usage limit update, schedule the background alarm, and update the status dashboard.

---

## 🛠️ Verification & Troubleshooting
To verify the extension is working:
1. Open the Developer Tools (F12) on Claude.ai to see the successful injection logs in the Console:
   * `[Claude Limits Auto-Reset] main-world fetch interceptor injected successfully.`
   * `[Claude Limits Auto-Reset] isolated-world message relay active.`
2. Go to `chrome://extensions/` and click the **service worker** link on the extension card to monitor background activity, alarm scheduling, and successful fetch requests.
3. Open the extension popup to view live tracking of the next alarm execution and the status of the last automated request.

---

## ⚠️ Disclaimer
This is an unofficial automation tool. It interacts with Claude's undocumented internal APIs, which may change at any time. Use responsibly and be aware of Anthropic's Terms of Service regarding automated account usage.
