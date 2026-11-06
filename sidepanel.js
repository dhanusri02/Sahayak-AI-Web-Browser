/**
 * Sahayak - Side Panel Application Logic v1.1.0
 *
 * Features:
 *   - Language Toggle (English / Hinglish) — saved to chrome.storage.local
 *   - Quick Actions: Explain, Translate, Draft Reply, Summarize (selected text or page)
 *   - Page Chat: grounded Q&A from current page content only
 *   - Settings: Gemini + Groq API key management
 *   - Safety URL guard (banking/login/payment pages)
 *   - Activity Log
 *   - Real Gemini Task Planner (Slice 2)
 */

'use strict';

// --- Pure Safety Policy (Architecture §8) ---
const SENSITIVE_URL_PATTERNS = [
  /bank/i,
  /paytm/i,
  /phonepe/i,
  /gpay/i,
  /upi/i,
  /razorpay/i,
  /stripe\.com\/checkout/i,
  /paypal/i,
  /incometax/i,
  /uidai/i,
  /login/i,
  /signin/i,
  /signup/i,
  /auth0/i,
  /accounts\.google/i
];

function classifyUrl(url) {
  if (!url) return 'normal';
  for (const pattern of SENSITIVE_URL_PATTERNS) {
    if (pattern.test(url)) return 'sensitive_page';
  }
  return 'normal';
}

// --- Application State ---
const state = {
  activeTab:   null,
  isSensitive: false,
  apiKey:      '',
  groqKey:     '',
  language:    'en',  // 'en' | 'hinglish'
  isRunning:   false,
  currentPlan: null
};

// --- Chat State (per-page session) ---
let chatHistory = []; // Array of { role: 'user'|'assistant', content: string }

// --- DOM References ---
// --- Safety Check ---
function isBankingSite(url){
  const bad = ["bank", "netbanking", "paytm", "phonepe", "gpay", "upi", "payment", "checkout", "razorpay"];
  return bad.some(w => (url||"").toLowerCase().includes(w));
}
async function checkSafety(){
  const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
  if(tab && isBankingSite(tab.url)){
    return confirm("⚠️ Idhu banking/payment site maari theriyudhu. Continue pannalama? Submit panna matten.");
  }
  return true;
}

const el = {
  // Nav & Views
  tabBtnTask:         document.getElementById('tab-btn-task'),
  tabBtnChat:         document.getElementById('tab-btn-chat'),
  tabBtnSettings:     document.getElementById('tab-btn-settings'),
  viewTask:           document.getElementById('view-task'),
  viewChat:           document.getElementById('view-chat'),
  viewSettings:       document.getElementById('view-settings'),

  // Alerts
  bannerMissingKey:   document.getElementById('banner-missing-key'),
  bannerSensitivePage:document.getElementById('banner-sensitive-page'),
  linkOpenSettings:   document.getElementById('link-open-settings'),

  // Header & Status
  tabTitleDisplay:    document.getElementById('tab-title-display'),
  tabStatusDot:       document.getElementById('tab-status-dot'),
  btnLangEn:          document.getElementById('btn-lang-en'),
  btnLangHinglish:    document.getElementById('btn-lang-hinglish'),
  btnEmergencyStop:   document.getElementById('btn-emergency-stop'),
  footerStatus:       document.getElementById('footer-status'),

  // Task View
  inputTask:          document.getElementById('input-task'),
  btnStart:           document.getElementById('btn-start'),
  btnStop:            document.getElementById('btn-stop'),
  progressStatusLabel:document.getElementById('progress-status-label'),
  stepIndicator:      document.getElementById('step-indicator'),
  progressBarFill:    document.getElementById('progress-bar-fill'),
  statusLog:          document.getElementById('status-log'),
  btnClearLog:        document.getElementById('btn-clear-log'),

  // Quick Actions
  quickActionResult:  document.getElementById('quick-action-result'),

  // Plan Card
  planCard:           document.getElementById('plan-card'),
  planTitleDisplay:   document.getElementById('plan-title-display'),
  planStepCount:      document.getElementById('plan-step-count'),
  planStepsList:      document.getElementById('plan-steps-list'),

  // Chat View
  chatThread:         document.getElementById('chat-thread'),
  chatInput:          document.getElementById('chat-input'),
  btnChatSend:        document.getElementById('btn-chat-send'),
  btnChatClear:       document.getElementById('btn-chat-clear'),

  // Settings View
  inputGeminiKey:     document.getElementById('input-gemini-key'),
  inputGroqKey:       document.getElementById('input-groq-key'),
  geminiStatusTag:    document.getElementById('gemini-status-tag'),
  btnSaveSettings:    document.getElementById('btn-save-settings'),
  btnClearSettings:   document.getElementById('btn-clear-settings'),
  settingsSaveFeedback:document.getElementById('settings-save-feedback')
};

