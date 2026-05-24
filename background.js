/**
 * background.js
 * Manifest V3 Service Worker
 * 
 * Responsibilities:
 * 1. Listen for intercepted Claude usage limit information from content scripts.
 * 2. Store the latest organization ID and reset timestamp in chrome.storage.
 * 3. Schedule a chrome.alarm to fire exactly 1 minute after the limit resets.
 * 4. Execute a silent, headless POST fetch to Claude to send the "Hi" message when the alarm triggers.
 */

// Alarm name constant to ensure we use a single scheduled alarm instance
const LIMIT_RESET_ALARM_NAME = 'ClaudeLimitResetAlarm';

// Initialize extension state/listeners
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Claude Limits Auto-Reset] Extension installed and background worker active.');
});

/**
 * Listener for messages from the content script.
 * Expects message type: 'CLAUDE_USAGE_INTERCEPTED'
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CLAUDE_USAGE_INTERCEPTED') {
    const { organizationId, resetsAt } = message;

    if (!organizationId || !resetsAt) {
      sendResponse({ status: 'ignored', error: 'Missing organizationId or resetsAt' });
      return;
    }

    // Process and schedule the alarm
    handleUsageLimitsIntercepted(organizationId, resetsAt)
      .then(result => {
        sendResponse({ status: 'success', data: result });
      })
      .catch(error => {
        console.error('[Claude Limits Auto-Reset] Error in message handler:', error);
        sendResponse({ status: 'error', error: error.message });
      });

    // Return true to indicate we will send response asynchronously
    return true;
  }
});

/**
 * Handle the usage limits payload, save to storage, and schedule the alarm.
 * 
 * @param {string} organizationId 
 * @param {string} resetsAt 
 */
async function handleUsageLimitsIntercepted(organizationId, resetsAt) {
  // Parse the timestamp
  const resetsAtMs = new Date(resetsAt).getTime();
  if (isNaN(resetsAtMs)) {
    throw new Error(`Invalid resets_at timestamp format: ${resetsAt}`);
  }

  // Schedule alarm for exactly 1 minute (60,000 ms) after the limit resets
  const alarmTimeMs = resetsAtMs + (60 * 1000);
  const now = Date.now();

  // Retrieve current execution records to avoid redundant requests for the same resetsAt window
  const storage = await chrome.storage.local.get(['lastResetSeen', 'lastResetExecuted']);
  
  // Save current details to storage
  await chrome.storage.local.set({
    organizationId,
    lastResetSeen: resetsAt
  });

  console.log('[Claude Limits Auto-Reset] Intercepted Details saved to storage:', {
    organizationId,
    lastResetSeen: resetsAt,
    scheduledAlarmTime: new Date(alarmTimeMs).toLocaleString()
  });

  // If the reset timestamp is identical to the one we already executed, skip scheduling
  if (storage.lastResetExecuted === resetsAt) {
    console.log('[Claude Limits Auto-Reset] Alarm skipped. Reset window already executed:', resetsAt);
    return { status: 'already_executed', resetsAt };
  }

  // If the alarm target time is already in the past, or very close (e.g. less than 10 seconds in future),
  // we trigger the message execution immediately to maximize the window.
  if (alarmTimeMs <= now + 10000) {
    console.log('[Claude Limits Auto-Reset] Reset time is in the past or imminent. Triggering execution immediately.');
    // Execute immediately in a non-blocking fashion
    triggerSilentMessage(organizationId, resetsAt);
    return { status: 'executed_immediately', alarmTimeMs };
  }

  // Otherwise, clear any old alarm and schedule a new one
  await chrome.alarms.clear(LIMIT_RESET_ALARM_NAME);
  chrome.alarms.create(LIMIT_RESET_ALARM_NAME, { when: alarmTimeMs });
  
  console.log(`[Claude Limits Auto-Reset] Scheduled alarm '${LIMIT_RESET_ALARM_NAME}' for: ${new Date(alarmTimeMs).toISOString()}`);
  return { status: 'scheduled', alarmTimeMs };
}

/**
 * Listen for the alarm trigger
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === LIMIT_RESET_ALARM_NAME) {
    console.log(`[Claude Limits Auto-Reset] Alarm '${alarm.name}' triggered.`);
    
    // Retrieve stored organization details and last seen resetsAt
    const storage = await chrome.storage.local.get(['organizationId', 'lastResetSeen', 'lastResetExecuted']);
    
    if (!storage.organizationId || !storage.lastResetSeen) {
      console.error('[Claude Limits Auto-Reset] Alarm fired, but missing organizationId or lastResetSeen in storage.');
      return;
    }

    // Double check that we haven't executed this reset window yet
    if (storage.lastResetExecuted === storage.lastResetSeen) {
      console.log('[Claude Limits Auto-Reset] Alarm triggered, but the current reset window has already been executed. Skipping.');
      return;
    }

    // Execute the action
    await triggerSilentMessage(storage.organizationId, storage.lastResetSeen);
  }
});

/**
 * Silently sends the "Hi" message to Claude.ai to start a new chat conversation.
 * Uses fetch() API with credentials: 'include' to pass active session cookies.
 * 
 * @param {string} organizationId 
 * @param {string} resetsAt 
 */
