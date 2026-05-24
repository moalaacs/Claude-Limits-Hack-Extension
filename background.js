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

// Alarm name constants to ensure we use single scheduled alarm instances
const LIMIT_RESET_ALARM_NAME = 'ClaudeLimitResetAlarm';
const POLLING_ALARM_NAME = 'ClaudeLimitsPollAlarm';

// Initialize extension state/listeners
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Claude Limits Auto-Reset] Extension installed. Registering background listeners...');
  
  // Schedule usage limits polling to run every 30 minutes in the background
  chrome.alarms.create(POLLING_ALARM_NAME, { periodInMinutes: 30 });
  
  // Run an initial check immediately on install
  pollClaudeLimits().catch(err => {
    console.debug('[Claude Limits Auto-Reset] Initial limits check failed (likely logged out):', err.message);
  });
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[Claude Limits Auto-Reset] Browser startup detected. Querying usage limits...');
  
  // Run a startup check immediately
  pollClaudeLimits().catch(err => {
    console.debug('[Claude Limits Auto-Reset] Startup limits check failed:', err.message);
  });
});

/**
 * Listener for messages from content scripts or popup.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CLAUDE_USAGE_INTERCEPTED') {
    const { organizationId, resetsAt, utilization } = message;

    if (!organizationId || !resetsAt) {
      sendResponse({ status: 'ignored', error: 'Missing organizationId or resetsAt' });
      return;
    }

    // Process and schedule the alarm
    handleUsageLimitsIntercepted(organizationId, resetsAt, utilization)
      .then(result => {
        sendResponse({ status: 'success', data: result });
      })
      .catch(error => {
        console.error('[Claude Limits Auto-Reset] Error in message handler:', error);
        sendResponse({ status: 'error', error: error.message });
      });

    return true; // Send response asynchronously
  }

  if (message.type === 'SYNC_LIMITS_NOW') {
    pollClaudeLimits()
      .then(result => {
        sendResponse({ status: 'success', data: result });
      })
      .catch(error => {
        sendResponse({ status: 'error', error: error.message });
      });

    return true; // Send response asynchronously
  }
});

/**
 * Handle the usage limits payload, save to storage, and schedule the alarm.
 * 
 * @param {string} organizationId 
 * @param {string} resetsAt 
 * @param {number} [utilization]
 */
async function handleUsageLimitsIntercepted(organizationId, resetsAt, utilization) {
  // Parse the timestamp
  const resetsAtMs = new Date(resetsAt).getTime();
  if (isNaN(resetsAtMs)) {
    throw new Error(`Invalid resets_at timestamp format: ${resetsAt}`);
  }

  const now = Date.now();
  const resetAlarmTimeMs = resetsAtMs + (60 * 1000); // Trigger 1 minute after reset time

  // Retrieve current execution records to avoid redundant requests for the same resetsAt window
  const storage = await chrome.storage.local.get(['lastResetSeen', 'lastResetExecuted']);
  
  // Save current details to storage
  await chrome.storage.local.set({
    organizationId,
    lastResetSeen: resetsAt,
    utilization: utilization !== undefined ? utilization : null
  });

  console.log('[Claude Limits Auto-Reset] Intercepted Details saved to storage:', {
    organizationId,
    lastResetSeen: resetsAt,
    utilization,
    scheduledAlarmTime: new Date(resetAlarmTimeMs).toLocaleString()
  });

  // Determine if the user is actively blocked/rate-limited.
  // The user is rate-limited only if their utilization is 100% and resetsAt is in the future.
  // If utilization < 100%, they are active and their limit is rolling, so we must continue polling.
  const isRateLimited = (utilization === undefined || utilization >= 100.0) && (resetsAtMs > now);

  // Case A: The user is actively rate-limited (Locked out)
  if (isRateLimited) {
    console.log('[Claude Limits Auto-Reset] Smart Sync: User is rate-limited. Pausing periodic polling...');

    // 1. Schedule the message trigger (1 minute after reset) if not executed already
    if (storage.lastResetExecuted !== resetsAt) {
      await chrome.alarms.clear(LIMIT_RESET_ALARM_NAME);
      chrome.alarms.create(LIMIT_RESET_ALARM_NAME, { when: resetAlarmTimeMs });
      console.log(`[Claude Limits Auto-Reset] Scheduled silent trigger alarm '${LIMIT_RESET_ALARM_NAME}' for: ${new Date(resetAlarmTimeMs).toISOString()}`);
    } else {
      console.log('[Claude Limits Auto-Reset] Silent trigger skipped. Already executed for this window.');
    }

    // 2. Pause the 30-minute periodic polling and reschedule it to run exactly 2 minutes after reset
    // (This acts as a one-shot alarm. Once it fires, it will query limits and automatically resume periodic polling)
    const nextPollTimeMs = resetsAtMs + (2 * 60 * 1000);
    await chrome.alarms.clear(POLLING_ALARM_NAME);
    chrome.alarms.create(POLLING_ALARM_NAME, { when: nextPollTimeMs });
    
    console.log(`[Claude Limits Auto-Reset] Smart Sync: Paused 30-min polling. Next poll scheduled for: ${new Date(nextPollTimeMs).toISOString()}`);
    return { status: 'scheduled_future_reset', resetsAt, nextPollTimeMs };
  }

  // Case B: The user is NOT rate-limited (Active or Reset occurred)
  console.log('[Claude Limits Auto-Reset] Smart Sync: User is active. Ensuring periodic monitoring is active.');

  // 1. If the reset timestamp is in the past and we haven't executed it yet, trigger it immediately
  const isPastReset = resetsAtMs <= now;
  if (isPastReset && storage.lastResetExecuted !== resetsAt) {
    console.log('[Claude Limits Auto-Reset] Past reset detected. Triggering immediate execution to start fresh window.');
    triggerSilentMessage(organizationId, resetsAt);
  }

  // 2. Ensure recurring polling (every 30 minutes) is running to detect when the user next hits the limit
  const activePollAlarm = await chrome.alarms.get(POLLING_ALARM_NAME);
  if (!activePollAlarm || !activePollAlarm.periodInMinutes) {
    await chrome.alarms.clear(POLLING_ALARM_NAME);
    chrome.alarms.create(POLLING_ALARM_NAME, { periodInMinutes: 30 });
    console.log('[Claude Limits Auto-Reset] Smart Sync: Resumed 30-minute periodic polling.');
  }

  return { status: 'resumed_periodic_polling', resetsAt };
}