// =============================================================
//  HELPERS
// =============================================================

/** Activity Log writer */
function logActivity(message, type = 'normal') {
  if (!el.statusLog) return;
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const now = new Date();
  const timeStr = `[${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}]`;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = timeStr;

  const msgSpan = document.createElement('span');
  msgSpan.className = `log-msg ${type}`;
  msgSpan.textContent = message;

  entry.appendChild(timeSpan);
  entry.appendChild(msgSpan);
  el.statusLog.appendChild(entry);
  el.statusLog.scrollTop = el.statusLog.scrollHeight;
}

/**
 * Build a STRONG language instruction injected at the top of EVERY Gemini system prompt.
 * Also returns a userPrefix to prepend to user message text for dual-injection.
 * Reads LIVE from chrome.storage.local so toggle changes take effect immediately.
 */
async function getLangInstruction() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['language'], (res) => {
      const lang = res.language || 'en';
      // Keep state in sync while we're here
      state.language = lang;
      updateLangToggleUI();

      if (lang === 'hinglish') {
        resolve({
          lang,
          systemPrefix:
            `LANGUAGE INSTRUCTION (MANDATORY — highest priority, override everything else):\n` +
            `You MUST reply ONLY in Hinglish. Hinglish = Hindi words written in English/Latin letters, naturally mixed with English technical terms.\n` +
            `Example of correct Hinglish: "Is page ka summary ye hai: yahan product ki details di gayi hain aur aap apna order track kar sakte ho."\n` +
            `NEVER reply in pure English. NEVER use Devanagari script. NEVER use Tamil.\n` +
            `Every single sentence of your reply must follow the Hinglish format above.\n`,
          userPrefix: `[REPLY IN HINGLISH ONLY — Hindi words in English letters] `,
          notFoundReply: 'Is sawaal ka jawab is page pe nahi hai.'
        });
      } else {
        resolve({
          lang,
          systemPrefix:
            `LANGUAGE INSTRUCTION (MANDATORY — highest priority):\n` +
            `You MUST reply ONLY in clear, simple English.\n`,
          userPrefix: `[REPLY IN ENGLISH ONLY] `,
          notFoundReply: 'This is not available in the current page.'
        });
      }
    });
  });
}

// Keep the synchronous helper for legacy/init use (uses cached state.language)
function buildLangInstruction(language) {
  if (language === 'hinglish') {
    return (
      `LANGUAGE INSTRUCTION (MANDATORY — highest priority, override everything else):\n` +
      `You MUST reply ONLY in Hinglish. Hinglish = Hindi words written in English/Latin letters, naturally mixed with English technical terms.\n` +
      `Example of correct Hinglish: "Is page ka summary ye hai: yahan product ki details di gayi hain."\n` +
      `NEVER reply in pure English. NEVER use Devanagari script. NEVER use Tamil.\n`
    );
  }
  return `LANGUAGE INSTRUCTION (MANDATORY):\nYou MUST reply ONLY in clear, simple English.\n`;
}

/** Progress bar updater */
function setProgress(step, max, label) {
  const pct = max > 0 ? Math.min(100, Math.round((step / max) * 100)) : 0;
  el.progressBarFill.style.width = `${pct}%`;
  el.stepIndicator.textContent   = max > 0 ? `Step ${step} / ${max}` : 'Idle';
  el.progressStatusLabel.textContent = label;
}

/** Get content from active page via content script */
function getPageContent() {
  return new Promise((resolve) => {
    if (!state.activeTab || !state.activeTab.id) {
      resolve({ title: '', url: '', text: '', selectedText: '' });
      return;
    }
    try {
      chrome.tabs.sendMessage(
        state.activeTab.id,
        { command: 'page/getContent' },
        (response) => {
          if (chrome.runtime.lastError || !response) {
            // Content script may not be injected yet (e.g. chrome:// pages)
            resolve({ title: '', url: state.activeTab.url || '', text: '', selectedText: '' });
            return;
          }
          resolve(response);
        }
      );
    } catch (e) {
      resolve({ title: '', url: '', text: '', selectedText: '' });
    }
  });
}

