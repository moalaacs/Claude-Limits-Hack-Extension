/**
 * content-main.js
 * Runs in the MAIN world context of the page.
 * It overrides window.fetch to capture responses targeting Claude's usage API.
 */
(() => {
  // Store reference to the original fetch function
  const originalFetch = window.fetch;

  // Override fetch
  window.fetch = async function (...args) {
    const resource = args[0];
    const options = args[1];

    let url = '';
    if (typeof resource === 'string') {
      url = resource;
    } else if (resource instanceof URL) {
      url = resource.href;
    } else if (resource && typeof resource === 'object' && resource.url) {
      url = resource.url;
    }

    // Check if the URL matches the organization usage endpoint:
    // https://claude.ai/api/organizations/{org_id}/usage
    const usageUrlRegex = /\/api\/organizations\/([a-f0-9-]+)\/usage/i;
    const match = url.match(usageUrlRegex);

    if (match) {
      const organizationId = match[1];

      try {
        // Execute the original fetch request
        const response = await originalFetch.apply(this, args);

        // Clone the response so the page's original caller can still read the stream
        const clonedResponse = response.clone();

        // Process the response asynchronously so we don't block the actual page render
        clonedResponse.json().then(data => {
          if (data && data.five_hour && data.five_hour.resets_at) {
            const resetsAt = data.five_hour.resets_at;

            // Dispatch a custom event to communicate with the isolated content script
            const event = new CustomEvent('ClaudeUsageIntercepted', {
              detail: {
                organizationId,
                resetsAt
              }
            });
            window.dispatchEvent(event);
          }
        }).catch(err => {
          // Fail silently to not impact the user experience
          console.debug('[Claude Limits Auto-Reset] Failed to parse usage JSON:', err);
        });

        return response;
      } catch (err) {
        // If the request fails, return the error natively
        throw err;
      }
    }

    // Default: call the original fetch
    return originalFetch.apply(this, args);
  };

  console.log('[Claude Limits Auto-Reset] main-world fetch interceptor injected successfully.');
})();
