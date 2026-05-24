/**
 * content-isolated.js
 * Runs in the ISOLATED world context.
 * Listens for the custom DOM event dispatched by content-main.js and sends
 * the payload to the background service worker using chrome.runtime.sendMessage.
 */

window.addEventListener('ClaudeUsageIntercepted', (event) => {
  if (event.detail && event.detail.organizationId && event.detail.resetsAt) {
    const { organizationId, resetsAt, utilization } = event.detail;

    console.log('[Claude Limits Auto-Reset] Intercepted usage update:', {
      organizationId,
      resetsAt,
      utilization
    });

    // Send the message to the background service worker
    chrome.runtime.sendMessage({
      type: 'CLAUDE_USAGE_INTERCEPTED',
      organizationId,
      resetsAt,
      utilization
    }, (response) => {
      // Handle response or error if background script is not loaded
      if (chrome.runtime.lastError) {
        console.warn('[Claude Limits Auto-Reset] Failed to send message to background worker:', chrome.runtime.lastError.message);
      } else {
        console.log('[Claude Limits Auto-Reset] Relayed usage details to background worker:', response);
      }
    });
  }
});

console.log('[Claude Limits Auto-Reset] isolated-world message relay active.');