// =============================================================
//  NAVIGATION / TAB SWITCHING
// =============================================================
function switchView(targetViewId) {
  // Hide all sections
  el.viewTask.style.display    = 'none';
  el.viewChat.style.display    = 'none';
  el.viewSettings.style.display = 'none';

  // Remove active from all tabs
  el.tabBtnTask.classList.remove('active');
  el.tabBtnChat.classList.remove('active');
  el.tabBtnSettings.classList.remove('active');

  if (targetViewId === 'view-task') {
    el.viewTask.style.display = 'flex';
    el.tabBtnTask.classList.add('active');
  } else if (targetViewId === 'view-chat') {
    el.viewChat.style.display = 'flex';
    el.tabBtnChat.classList.add('active');
  } else {
    el.viewSettings.style.display = 'flex';
    el.tabBtnSettings.classList.add('active');
  }
}

el.tabBtnTask.addEventListener('click',     () => switchView('view-task'));
el.tabBtnChat.addEventListener('click',     () => switchView('view-chat'));
el.tabBtnSettings.addEventListener('click', () => switchView('view-settings'));
el.linkOpenSettings.addEventListener('click',() => switchView('view-settings'));

// =============================================================
//  SETTINGS MANAGEMENT
// =============================================================
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['geminiApiKey', 'groqApiKey', 'language'], (result) => {
      state.apiKey  = (result.geminiApiKey || '').trim();
      state.groqKey = (result.groqApiKey   || '').trim();
      state.language = result.language || 'en';

      if (el.inputGeminiKey) el.inputGeminiKey.value = state.apiKey;
      if (el.inputGroqKey)   el.inputGroqKey.value   = state.groqKey;

      // Sync language toggle buttons
      updateLangToggleUI();
      updateKeyStatusUI();
      resolve();
    });
  });
}

function updateKeyStatusUI() {
  if (state.apiKey && state.apiKey.length > 0) {
    el.geminiStatusTag.textContent = 'Configured';
    el.geminiStatusTag.className   = 'status-tag configured';
    el.bannerMissingKey.style.display = 'none';
  } else {
    el.geminiStatusTag.textContent = 'Not Configured';
    el.geminiStatusTag.className   = 'status-tag missing';
    el.bannerMissingKey.style.display = 'flex';
  }
}

el.btnSaveSettings.addEventListener('click', () => {
  const geminiKey = el.inputGeminiKey.value.trim();
  const groqKey   = el.inputGroqKey.value.trim();

  chrome.storage.local.set({ geminiApiKey: geminiKey, groqApiKey: groqKey }, () => {
    state.apiKey  = geminiKey;
    state.groqKey = groqKey;
    updateKeyStatusUI();

    el.settingsSaveFeedback.style.display = 'block';
    setTimeout(() => { el.settingsSaveFeedback.style.display = 'none'; }, 2500);

    logActivity('Settings saved successfully in chrome.storage.local.', 'highlight');
  });
});

el.btnClearSettings.addEventListener('click', () => {
  chrome.storage.local.remove(['geminiApiKey', 'groqApiKey'], () => {
    state.apiKey  = '';
    state.groqKey = '';
    el.inputGeminiKey.value = '';
    el.inputGroqKey.value   = '';
    updateKeyStatusUI();
    logActivity('API keys cleared from storage.', 'warn');
  });
});

// =============================================================
//  LANGUAGE TOGGLE
// =============================================================
function updateLangToggleUI() {
  if (state.language === 'hinglish') {
    el.btnLangEn.classList.remove('active');
    el.btnLangHinglish.classList.add('active');
  } else {
    el.btnLangEn.classList.add('active');
    el.btnLangHinglish.classList.remove('active');
  }
}

function setLanguage(lang) {
  state.language = lang;
  updateLangToggleUI();
  chrome.storage.local.set({ language: lang }, () => {
    logActivity(`Output language set to: ${lang === 'hinglish' ? 'Hinglish' : 'English'}.`);
  });
}

el.btnLangEn.addEventListener('click',       () => setLanguage('en'));
el.btnLangHinglish.addEventListener('click', () => setLanguage('hinglish'));

// =============================================================
//  ACTIVE TAB SYNC & SAFETY EVALUATION
// =============================================================
async function refreshActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      el.tabTitleDisplay.textContent = 'No active tab';
      return;
    }

    state.activeTab = tab;
    el.tabTitleDisplay.textContent = tab.title || tab.url || 'Untitled';
    el.tabTitleDisplay.title = `${tab.title}\n(${tab.url})`;

    const classification = classifyUrl(tab.url);
    if (classification === 'sensitive_page') {
      state.isSensitive = true;
      el.bannerSensitivePage.style.display = 'flex';
      el.tabStatusDot.style.backgroundColor = 'var(--warning)';
      el.btnStart.disabled = true;
      logActivity(`Sensitive page detected (${new URL(tab.url).hostname || 'unknown'}). Actions paused.`, 'warn');
    } else {
      state.isSensitive = false;
      el.bannerSensitivePage.style.display = 'none';
      el.tabStatusDot.style.backgroundColor = 'var(--success)';
      if (!state.isRunning) el.btnStart.disabled = false;
    }
  } catch (err) {
    console.debug('[Sahayak Panel] refreshActiveTab error:', err);
  }
}

