/**
 * popup.js
 * Controls the popup user interface, loading configuration from chrome.storage
 * and showing current alarm status and execution logs.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const radioNew = document.getElementById('radio-new');
  const radioSpecific = document.getElementById('radio-specific');
  const cardNew = document.getElementById('card-new');
  const cardSpecific = document.getElementById('card-specific');
  const uuidContainer = document.getElementById('uuid-container');
  const specificUuidInput = document.getElementById('specific-uuid');
  
  const labelNextAlarm = document.getElementById('next-alarm');
  const labelLastStatus = document.getElementById('last-status');
  const labelTargetDetails = document.getElementById('target-details');
  const toast = document.getElementById('toast');

  let toastTimeout = null;

  // 1. Load configuration and state
  const config = await chrome.storage.local.get([
    'chatMode', 
    'specificChatUuid', 
    'lastExecutionStatus'
  ]);

  // Set default values if not defined
  const mode = config.chatMode || 'new';
  const specificUuid = config.specificChatUuid || '';
  
  if (mode === 'specific') {
    radioSpecific.checked = true;
    cardSpecific.classList.add('active');
    cardNew.classList.remove('active');
    uuidContainer.classList.add('visible');
  } else {
    radioNew.checked = true;
    cardNew.classList.add('active');
    cardSpecific.classList.remove('active');
    uuidContainer.classList.remove('visible');
  }

  specificUuidInput.value = specificUuid;

  // 2. Render dynamic status details
  updateStatusDisplay(config.lastExecutionStatus, mode, specificUuid);
  renderNextAlarm();

  // 3. Set up event listeners for inputs
  radioNew.addEventListener('change', () => handleModeChange('new'));
  radioSpecific.addEventListener('change', () => handleModeChange('specific'));
  
  // Save specific UUID on typing
  let debounceTimeout = null;
  specificUuidInput.addEventListener('input', () => {
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
      saveSettings();
    }, 400); // Debounce to avoid writing to storage on every keystroke
  });

  // Handle card click convenience mapping
  cardNew.addEventListener('click', (e) => {
    if (e.target !== radioNew) {
      radioNew.checked = true;
      handleModeChange('new');
    }
  });

  cardSpecific.addEventListener('click', (e) => {
    if (e.target !== radioSpecific && e.target !== specificUuidInput) {
      radioSpecific.checked = true;
      handleModeChange('specific');
    }
  });

  /**
   * Handle switching between modes (New vs Specific chat)
   */
  function handleModeChange(newMode) {
    if (newMode === 'specific') {
      cardSpecific.classList.add('active');
      cardNew.classList.remove('active');
      uuidContainer.classList.add('visible');
      specificUuidInput.focus();
    } else {
      cardNew.classList.add('active');
      cardSpecific.classList.remove('active');
      uuidContainer.classList.remove('visible');
    }
    saveSettings();
  }

  /**
   * Write settings to chrome.storage.local and show toast indicator
   */
  async function saveSettings() {
    const chatMode = radioSpecific.checked ? 'specific' : 'new';
    const specificChatUuid = specificUuidInput.value.trim();

    await chrome.storage.local.set({
      chatMode,
      specificChatUuid
    });

    updateStatusDisplay(
      (await chrome.storage.local.get('lastExecutionStatus')).lastExecutionStatus,
      chatMode,
      specificChatUuid
    );

    showToast('Settings saved');
  }

  /**
   * Render details about the last executed run
   */
  function updateStatusDisplay(lastStatus, mode, specificUuid) {
    // Render target text
    if (mode === 'specific') {
      labelTargetDetails.textContent = specificUuid ? specificUuid.substring(0, 18) + '...' : 'Invalid/Empty UUID';
    } else {
      labelTargetDetails.textContent = 'New Chat (Auto-Created)';
    }

    // Render execution success/fail details
    if (lastStatus) {
      const timeStr = lastStatus.timestamp ? new Date(lastStatus.timestamp).toLocaleTimeString() : '';
      if (lastStatus.success) {
        labelLastStatus.className = 'status-value success';
        labelLastStatus.textContent = `Success (${timeStr})`;
      } else {
        labelLastStatus.className = 'status-value failed';
        labelLastStatus.textContent = `Failed: ${lastStatus.error ? lastStatus.error.substring(0, 20) + '...' : 'Unknown'}`;
      }
    } else {
      labelLastStatus.textContent = 'Never Triggered';
      labelLastStatus.className = 'status-value';
    }
  }

  /**
   * Query alarms list and display when the limit reset alarm is scheduled to fire
   */
  async function renderNextAlarm() {
    const alarms = await chrome.alarms.getAll();
    const resetAlarm = alarms.find(a => a.name === 'ClaudeLimitResetAlarm');

    if (resetAlarm) {
      const diffMs = resetAlarm.scheduledTime - Date.now();
      if (diffMs > 0) {
        const diffMinutes = Math.ceil(diffMs / 60000);
        labelNextAlarm.textContent = `in ~${diffMinutes} min (${new Date(resetAlarm.scheduledTime).toLocaleTimeString()})`;
        return;
      }
    }
    labelNextAlarm.textContent = 'None Scheduled';
  }

  /**
   * Show a dynamic glass-style notification toast
   */
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
    }, 2000);
  }
});
