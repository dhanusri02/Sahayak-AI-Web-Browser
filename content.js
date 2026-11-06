/**
 * Sahayak - Content Script (content.js)
 * Injected into every page at document_idle.
 * Listens for messages from the side panel and returns page content / selected text.
 */

(function () {
  'use strict';

  /**
   * Extract clean page text, capped at 12,000 chars (head + tail preserved).
   * Strips script/style content automatically via innerText.
   */
  function getPageText() {
    try {
      const raw = (document.body && document.body.innerText) ? document.body.innerText : '';
      const cleaned = raw.replace(/\s{3,}/g, '\n\n').trim();
      const MAX = 12000;
      if (cleaned.length <= MAX) return cleaned;
      // Preserve head (8000) + tail (4000) with separator
      return cleaned.slice(0, 8000) + '\n\n[...content truncated...]\n\n' + cleaned.slice(-4000);
    } catch (e) {
      return '';
    }
  }

  /**
   * Get text currently selected by the user, trimmed.
   */
  function getSelectedText() {
    try {
      return (window.getSelection() || '').toString().trim();
    } catch (e) {
      return '';
    }
  }

  // Listen for messages from the side panel
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.command === 'page/getContent') {
      const pageText    = getPageText();
      const selectedText = getSelectedText();

      sendResponse({
        title:        document.title || '',
        url:          window.location.href || '',
        text:         pageText,
        selectedText: selectedText
      });

      return true; // keep message channel open for async sendResponse
    }
  });
})();
// --- Slice 10: Scanner - Button ku number poduradhu ---
function sahayakScan() {
  // Pazhaya number ah delete pannu
  document.querySelectorAll('.sahayak-badge').forEach(e => e.remove());
  const els = document.querySelectorAll('button, a, input, select, textarea, [role="button"]');
  const map = [];
  let n = 1;
  els.forEach(el => {
    if (!el.offsetParent) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const badge = document.createElement('div');
    badge.className = 'sahayak-badge';
    badge.textContent = n;
    badge.style.cssText = 'position:fixed;z-index:99999;background:red;color:white;padding:2px 6px;border-radius:50%;font-size:12px;font-weight:bold;';
    badge.style.left = rect.left + 'px';
    badge.style.top = rect.top + 'px';
    document.body.appendChild(badge);
    map.push({ num: n, tag: el.tagName, text: (el.innerText || el.value || '').slice(0,40) });
    n++;
  });
  console.log('Sahayak Map:', map);
  return map;
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SCAN') sahayakScan();
});
// SAHAYAK EXECUTOR - sidepanel la irundhu varra step ah execute pannu
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'SAHAYAK_EXECUTE_STEP') return;
  (async () => {
    try {
      const step = msg.step || {};
      const desc = (step.description || '').toLowerCase();
      const type = (step.actionType || '').toLowerCase();
      await new Promise(r => setTimeout(r, 800));

      if (type.includes('click') || desc.includes('click')) {
        const el = [...document.querySelectorAll('button, a, [role="button"]')].find(e => e.textContent.toLowerCase().includes(desc.replace('click','').trim().slice(0,20)) || e.offsetParent !== null);
        if (el) el.click();
      } else if (type.includes('type') || type.includes('input') || desc.includes('type')) {
        const input = document.querySelector('input:not([type="hidden"]), textarea, [contenteditable="true"]');
        if (input) { input.focus(); document.execCommand('selectAll', false, null); document.execCommand('insertText', false, step.description); input.dispatchEvent(new Event('input', { bubbles: true })); }
      } else if (type.includes('scroll') || desc.includes('scroll')) {
        window.scrollBy(0, 600);
      } else if (type.includes('navigate') || desc.includes('open') || desc.includes('go to')) {
        const link = [...document.querySelectorAll('a')].find(a => desc.includes(a.textContent.toLowerCase().slice(0,20)));
        if (link) link.click();
      }
      // extract / read / wait ellam success nu treat pannu
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});
// 2. Approve aana dhan click aagum
function doAction(action) {
  const el = document.querySelector(`[data-sahayak-id="${action.target}"]`);
  if(!el) return "Element not found";

  if(action.type === "dry-run") {
    el.style.outline = "3px solid yellow";
    return "Highlighted only - not clicked";
  }
  if(action.type === "click") el.click();
  if(action.type === "type") { el.focus(); el.value = action.value; el.dispatchEvent(new Event('input',{bubbles:true})); }
  if(action.type === "select") el.value = action.value;
  return "Done: " + action.type;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if(msg.cmd === "DO_ACTION") {
    sendResponse({ result: doAction(msg.action) });
  }
});