// Listen for broadcast from background worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'tab/updated') {
    refreshActiveTab();
    // Reset chat session when tab changes (new page = new context)
    clearChatSession();
  }
});

// =============================================================
//  PLAN RENDERING (Task tab)
// =============================================================
function renderPlan(plan) {
  if (!el.planCard) return;

  el.planCard.style.display = 'flex';
  el.planTitleDisplay.textContent = plan.planTitle || 'Task Execution Plan';
  el.planStepCount.textContent    = `${plan.steps.length} Steps`;
  el.planStepsList.innerHTML = '';

  plan.steps.forEach((step) => {
    const item = document.createElement('div');
    item.className = 'step-item done';
    item.id = `step-item-${step.stepNumber}`;

    const num = document.createElement('div');
    num.className = 'step-num';
    num.textContent = step.stepNumber;

    const content = document.createElement('div');
    content.className = 'step-content';

    const desc = document.createElement('div');
    desc.className = 'step-desc';
    desc.textContent = step.description;

    const meta = document.createElement('div');
    meta.className = 'step-meta';

    const tag = document.createElement('span');
    tag.className = 'step-tag';
    tag.textContent = step.actionType || 'step';

    meta.appendChild(tag);
    content.appendChild(desc);
    content.appendChild(meta);

    const statusIcon = document.createElement('div');
    statusIcon.className = 'step-status-icon';
    statusIcon.textContent = '✓';

    item.appendChild(num);
    item.appendChild(content);
    item.appendChild(statusIcon);

    el.planStepsList.appendChild(item);
  });
}

// =============================================================
//  REAL GEMINI TASK PLANNER FLOW (Start button)
// =============================================================
async function startTask() {
  // 1. Fetch latest credentials from chrome.storage.local
  const { apiKey } = await window.SahayakAI.getStoredCredentials();
  state.apiKey = apiKey;

  if (!apiKey) {
    switchView('view-settings');
    el.bannerMissingKey.style.display = 'flex';
    logActivity('Setup Required: Please enter your Gemini API key in Settings.', 'err');
    if (el.inputGeminiKey) el.inputGeminiKey.focus();
    return;
  }

  if (state.isSensitive) {
    logActivity('Cannot start task: Active page is classified as sensitive.', 'err');
    return;
  }

  const instruction = el.inputTask.value.trim();
  if (!instruction) {
    logActivity('Please enter an instruction or question first.', 'warn');
    el.inputTask.focus();
    return;
  }

  // Update UI to running state
  state.isRunning = true;
  el.btnStart.disabled = true;
  el.btnStop.disabled  = false;
  el.footerStatus.textContent = 'Calling Gemini...';
  el.footerStatus.style.color = 'var(--primary)';

  logActivity(`Task started: "${instruction}"`, 'highlight');
  logActivity('Calling Gemini...', 'highlight');
  setProgress(0, 0, 'Calling Gemini...');

  try {
    const plan = await window.SahayakAI.planTaskWithGemini(
      instruction,
      state.activeTab || {},
      state.language,
      (fallbackMsg) => {
        logActivity(fallbackMsg, 'warn');
        setProgress(0, 0, fallbackMsg);
        el.footerStatus.textContent = fallbackMsg;
      }
    );

    state.currentPlan = plan;
    const totalSteps  = plan.steps.length;

    logActivity(`Gemini returned ${totalSteps} steps: "${plan.planTitle}"`, 'highlight');
    renderPlan(plan);
    // EXECUTOR - Steps ah onnu onna execute pannu
for (const step of plan.steps) {
  if (!state.isRunning) break;
  logActivity(`Step ${step.stepNumber}: ${step.description}`);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'SAHAYAK_EXECUTE_STEP',
      step: step
    });
    if (result && result.ok) {
      logActivity(`Step ${step.stepNumber} done`);
    } else {
      logActivity(`Step ${step.stepNumber} failed: ${result?.error || 'unknown'}`);
      break;
    }
  } catch (err) {
    logActivity(`Step ${step.stepNumber} error: ${err.message}`);
    break;
  }
}
logActivity(`Final Answer: ${plan.planTitle} - ${plan.steps.length} steps completed`);
setProgress(totalSteps, totalSteps, 'Done');

    state.isRunning     = false;
    el.btnStart.disabled = state.isSensitive;
    el.btnStop.disabled  = true;
    el.footerStatus.textContent = 'Ready';
    el.footerStatus.style.color = 'var(--text-muted)';

  } catch (err) {
    console.error('[Sahayak Panel] Gemini execution error:', err);
    state.isRunning     = false;
    el.btnStart.disabled = state.isSensitive;
    el.btnStop.disabled  = true;
    el.footerStatus.textContent = 'Error';
    el.footerStatus.style.color = 'var(--danger)';
    setProgress(0, 0, 'Failed');

    if (err.code === 'missing_key') {
      el.bannerMissingKey.style.display = 'flex';
      switchView('view-settings');
      logActivity('Setup Required: Please enter your Gemini API key in Settings.', 'err');
      if (el.inputGeminiKey) el.inputGeminiKey.focus();
    } else if (err.code === 'invalid_key') {
      logActivity('Error: Invalid or unauthorized Gemini API key. Please check your key in Settings.', 'err');
      el.geminiStatusTag.textContent = 'Invalid Key';
      el.geminiStatusTag.className   = 'status-tag missing';
    } else if (err.code === 'json_parse_error') {
      logActivity('AI returned invalid format. Please try running the prompt again.', 'err');
    } else {
      logActivity(`Model failure: ${err.message}`, 'err');
    }
  }
}