/**
 * Listen for the alarm triggers
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === LIMIT_RESET_ALARM_NAME) {
    console.log(`[Claude Limits Auto-Reset] Limit reset alarm '${alarm.name}' triggered.`);
    
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
  } else if (alarm.name === POLLING_ALARM_NAME) {
    console.log(`[Claude Limits Auto-Reset] Polling alarm '${alarm.name}' triggered. Running checks...`);
    pollClaudeLimits().catch(err => {
      console.debug('[Claude Limits Auto-Reset] Background poll execution failed:', err.message);
    });
  }
});

/**
 * Polls Claude's internal APIs in the background to retrieve current limits and schedule alarms.
 * Runs headlessly without needing any tabs open by utilizing browser cookies.
 */
async function pollClaudeLimits() {
  console.log('[Claude Limits Auto-Reset] Polling Claude limits...');
  try {
    // Step 1: Retrieve organizations list (also verifies active session)
    const orgsUrl = 'https://claude.ai/api/organizations';
    const orgsResponse = await fetch(orgsUrl, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'accept': 'application/json'
      }
    });

    if (orgsResponse.status === 401 || orgsResponse.status === 403) {
      await chrome.storage.local.set({
        sessionStatus: 'logged_out',
        lastSyncTime: new Date().toISOString()
      });
      throw new Error('User is logged out / unauthorized on Claude.ai');
    }

    if (!orgsResponse.ok) {
      throw new Error(`Failed to fetch organizations. Status: ${orgsResponse.status}`);
    }

    const orgs = await orgsResponse.json();
    if (!Array.isArray(orgs) || orgs.length === 0 || !orgs[0].uuid) {
      throw new Error('No organizations found in user account');
    }

    const organizationId = orgs[0].uuid;

    // Step 2: Fetch usage limits for the active organization
    const usageUrl = `https://claude.ai/api/organizations/${organizationId}/usage`;
    const usageResponse = await fetch(usageUrl, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'accept': 'application/json'
      }
    });

    if (!usageResponse.ok) {
      throw new Error(`Failed to fetch usage limits. Status: ${usageResponse.status}`);
    }

    const usageData = await usageResponse.json();
    if (!usageData || !usageData.five_hour || !usageData.five_hour.resets_at) {
      throw new Error('Invalid usage API response structure');
    }

    const resetsAt = usageData.five_hour.resets_at;
    const utilization = usageData.five_hour.utilization || 0;
    console.log('[Claude Limits Auto-Reset] Headless polling successfully retrieved resets_at:', resetsAt, 'utilization:', utilization);

    // Save sync details and schedule reset alarm
    const result = await handleUsageLimitsIntercepted(organizationId, resetsAt, utilization);
    
    await chrome.storage.local.set({
      sessionStatus: 'active',
      lastSyncTime: new Date().toISOString(),
      lastSyncError: null
    });

    return { organizationId, resetsAt, alarmResult: result };

  } catch (error) {
    console.error('[Claude Limits Auto-Reset] Headless polling error:', error.message);
    
    await chrome.storage.local.set({
      lastSyncTime: new Date().toISOString(),
      lastSyncError: error.message
    });
    
    if (error.message.includes('logged out') || error.message.includes('unauthorized') || error.message.includes('401') || error.message.includes('403')) {
      await chrome.storage.local.set({ sessionStatus: 'logged_out' });
    }
    
    throw error;
  }
}

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

    // Notify user of successful window refresh
    showNotification(
      'Claude Limits Auto-Reset',
      'Silent message sent successfully! Started a new 5-hour usage window.'
    );

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

    // Notify user of execution failure
    showNotification(
      'Claude Limits Auto-Reset Error',
      `Failed to execute auto-reset trigger: ${error.message}`
    );
  }
}

/**
 * Helper to display native Chrome desktop notifications.
 */
function showNotification(title, message) {
  chrome.notifications.create(crypto.randomUUID(), {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: title,
    message: message,
    priority: 2
  });
}