async function triggerSilentMessage(organizationId, resetsAt) {
  // Retrieve settings to check if we are sending to a specific chat or starting a new one
  const config = await chrome.storage.local.get(['chatMode', 'specificChatUuid']);
  const chatMode = config.chatMode || 'new';
  const specificChatUuid = config.specificChatUuid ? config.specificChatUuid.trim() : '';

  let chatUuid;
  let parentMessageUuid;
  let shouldCreateChat = false;

  if (chatMode === 'specific' && specificChatUuid) {
    chatUuid = specificChatUuid;
    console.log(`[Claude Limits Auto-Reset] Configured to target specific chat: ${chatUuid}`);

    // Retrieve conversation history to find the parent message UUID (the last message in the chat)
    const getChatUrl = `https://claude.ai/api/organizations/${organizationId}/chat_conversations/${chatUuid}`;
    try {
      const getChatResponse = await fetch(getChatUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'accept': 'application/json'
        }
      });

      if (!getChatResponse.ok) {
        const errorText = await getChatResponse.text().catch(() => '');
        throw new Error(`Failed to retrieve target conversation details! Status: ${getChatResponse.status}. Body: ${errorText}`);
      }

      const chatDetails = await getChatResponse.json();
      if (chatDetails && Array.isArray(chatDetails.chat_messages) && chatDetails.chat_messages.length > 0) {
        const lastMessage = chatDetails.chat_messages[chatDetails.chat_messages.length - 1];
        parentMessageUuid = lastMessage.uuid;
        console.log(`[Claude Limits Auto-Reset] Retrieved parent message UUID from chat history: ${parentMessageUuid}`);
      } else {
        parentMessageUuid = crypto.randomUUID();
        console.log('[Claude Limits Auto-Reset] Target conversation has no message history. Using generated parent UUID.');
      }
    } catch (err) {
      throw new Error(`Failed during specific chat retrieval: ${err.message}`);
    }
  } else {
    // New Chat Mode (default)
    chatUuid = crypto.randomUUID();
    parentMessageUuid = crypto.randomUUID();
    shouldCreateChat = true;
    console.log(`[Claude Limits Auto-Reset] Configured to start a new chat: ${chatUuid}`);
  }

  const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const createChatUrl = `https://claude.ai/api/organizations/${organizationId}/chat_conversations`;
  const completionUrl = `https://claude.ai/api/organizations/${organizationId}/chat_conversations/${chatUuid}/completion`;

  const payload = {
    prompt: 'Hi',
    parent_message_uuid: parentMessageUuid,
    timezone: userTimezone,
    model: 'claude-sonnet-4-6'
  };

  try {
    if (shouldCreateChat) {
      console.log(`[Claude Limits Auto-Reset] Step 1: Creating new chat conversation: ${chatUuid}`);
      
      const createChatResponse = await fetch(createChatUrl, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json'
        },
        body: JSON.stringify({
          uuid: chatUuid,
          name: ''
        })
      });

      if (!createChatResponse.ok) {
        const errorText = await createChatResponse.text().catch(() => '');
        throw new Error(`Failed to create chat conversation! Status: ${createChatResponse.status}. Body: ${errorText}`);
      }
      
      console.log('[Claude Limits Auto-Reset] Chat conversation created.');
    }

    console.log(`[Claude Limits Auto-Reset] Triggering silent message completion on chat: ${chatUuid}...`);

    // Send the completion request
    const response = await fetch(completionUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP error during completion! Status: ${response.status}. Body: ${errorText}`);
    }

    console.log('[Claude Limits Auto-Reset] Fetch request sent successfully. Reading response stream...');

    // Since Claude replies with a Server-Sent Events (SSE) text/event-stream,
    // we must read the stream to ensure the request finishes fully on the server side
    // and doesn't get cut off.
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          const chunk = decoder.decode(value, { stream: true });
          // Log chunks to debug console (optional/low-level debugging)
          console.debug('[Claude Limits Auto-Reset] Stream chunk received');
        }
      } finally {
        reader.releaseLock();
      }
    }

    console.log('[Claude Limits Auto-Reset] Message session fully completed and completed successfully.');

    // Save successful execution to storage
    await chrome.storage.local.set({
      lastResetExecuted: resetsAt,
      lastExecutionStatus: {
        timestamp: new Date().toISOString(),
        success: true,
        chatUuid
      }
    });

  } catch (error) {
    console.error('[Claude Limits Auto-Reset] Failed to execute silent message:', error);

    // Save failure to storage for debug visibility
    await chrome.storage.local.set({
      lastExecutionStatus: {
        timestamp: new Date().toISOString(),
        success: false,
        error: error.message
      }
    });
  }
}