function stopTask(reason = 'Task stopped by user.') {
  state.isRunning     = false;
  el.btnStart.disabled = state.isSensitive;
  el.btnStop.disabled  = true;
  el.footerStatus.textContent = 'Ready';
  el.footerStatus.style.color = 'var(--text-muted)';
  setProgress(0, 0, 'Idle');
  logActivity(reason, 'warn');
}

el.btnStart.addEventListener('click', async () => {if(!(await checkSafety())) return;startTask();});
el.btnStop.addEventListener('click',           () => stopTask('Task stopped by user.'));
el.btnEmergencyStop.addEventListener('click',  () => stopTask('Task stopped by emergency kill-switch.'));
el.btnClearLog.addEventListener('click', () => {
  el.statusLog.innerHTML = '';
  logActivity('Log cleared.');
});

// =============================================================
//  QUICK ACTIONS (Explain / Translate / Draft Reply / Summarize)
// =============================================================
const QUICK_ACTION_PROMPTS = {
  explain:   (text) => `Explain the following text clearly and simply:\n\n${text}`,
  translate: (text) => `Translate the following text to Hindi (write Hindi words using English/Latin letters — Hinglish style):\n\n${text}`,
  draft:     (text) => `Draft a polite and professional reply to the following:\n\n${text}`,
  summarize: (text) => `Summarize the following in 3–5 bullet points:\n\n${text}`
};

const QUICK_ACTION_LABELS = {
  explain:   '✦ Explanation',
  translate: '🌐 Translation',
  draft:     '✉ Draft Reply',
  summarize: '📋 Summary'
};

