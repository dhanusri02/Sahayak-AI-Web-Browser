/**
 * Sahayak - Background Service Worker (Manifest V3)
 * Handles side-panel behavior, active tab tracking, and IPC messaging.
 */

// 1. Configure side panel to open on toolbar action icon click
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
      console.warn('[Sahayak SW] setPanelBehavior error:', err);
    });
  }
  console.log('[Sahayak SW] Sahayak extension installed successfully.');
});

// Fallback action click handler in case setPanelBehavior is unsupported
chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel && chrome.sidePanel.open && tab.windowId) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (err) {
      console.warn('[Sahayak SW] chrome.sidePanel.open error:', err);
    }
  }
});

// 2. Track active tab changes and broadcast to side panel
async function broadcastActiveTab() {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      chrome.runtime.sendMessage({
        type: 'tab/updated',
        tab: {
          id: activeTab.id,
          title: activeTab.title || 'Untitled Page',
          url: activeTab.url || ''
        }
      }).catch(() => {
        // Ignored if side panel is not open or not listening
      });
    }
  } catch (err) {
    console.debug('[Sahayak SW] broadcastActiveTab error:', err);
  }
}

chrome.tabs.onActivated.addListener(broadcastActiveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) {
    broadcastActiveTab();
  }
});

// 3. IPC Message Router
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.command === 'tab/getActive') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) {
        sendResponse({
          ok: true,
          data: {
            id: tab.id,
            title: tab.title || 'Untitled Page',
            url: tab.url || ''
          }
        });
      } else {
        sendResponse({ ok: false, error: { code: 'no_active_tab', message: 'No active tab found' } });
      }
    }).catch((err) => {
      sendResponse({ ok: false, error: { code: 'query_failed', message: err.message } });
    });
    return true; // Keep message channel open for async response
  }

  if (request.command === 'panel/ready') {
    console.log('[Sahayak SW] Side panel reported ready.');
    sendResponse({ ok: true });
    return false;
  }
});