async function runQuickAction(actionType) {
  // Check API key
  const { apiKey } = await window.SahayakAI.getStoredCredentials();
  if (!apiKey) {
    logActivity('Quick Action failed: No Gemini API key. Add one in Settings.', 'err');
    switchView('view-settings');
    return;
  }

  // Disable quick action buttons while running
  document.querySelectorAll('.qa-btn').forEach(b => { b.disabled = true; });

  // Show loading state in result card
  el.quickActionResult.style.display = 'block';
  el.quickActionResult.innerHTML =
    `<div class="result-card-label">${QUICK_ACTION_LABELS[actionType] || actionType}</div>` +
    `<span class="chat-typing">Thinking...</span>`;

  logActivity(`Quick Action: ${actionType} — getting page content...`);

  // Get page content
  const pageData = await getPageContent();
  const textToUse = pageData.selectedText || pageData.text || '';

  if (!textToUse) {
    el.quickActionResult.innerHTML =
      `<div class="result-card-label">${QUICK_ACTION_LABELS[actionType]}</div>` +
      `<span style="color:var(--warning);">No text found on this page. Try selecting some text first.</span>`;
    document.querySelectorAll('.qa-btn').forEach(b => { b.disabled = false; });
    return;
  }

  const sourceLabel = pageData.selectedText ? 'selected text' : 'page content';
  logActivity(`Running ${actionType} on ${sourceLabel} (${textToUse.length} chars)...`);

  // Read language LIVE from storage right before the API call
  const langInfo = await getLangInstruction();
  logActivity(`Language: ${langInfo.lang === 'hinglish' ? 'Hinglish' : 'English'}`);

  // Build user prompt with dual-injection: prefix in user message + system instruction
  const basePrompt = QUICK_ACTION_PROMPTS[actionType](textToUse.slice(0, 10000));
  const userPrompt = langInfo.userPrefix + basePrompt;

  const payload = {
    contents: [
      { parts: [{ text: userPrompt }] }
    ],
    systemInstruction: {
      parts: [{
        text: langInfo.systemPrefix +
          `\nYou are Sahayak, a helpful Chrome browser AI assistant.\n` +
          `Perform the requested action on the provided text. Follow the language instruction above strictly.`
      }]
    },
    generationConfig: {
      temperature: 0.3
    }
  };

  try {
    const result = await window.SahayakAI.callGemini(payload, (fallbackMsg) => {
      logActivity(fallbackMsg, 'warn');
    });

    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) throw new Error('Empty response from AI');

    el.quickActionResult.innerHTML =
      `<div class="result-card-label">${QUICK_ACTION_LABELS[actionType]}</div>` +
      escapeHtml(text);

    logActivity(`Quick Action "${actionType}" complete.`, 'highlight');

  } catch (err) {
    console.error('[Sahayak] Quick Action error:', err);
    el.quickActionResult.innerHTML =
      `<div class="result-card-label" style="color:var(--danger);">${QUICK_ACTION_LABELS[actionType]} — Failed</div>` +
      `<span style="color:var(--danger);">${escapeHtml(err.message)}</span>`;
    logActivity(`Quick Action failed: ${err.message}`, 'err');
  }

  document.querySelectorAll('.qa-btn').forEach(b => { b.disabled = false; });
}

// Event delegation for Quick Action buttons
document.querySelectorAll('.qa-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    if (action) runQuickAction(action);
  });
});

// =============================================================
//  PAGE CHAT
// =============================================================

/** Render a single chat bubble into the thread */
function appendChatMessage(role, content) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-msg ${role}`;

  const roleLabel = document.createElement('div');
  roleLabel.className = 'chat-msg-role';
  roleLabel.textContent = role === 'user' ? 'You' : 'Sahayak';

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.textContent = content; // safe — no innerHTML

  msgDiv.appendChild(roleLabel);
  msgDiv.appendChild(bubble);
  el.chatThread.appendChild(msgDiv);
  el.chatThread.scrollTop = el.chatThread.scrollHeight;
  return bubble;
}

/** Append a temporary "thinking" bubble, return reference to replace it */
function appendTypingIndicator() {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'chat-msg assistant';
  msgDiv.id = 'chat-typing-indicator';

  const roleLabel = document.createElement('div');
  roleLabel.className = 'chat-msg-role';
  roleLabel.textContent = 'Sahayak';

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.innerHTML = '<span class="chat-typing">Thinking...</span>';

  msgDiv.appendChild(roleLabel);
  msgDiv.appendChild(bubble);
  el.chatThread.appendChild(msgDiv);
  el.chatThread.scrollTop = el.chatThread.scrollHeight;
  return { container: msgDiv, bubble };
}

function clearChatSession() {
  chatHistory = [];
  if (el.chatThread) el.chatThread.innerHTML = '';
}

async function sendChatMessage() {
  const userInput = (el.chatInput.value || '').trim();
  if (!userInput) return;

  // Check API key
  const { apiKey } = await window.SahayakAI.getStoredCredentials();
  if (!apiKey) {
    appendChatMessage('assistant', 'Setup Required: Please add your Gemini API key in Settings first.');
    return;
  }

  el.chatInput.value = '';
  el.btnChatSend.disabled = true;

  // Show user message
  appendChatMessage('user', userInput);
  chatHistory.push({ role: 'user', content: userInput });

  // Show typing indicator
  const { container: typingContainer, bubble: typingBubble } = appendTypingIndicator();

  // Get page content
  const pageData = await getPageContent();
  const pageText = pageData.text || '';

  // Read language LIVE from storage right before the API call
  const langInfo = await getLangInstruction();
  const notFoundReply = langInfo.notFoundReply;

  // Build grounded system prompt — language instruction FIRST
  const systemPrompt =
    langInfo.systemPrefix +
    `\nYou are Sahayak, a helpful Chrome browser AI assistant.\n` +
    `STRICT RULE: Answer questions ONLY from the page content provided below.\n` +
    `If the answer to the user's question is NOT present in the page content, reply EXACTLY with this sentence and nothing else: "${notFoundReply}"\n` +
    `Do NOT use any external knowledge. Do NOT make up information.\n\n` +
    `Page Title: "${pageData.title || 'Unknown'}"\n` +
    `Page URL: "${pageData.url || 'Unknown'}"\n\n` +
    `Page Content:\n${pageText.slice(0, 11000) || '(No page content available)'}`;

  // Build conversation history (last 6 turns max), inject language prefix into latest user message
  const recentHistory = chatHistory.slice(-6);
  const contents = recentHistory.map((turn, idx) => {
    const isLastUserTurn = turn.role === 'user' && idx === recentHistory.length - 1;
    return {
      role:  turn.role === 'user' ? 'user' : 'model',
      parts: [{ text: isLastUserTurn ? (langInfo.userPrefix + turn.content) : turn.content }]
    };
  });

  const payload = {
    contents,
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    generationConfig: {
      temperature: 0.1  // Keep grounded, low creativity
    }
  };

  try {
    const result = await window.SahayakAI.callGemini(payload, (fallbackMsg) => {
      typingBubble.innerHTML = `<span class="chat-typing">${escapeHtml(fallbackMsg)}</span>`;
    });

    const aiText = result?.candidates?.[0]?.content?.parts?.[0]?.text || notFoundReply;

    // Replace typing indicator with real response
    typingContainer.remove();
    appendChatMessage('assistant', aiText);
    chatHistory.push({ role: 'assistant', content: aiText });

  } catch (err) {
    console.error('[Sahayak] Chat error:', err);
    typingContainer.remove();
    const errMsg = `Error: ${err.message}`;
    appendChatMessage('assistant', errMsg);
    chatHistory.push({ role: 'assistant', content: errMsg });
  }

  el.btnChatSend.disabled = false;
  el.chatInput.focus();
}

el.btnChatSend.addEventListener('click', sendChatMessage);
el.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});
el.btnChatClear.addEventListener('click', () => {
  clearChatSession();
  logActivity('Chat session cleared.');
});

// =============================================================
//  UTILITY
// =============================================================
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// =============================================================
//  INITIALIZATION
// =============================================================
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await refreshActiveTab();

  // Notify background that panel is ready
  chrome.runtime.sendMessage({ command: 'panel/ready' }).catch(() => {});
  logActivity('Ready for user commands.');
});
 
// --- Screenshot & Ask ---
document.getElementById('screenshotBtn')?.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'jpeg', quality: 80});
    document.getElementById('screenshotImg').src = dataUrl;
    document.getElementById('screenshotPreview').style.display = 'block';
    window._lastScreenshot = dataUrl;
  } catch(e) {
    alert('Screenshot nahi le paya: ' + e.message);
  }
});

document.getElementById('askScreenshotBtn')?.addEventListener('click', async () => {
  const q = document.getElementById('screenshotQ').value || 'Explain this screenshot';
  const resultBox = document.getElementById('quick-action-result');
  if(resultBox){ resultBox.style.display='block'; resultBox.innerText='Soch raha hu... Screenshot dekh raha hu...'; }
  try{
    const creds = await window.SahayakAI.getStoredCredentials();
    const apiKey = creds.apiKey || creds.geminiApiKey;
    if(!apiKey){ if(resultBox) resultBox.innerText='API Key nahi hai bhai. Settings me Gemini Key daalo.'; return; }
    const base64 = (window._lastScreenshot||'').split(',')[1];
    if(!base64){ if(resultBox) resultBox.innerText='Pehle Screenshot & Ask button dabao.'; return; }
    const payload = { contents: [{ parts: [
      { text: q + ' - Answer in Hinglish, simple Hindi + English mix me samjhao.' },
      { inline_data: { mime_type: 'image/jpeg', data: base64 } }
    ]}]};
    const model = window.SahayakAI.CONFIG.models[0];
    const data = await window.SahayakAI.callGemini(payload);
    const ans = data?.candidates?.[0]?.content?.parts?.map(p=>p.text).join('') || 'Jawab nahi aaya bhai. Dobara try karo.';
    if(resultBox) resultBox.innerText = ans;
    if(resultBox) resultBox.scrollIntoView({ behavior: 'smooth' });
  }catch(e){
    if(resultBox) resultBox.innerText='Error: '+e.message;
  }
});
document.getElementById('scanBtn')?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  chrome.tabs.sendMessage(tab.id, {type: 'SCAN'});
});
let stepCount = 0;
let maxSteps = 5;
let actionLog = [];

function proposeAction(action) {
  // JSON mattum
  const box = document.getElementById("proposal");
  box.innerHTML = `
    <b>${action.type} -> [${action.target}]</b><br>
    Value: ${action.value || "-"}<br>
    Reason: ${action.reason}<br>
    <button id="approveBtn">Approve</button>
    <button id="skipBtn">Skip</button>
    <button id="stopBtn">Stop</button>
    <button id="dryBtn">Dry-Run</button>
  `;

  document.getElementById("approveBtn").onclick = () => runApproved(action);
  document.getElementById("skipBtn").onclick = () => log(action, "Skipped");
  document.getElementById("stopBtn").onclick = () => log(action, "Stopped");
  document.getElementById("dryBtn").onclick = () => {
    chrome.tabs.query({active:true, currentWindow:true}, ([tab]) => {
      chrome.tabs.sendMessage(tab.id, {cmd:"DO_ACTION", action:{...action, type:"dry-run"}});
    });
  };
}

function runApproved(action) {
  if(stepCount >= maxSteps) return alert("Step limit reached!");
  stepCount++;
  chrome.tabs.query({active:true, currentWindow:true}, ([tab]) => {
    chrome.tabs.sendMessage(tab.id, {cmd:"DO_ACTION", action}, (res) => {
      log(action, "Approved - " + res.result);
      // Progress save - worker sleep aanaalum pogadhu
      chrome.storage.session.set({stepCount, actionLog});
    });
  });
}

function log(action, decision) {
  actionLog.push({action, decision, time: new Date().toLocaleTimeString()});
  document.getElementById("log").innerHTML = actionLog.map(l => 
    `<div>${l.action.type} [${l.action.target}] - ${l.decision}</div>`
  ).join("");
}
// --- WEEK 4 DAY 1: PROFILE MEMORY ---
const profileFields = ['p-name','p-college','p-skills','p-lang'];

function loadProfile(){
  chrome.storage.local.get(['sahayakProfile'], (res) => {
    if(res.sahayakProfile){
      profileFields.forEach(id => {
        const el = document.getElementById(id);
        if(el && res.sahayakProfile[id]) el.value = res.sahayakProfile[id];
      });
    }
  });
}

const saveBtn = document.getElementById('save-profile');
if(saveBtn){
  saveBtn.addEventListener('click', () => {
    const data = {};
    profileFields.forEach(id => {
      data[id] = document.getElementById(id).value;
    });
    chrome.storage.local.set({ sahayakProfile: data }, () => {
      document.getElementById('profile-status').innerText = "✅ Profile Saved Locally!";
    });
  });
}

loadProfile();
// --- One-Click Skills ---
async function getSkills(){
  const d = await chrome.storage.local.get("sahayak_skills");
  return d.sahayak_skills || [];
}
async function renderSkills(){
  const skills = await getSkills();
  const list = document.getElementById("skills-list");
  list.innerHTML = "";
  skills.forEach(s => {
    const div = document.createElement("div");
    div.style.display = "flex"; div.style.gap = "8px"; div.style.marginBottom = "6px";
    div.innerHTML = `<button style="flex:1; text-align:left">${s.name}</button> <button data-del="${s.id}">❌</button>`;
    div.querySelector("button").onclick = () => {
      // Chat box la prompt ah potu send pannum
      const chatInput = document.getElementById("chat-input") || document.querySelector("textarea");
      if(chatInput){ chatInput.value = s.prompt; }
      // Un send button id enna nu paathu idha maathu
      document.getElementById("btn-send")?.click();
    };
    div.querySelector("[data-del]").onclick = async () => {
      const rest = skills.filter(x => x.id !== s.id);
      await chrome.storage.local.set({ sahayak_skills: rest });
      renderSkills();
    };
    list.appendChild(div);
  });
}
document.getElementById("btn-add-skill")?.addEventListener("click", async () => {
  const name = document.getElementById("skill-name").value.trim();
  const prompt = document.getElementById("skill-prompt").value.trim();
  if(!name || !prompt) return alert("Name + Prompt rendu venum da!");
  const skills = await getSkills();
  skills.push({ id: Date.now().toString(), name, prompt });
  await chrome.storage.local.set({ sahayak_skills: skills });
  document.getElementById("skill-name").value = "";
  document.getElementById("skill-prompt").value = "";
  renderSkills();
});
document.getElementById("btn-export-skills")?.addEventListener("click", async () => {
  const skills = await getSkills();
  const blob = new Blob([JSON.stringify(skills, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "sahayak-skills.json"; a.click();
});
document.getElementById("import-skills-file")?.addEventListener("change", async (e) => {
  const file = e.target.files[0]; if(!file) return;
  const text = await file.text();
  await chrome.storage.local.set({ sahayak_skills: JSON.parse(text) });
  renderSkills();
});
renderSkills();