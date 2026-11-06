# Sahayak: Edge Cases & Corner Scenarios Reference

> **Project:** Sahayak — Chrome Side-Panel AI Agent  
> **Source Spec:** `AI-Web-browser-2.2.pdf`  
> **Architecture Reference:** `architecture.md`  
> **Implementation Reference:** `implementation-plan.md`  
> **Purpose:** Exhaustive catalog of failure modes, edge cases, deterministic safety gates, and expected recovery behaviors across all 17 slices.

---

## 1. Authentication, Credentials & API Boundaries

### 1.1 API Key Missing or Blank
- **Trigger:** User opens the side panel for the first time or clears the API key in Settings and attempts an action (Summarise, Chat, or Agent Task).
- **Risk:** Unhandled network rejection, leaking empty key to provider, poor first-time user experience.
- **Deterministic Detection:** `src/ai/client.ts` checks `storage.settings.geminiApiKey` prior to initiating any `fetch()`. If `!key || key.trim() === ''`, reject immediately.
- **Safe Behavior:** Zero network calls are dispatched. The request aborts with error code `missing_key`.
- **User-Facing Copy & UI State:**
  - Banner in side panel: *"Please enter your Gemini API key in Settings to get started."*
  - Action button in banner: `[Open Settings]`.
- **Handling File(s):** `src/ai/client.ts`, `src/sidepanel/components/settings.tsx`.

---

### 1.2 Invalid, Suspended or Revoked API Key (HTTP 400 / 401 / 403)
- **Trigger:** User enters a mistyped key, an expired key, or a key without Gemini API enablement.
- **Risk:** Silent request hangs or cryptic JSON stack traces shown to the user.
- **Deterministic Detection:** Response status code is `400`, `401`, or `403` with Google error payload containing `API_KEY_INVALID` or `PERMISSION_DENIED`.
- **Safe Behavior:** Catch HTTP status immediately, invalidate cached connection status in `storage.local`, set `settings.keyValid = false`. Do not retry.
- **User-Facing Copy & UI State:**
  - Error callout: *"Your Gemini API key appears to be invalid or unauthorized. Please verify your key in Settings."*
  - Re-enable the input box with clear error indication.
- **Handling File(s):** `src/ai/client.ts`, `src/sidepanel/components/settings.tsx`.

---

### 1.3 HTTP 429 Rate Limit (Quota Exhausted)
- **Trigger:** Free-tier Gemini quota limit reached (e.g. 15 RPM or daily cap).
- **Risk:** User workflow abruptly interrupted, failed summaries, frozen UI.
- **Deterministic Detection:** Response returns HTTP status `429`. Inspect `Retry-After` header.
- **Safe Behavior:**
  1. If `Retry-After` is present and $\le 8$ seconds: Show waiting indicator, pause asynchronously for that duration, and retry primary model **once**.
  2. If retry fails or `Retry-After > 8s`:
     - If the task is a **text task** (Summary, Chat, Context Menu, Agent Step) AND a Groq API key is configured: Automatically fallback to Groq (`llama-3.3-70b-versatile`). Render a subtle badge: *"Answered via Groq fallback"*.
     - If the task is **multimodal** (Screenshot, YouTube video) OR Groq key is absent: Stop execution, return `rate_limited`.
- **User-Facing Copy & UI State:**
  - During wait: *"Sahayak is waiting for the free model..."*
  - When exhausted without fallback: *"Sahayak is waiting for the free model. Please try again in a few moments."*
- **Handling File(s):** `src/ai/client.ts`, `src/shared/models.ts`.

---

### 1.4 Groq Fallback Failure or Missing Key
- **Trigger:** Gemini returns 429, and either Groq is not configured or Groq also fails (HTTP 429/500/network error).
- **Risk:** Infinite fallback loop or crash.
- **Deterministic Detection:** `client.ts` fallback chain catches error from secondary provider.
- **Safe Behavior:** Terminate fallback chain after one failed attempt. Return `rate_limited` code.
- **User-Facing Copy & UI State:**
  - *"All free AI model quotas are currently busy. Please wait a minute before trying again."*
- **Handling File(s):** `src/ai/client.ts`.

---

### 1.5 Network Disconnection / Offline Mode
- **Trigger:** User loses Wi-Fi/Ethernet connection while using Sahayak.
- **Risk:** Uncaught `TypeError: Failed to fetch` causing React component crash.
- **Deterministic Detection:** `window.navigator.onLine === false` check or caught `fetch` rejection matching `/failed to fetch|networkerror/i`.
- **Safe Behavior:** Intercept fetch error before passing to UI components. Retain user prompt in the input composer so their typed question is not lost.
- **User-Facing Copy & UI State:**
  - *"You appear to be offline. Please check your internet connection and try again."*
  - Preserved prompt text in the composer with an active `[Retry]` button.
- **Handling File(s):** `src/ai/client.ts`, `src/sidepanel/components/chat.tsx`.

---

### 1.6 Request Timeout (> 30 Seconds)
- **Trigger:** Remote LLM hangs or network latency exceeds acceptable threshold.
- **Risk:** Spinner spins indefinitely, blocking the user from initiating new actions.
- **Deterministic Detection:** `AbortController` signal wired with a `setTimeout(30000)` on all fetch calls (`src/shared/limits.ts`).
- **Safe Behavior:** Fire `abortController.abort()`, clear active spinners, reset request state to idle.
- **User-Facing Copy & UI State:**
  - *"The request timed out after 30 seconds. The AI service took too long to respond. Please try again."*
- **Handling File(s):** `src/ai/client.ts`.

---

## 2. Deterministic Safety & Privacy Guards

### 2.1 Sensitive URLs (Banking, UPI, Payment & Checkout)
- **Trigger:** Active tab is on a financial, banking, payment gateway, or tax site (e.g. HDFC, SBI, Paytm, PhonePe, Razorpay, Stripe Checkout, PayPal, Income Tax portal).
- **Risk:** Leakage of financial records, accidental transaction approvals, credential theft.
- **Deterministic Detection:** `safetyPolicy.classifyUrl(url)` runs a strict regex denylist against active tab URL before any DOM reading or API call:
  ```typescript
  /bank|paytm|phonepe|gpay|upi|razorpay|stripe\.com\/checkout|paypal|incometax|uidai|licindia/i
  ```
- **Safe Behavior:**
  - **Zero DOM extraction:** Content script extraction is aborted immediately.
  - **Zero Screenshot capture:** `captureVisibleTab` is strictly refused.
  - **Zero Badges:** Scanner will not execute.
  - Returns `ok: false, error: { code: 'sensitive_page' }`.
- **User-Facing Copy & UI State:**
  - Amber safety banner: *"Sahayak is paused for your safety: Actions are disabled on sensitive or private pages."*
  - All action triggers (Summarise, Ask Screen, Scan, Start Task) are disabled.
- **Handling File(s):** `src/shared/safety-policy.ts`, `src/background/messaging.ts`, `src/sidepanel/app.tsx`.

---

### 2.2 Authentication, Login & Credential Pages
- **Trigger:** Active tab is a login, signup, SSO, or OAuth page (`/login`, `/signin`, `accounts.google.com`, `auth0.com`).
- **Risk:** AI observing temporary tokens, username patterns, or password entry.
- **Deterministic Detection:** `safetyPolicy.classifyUrl(url)` flags authentication endpoints matching `/login|signin|signup|oauth|password_reset/i`.
- **Safe Behavior:** URL classified as `sensitive_page`. Agent execution and DOM parsing are blocked.
- **User-Facing Copy & UI State:**
  - *"Sahayak is paused on authentication and login pages to protect your credentials."*
- **Handling File(s):** `src/shared/safety-policy.ts`.

---

### 2.3 Password Input Fields
- **Trigger:** Webpage contains `<input type="password">` or element with password attributes.
- **Risk:** LLM reading existing password characters or attempting to type credentials into the field.
- **Deterministic Detection:** `safetyPolicy.classifyField(element)` in `src/content/scanner.ts`:
  ```typescript
  if (element.type === 'password' || element.getAttribute('data-type') === 'password') return 'protected_field';
  ```
- **Safe Behavior:**
  - The scanner **never** assigns a badge number to password fields.
  - The element is completely omitted from the Action Map JSON sent to the AI.
  - If a synthetic event is directed at a password field, `src/content/executor.ts` throws a hard exception and refuses to fire events.
- **User-Facing Copy & UI State:** Password field has no badge. If requested via prompt: *"For your protection, Sahayak cannot interact with password fields."*
- **Handling File(s):** `src/shared/safety-policy.ts`, `src/content/scanner.ts`, `src/content/executor.ts`.

---

### 2.4 OTP, 2FA & Verification Fields
- **Trigger:** Form contains fields for One-Time Passwords, 2FA codes, or SMS verification.
- **Risk:** Compromise of two-factor authentication flows.
- **Deterministic Detection:** Attribute check:
  - `autocomplete="one-time-code"`
  - `name`, `id`, `placeholder`, `aria-label` matching `/(^|\b)(otp|2fa|verification[_-]?code|passcode)(\b|_|$)/i`.
- **Safe Behavior:** Filtered out from scanner; marked as `protected_field`. Agent will not select or type into these inputs.
- **User-Facing Copy & UI State:** No badge rendered; user manual entry is required.
- **Handling File(s):** `src/shared/safety-policy.ts`, `src/content/scanner.ts`.

---

### 2.5 Credit Card Numbers, Expiry & CVV
- **Trigger:** Form contains credit/debit card inputs.
- **Risk:** Financial data exposure.
- **Deterministic Detection:** Attribute check:
  - `autocomplete="cc-number"`, `autocomplete="cc-csc"`, `autocomplete="cc-exp"`
  - `name`, `id`, `placeholder` matching `/cc-num|cvv|cvc|card[_-]?number|security[_-]?code/i`.
- **Safe Behavior:** Filtered out from scanner. Never included in Action Map JSON.
- **User-Facing Copy & UI State:** Elements remain unbadged and inaccessible to AI.
- **Handling File(s):** `src/shared/safety-policy.ts`, `src/content/scanner.ts`.

---

### 2.6 Consequential Action Buttons (Double-Gate)
- **Trigger:** Proposed agent action targets a button or link with high consequence:
  - Keywords: `Submit`, `Apply Now`, `Confirm Order`, `Pay`, `Pay Now`, `Transfer`, `Send`, `Delete`, `Remove Account`.
- **Risk:** Irreversible actions (financial charges, form submissions, data deletion) executed unintentionally.
- **Deterministic Detection:** `safetyPolicy.isConsequentialName(elementText, elementAttributes)` matches against consequential keyword dictionary.
- **Safe Behavior:**
  - Normal `[Approve]` button in the side panel is replaced by a high-visibility **warning card**.
  - Clicking `[Approve]` opens a **Double-Confirmation Modal**:
    > *"⚠️ High Consequence Action: This will submit data or make changes. Are you sure you want Sahayak to click this?"*
  - Requires explicit click on `[Confirm & Execute]`.
- **User-Facing Copy & UI State:** Amber highlight with explicit warning modal before dispatch.
- **Handling File(s):** `src/shared/safety-policy.ts`, `src/sidepanel/components/agent.tsx`.

---

### 2.7 Attempting to Whitelist a Sensitive URL in Settings
- **Trigger:** User attempts to add `https://mybank.com` or `https://paypal.com` to the custom practice allowlist in Settings.
- **Risk:** Bypassing hardcoded financial safety rules.
- **Deterministic Detection:** Settings validator runs `classifyUrl(inputUrl)` before persisting to `storage.local.settings.allowedDomains`.
- **Safe Behavior:** Hard denylist has strict priority over user allowlist. Reject domain addition with validation error.
- **User-Facing Copy & UI State:**
  - *"This domain is classified as sensitive (banking/auth) and cannot be added to the allowlist."*
- **Handling File(s):** `src/sidepanel/components/settings.tsx`, `src/shared/safety-policy.ts`.

---

## 3. Page Extraction & Media Corner Cases

### 3.1 Heavy Single-Page Apps (SPA) Where Readability Returns Empty Text
- **Trigger:** Complex React/Vue/Angular web apps with unconventional DOM tags or canvas-only renderers where Readability yields zero text.
- **Risk:** Crash or empty string sent to Gemini, resulting in hallucinated summaries.
- **Deterministic Detection:** `src/content/extract.ts` inspects Readability output: `!article || !article.textContent || article.textContent.trim().length < 50`.
- **Safe Behavior:**
  - Automatic fallback to clipped `document.body.innerText`.
  - Strip excessive white spaces and non-printable characters.
  - If still empty (< 50 chars), return status `empty_page`.
- **User-Facing Copy & UI State:**
  - *"Sahayak could not find enough readable text on this page. Try using 'Ask about this screen' instead."*
- **Handling File(s):** `src/content/extract.ts`, `src/sidepanel/components/summary.tsx`.

---

### 3.2 Extremely Large Page Content (> 12,000 Characters)
- **Trigger:** Long documentation pages, e-books, or extensive research papers.
- **Risk:** Token limit exhaustion, high latency, context dilution.
- **Deterministic Detection:** `extract.ts` measures `cleanedText.length > 12000`.
- **Safe Behavior:**
  - Deterministic head-tail preservation: Slice first 6,000 characters (introductions, headers) and last 6,000 characters (conclusions, next steps).
  - Inject explicit boundary marker: `"\n\n[...middle content truncated for length...]\n\n"`.
  - Set metadata flag `truncated: true`.
- **User-Facing Copy & UI State:**
  - Subtle informational tag: *"Summarised from a condensed version of this long page."*
- **Handling File(s):** `src/content/extract.ts`, `src/shared/limits.ts`.

---

### 3.3 Public YouTube Video: Private, Unlisted, or Age-Restricted
- **Trigger:** User opens a YouTube URL that is private, requires account login, or is region-blocked.
- **Risk:** Gemini Flash video ingestion returns 400 Bad Request or `VIDEO_UNAVAILABLE`.
- **Deterministic Detection:** AI client catches YouTube ingestion error payload.
- **Safe Behavior:** Do not attempt brittle caption scraping (as per PDF spec). Immediately report that the video is private or inaccessible.
- **User-Facing Copy & UI State:**
  - *"This YouTube video is private, restricted, or unavailable for AI summarisation. Public videos are supported."*
- **Handling File(s):** `src/ai/youtube.ts`, `src/sidepanel/components/summary.tsx`.

---

### 3.4 YouTube Video Without Chapters
- **Trigger:** A public video without user-created chapter markers.
- **Risk:** Parser expecting `chapters` array fails or throws schema validation errors.
- **Deterministic Detection:** `src/ai/parse.ts` treats `chapters` as an optional array field in the schema.
- **Safe Behavior:** Parse TL;DR and 5 bullet points successfully; omit the chapters section in the UI without throwing an error.
- **User-Facing Copy & UI State:** Summary renders cleanly without the timestamp list.
- **Handling File(s):** `src/ai/parse.ts`, `src/sidepanel/components/summary.tsx`.

---

### 3.5 YouTube Shorts & Live Streams
- **Trigger:** URL is `https://youtube.com/shorts/...` or a live stream URL (`/live/...`).
- **Risk:** Shorts lack structured context; live streams have unbounded durations.
- **Deterministic Detection:** `isYouTubeWatchUrl(url)` checks for `/watch?v=`.
- **Safe Behavior:** Reject live streams with clear error; redirect Shorts to standard video view if ID is extractable, or show unsupported notice.
- **User-Facing Copy & UI State:**
  - *"Live streams and YouTube Shorts are not currently supported for structured summaries."*
- **Handling File(s):** `src/ai/youtube.ts`.

---

## 4. Visual Understanding & Screen Capture Edge Cases

### 4.1 Screenshot Capture on Restricted Chrome URLs
- **Trigger:** User tries "Ask about this screen" on `chrome://`, `chrome-extension://`, or the Chrome Web Store.
- **Risk:** Chrome security policy throws `Cannot capture a chrome:// URL`.
- **Deterministic Detection:** `capture/visible` handler checks `tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.includes('chromewebstore.google.com')`.
- **Safe Behavior:** Abort capture before calling `chrome.tabs.captureVisibleTab`.
- **User-Facing Copy & UI State:**
  - *"Chrome restricts extensions from capturing internal browser pages or the Web Store."*
- **Handling File(s):** `src/background/messaging.ts`, `src/sidepanel/components/cropper.tsx`.

---

### 4.2 Minimized or Hidden Browser Tab
- **Trigger:** User starts a screenshot request while switching tabs or minimizing the Chrome window.
- **Risk:** Captured PNG is empty (0 bytes) or corrupted.
- **Deterministic Detection:** Catch `chrome.tabs.captureVisibleTab` error or check if `canvas.toDataURL()` returns an empty frame.
- **Safe Behavior:** Cancel crop dialog, do not dispatch to vision model.
- **User-Facing Copy & UI State:**
  - *"Screen capture failed because the browser window was minimized or hidden. Please keep the window visible and try again."*
- **Handling File(s):** `src/sidepanel/components/cropper.tsx`.

---

### 4.3 High-DPI / 4K Ultrawide Displays
- **Trigger:** User has a 4K display; screen capture produces a huge image (>15MB).
- **Risk:** Crashing side panel memory or exceeding Gemini's request payload limit.
- **Deterministic Detection:** Canvas dimensions checked in `cropper.tsx`.
- **Safe Behavior:**
  - Downscale using bi-linear canvas scaling: constrain the longest edge to a maximum of **1280px**.
  - Encode to `image/jpeg` with quality compression set to **0.7**.
  - Resulting payload is guaranteed under 600 KB.
  - Drop the data URL from memory as soon as the API response returns or user cancels.
- **User-Facing Copy & UI State:** Seamless downscaling; fast upload.
- **Handling File(s):** `src/sidepanel/components/cropper.tsx`.

---

### 4.4 User Cancels the Cropping Tool
- **Trigger:** User clicks "Ask about screen", canvas appears, but user clicks `[Cancel]` or presses `Escape`.
- **Risk:** Leaking canvas image in memory, leaving UI in an indeterminate state.
- **Deterministic Detection:** Event handler on Cancel button and `keydown: Escape`.
- **Safe Behavior:** Destroy canvas reference, set image state to `null`, restore chat composer to default.
- **User-Facing Copy & UI State:** Side panel returns cleanly to the standard chat view.
- **Handling File(s):** `src/sidepanel/components/cropper.tsx`.

---

## 5. Agent Loop, DOM Dynamics & Computer-Use

### 5.1 Stale Element ID (DOM Changed Between Scan & Execution)
- **Trigger:** Element #3 was scanned, but the webpage dynamically updated (AJAX reload, modal closed, items re-rendered) before the user clicked `[Approve]`.
- **Risk:** Extension clicks the wrong element or throws `null reference error`.
- **Deterministic Detection:** `src/content/executor.ts` checks:
  ```typescript
  const el = document.querySelector(`[data-sahayak-id="${elementId}"]`);
  if (!el || !document.body.contains(el)) return { ok: false, error: 'stale_element' };
  ```
- **Safe Behavior:**
  - Abort execution immediately.
  - Do not fire synthetic events on arbitrary nodes.
  - Automatically trigger `page/scan` to rebuild the action map and request a revised proposal from the AI.
- **User-Facing Copy & UI State:**
  - Notice in Agent card: *"The page updated while waiting. Re-scanning current elements..."*
- **Handling File(s):** `src/content/executor.ts`, `src/sidepanel/components/agent.tsx`.

---

### 5.2 Element Obscured by an Overlay / Modal Backdrop
- **Trigger:** Target element is covered by a cookie consent banner, modal backdrop, or sticky header.
- **Risk:** Synthetic click fails or hits the backdrop instead of the target.
- **Deterministic Detection:** `document.elementFromPoint(x, y)` check does not match target element or its children.
- **Safe Behavior:**
  - Attempt `element.scrollIntoView({ block: 'center' })` to bring element out from under sticky headers.
  - If still obscured, propose dismissing the overlay first or alert the user to dismiss it manually.
- **User-Facing Copy & UI State:**
  - *"Element #4 appears to be obscured by an overlay. Please close any popups on the page."*
- **Handling File(s):** `src/content/executor.ts`.

---

### 5.3 User Clicks [Skip] on Proposed Action
- **Trigger:** User disagrees with the proposed action (e.g. AI wants to type the wrong value or click an irrelevant button).
- **Risk:** AI repeating the exact same proposal in an infinite loop.
- **Deterministic Detection:** User clicks `[Skip]` in `src/sidepanel/components/agent.tsx`.
- **Safe Behavior:**
  - Action is **not** executed on the DOM.
  - The skipped action is added to `actionHistory` with status `user_skipped`.
  - Re-prompt the AI with explicit negative constraint:
    > *"The user skipped your previous proposal: [action]. Please select a different next step to accomplish the goal."*
- **User-Facing Copy & UI State:**
  - Proposal card updates to: *"Step skipped. Sahayak is thinking of an alternative..."*
- **Handling File(s):** `src/sidepanel/components/agent.tsx`, `src/ai/prompts.ts`.

---

### 5.4 User Clicks [Stop] or Emergency Kill-Switch
- **Trigger:** User clicks the red **STOP** button in the header or the `[Stop]` button in the proposal card.
- **Risk:** In-flight scripts or timers continuing to execute.
- **Deterministic Detection:** Click handler calls `stopAgentLoop()`.
- **Safe Behavior:**
  - Dispatches `page/clearBadges` to content script.
  - Clears all pulsing overlays and DOM markers immediately.
  - Aborts any active HTTP fetch call.
  - Sets task status to `aborted` in `chrome.storage.session`.
- **User-Facing Copy & UI State:**
  - Status banner: *"Task stopped by user."*
  - Proposal controls hide; Action Log records `Task terminated by user kill-switch`.
- **Handling File(s):** `src/sidepanel/components/header.tsx`, `src/sidepanel/components/agent.tsx`.

---

### 5.5 Loop Exceeds 8-Step Hard Limit
- **Trigger:** Complex or recursive workflow exceeds 8 actions without completing.
- **Risk:** Infinite automated loops, token waste, runaway errors.
- **Deterministic Detection:** `currentStep >= MAX_AGENT_STEPS (8)` check in `agent.tsx`.
- **Safe Behavior:**
  - Forcibly pause execution.
  - Clear DOM badges.
  - Do not ask AI for step 9 automatically.
- **User-Facing Copy & UI State:**
  - *"Maximum step limit reached (8 steps). Please review the page and resume if needed."*
  - Provides a manual `[Resume Next 8 Steps]` button if the user wishes to proceed.
- **Handling File(s):** `src/shared/limits.ts`, `src/sidepanel/components/agent.tsx`.

---

### 5.6 Service Worker Enters Sleep / Inactivity State
- **Trigger:** User leaves an approval card open for >30 seconds. Chrome suspends the background service worker to conserve memory.
- **Risk:** Losing current step state, tab reference, or pending action when the worker terminates.
- **Deterministic Detection:** Worker lifecycle triggers termination.
- **Safe Behavior:**
  - Approval state and task progress are **never stored in worker memory**.
  - All state is mirrored continuously into `chrome.storage.session`.
  - When the user clicks `Approve`, the side panel (or re-awakened service worker) loads state directly from `chrome.storage.session`.
- **User-Facing Copy & UI State:** Zero disruption to user experience; workflow continues seamlessly.
- **Handling File(s):** `src/shared/storage.ts`, `src/sidepanel/components/agent.tsx`.

---

### 5.7 Active Tab Switched or Closed Mid-Loop
- **Trigger:** User switches to another tab or closes the target tab while an agent task is active.
- **Risk:** Executing actions on an unintended tab or throwing tab not found errors.
- **Deterministic Detection:** `chrome.tabs.onActivated` and `chrome.tabs.onRemoved` listeners in `src/background/tab-tracker.ts`.
- **Safe Behavior:**
  - If tab is switched: Pause the agent loop on the previous tab; do not execute steps on the new tab.
  - If target tab is closed: Terminate loop cleanly, clear session state, update status to `tab_closed`.
- **User-Facing Copy & UI State:**
  - *"The target tab was closed. Task ended."*
- **Handling File(s):** `src/background/tab-tracker.ts`, `src/sidepanel/components/agent.tsx`.

---

## 6. AI Output & Schema Integrity

### 6.1 Model Returns Invalid or Malformed JSON
- **Trigger:** AI generates markdown wrapping (` ```json ... ``` `), trailing commas, or incomplete syntax.
- **Risk:** `JSON.parse()` crashes the side panel.
- **Deterministic Detection:** `src/ai/parse.ts` wraps all parsing in robust sanitizers:
  1. Strip Markdown code fences (` ```json ` and ` ``` `).
  2. Extract substring between first `{` or `[` and matching `}` or `]`.
  3. Validate against Zod or strict TypeScript schema.
- **Safe Behavior:**
  - If parse fails: Re-ask the model **once** with the specific parse error:
    > *"Your previous output was not valid JSON: [error]. Please return only raw valid JSON matching the schema."*
  - If second attempt fails: Escalate to `gemini-3.8-flash` / fallback models once. If still failing, return graceful error.
- **User-Facing Copy & UI State:**
  - *"Could not parse the AI response. Please try re-running the request."*
- **Handling File(s):** `src/ai/parse.ts`, `src/ai/client.ts`.

---

### 6.2 Model Proposes Hallucinated Element ID
- **Trigger:** AI proposes: `{ action: "click", elementId: 99 }`, but the action map only contains elements 1 to 12.
- **Risk:** Content script attempts to access non-existent DOM element.
- **Deterministic Detection:** Content script checks:
  ```typescript
  if (!actionMap.some(item => item.id === proposedAction.elementId)) {
    return { ok: false, error: 'invalid_element_id' };
  }
  ```
- **Safe Behavior:** Reject action prior to approval presentation; ask model to re-select from valid IDs.
- **User-Facing Copy & UI State:** Prevents presenting an invalid action to the user.
- **Handling File(s):** `src/ai/parse.ts`, `src/content/scanner.ts`.

---

### 6.3 Grounded Chat Off-Page Hallucination Guard
- **Trigger:** User asks a question in Chat that is not answered anywhere in the extracted page text (e.g. *"What is the founder's personal phone number?"*).
- **Risk:** LLM hallucinating plausible-sounding but false answers.
- **Deterministic Detection:** Prompt system instruction enforces:
  > *"Answer solely using the provided page context. If the answer cannot be found in the text, you must refuse and output exactly: 'OFF_PAGE: [brief reason]'."*
- **Safe Behavior:** Intercept the `OFF_PAGE:` sentinel in `src/ai/client.ts`. Tag response as `off_page`.
- **User-Facing Copy & UI State:**
  - Neutral informational note: *"This information is not available on the current page."*
- **Handling File(s):** `src/ai/prompts.ts`, `src/sidepanel/components/chat.tsx`.

---

## 7. Local Profile Memory, Skills & Storage Limits

### 7.1 Missing Fields in Local Profile During Form Auto-Fill
- **Trigger:** User executes "Fill form from profile", but their profile only contains `fullName` and `email` (e.g. `phone` or `graduationYear` is blank).
- **Risk:** Agent typing `"undefined"`, `"null"`, or guessing fake data.
- **Deterministic Detection:** Prompt builder filters out empty profile keys:
  ```typescript
  const cleanProfile = Object.fromEntries(
    Object.entries(profile).filter(([_, v]) => Boolean(v) && v !== '')
  );
  ```
- **Safe Behavior:** Model is instructed: *"Only fill fields where explicit values exist in the profile. Skip any fields where profile data is missing."*
- **User-Facing Copy & UI State:**
  - Reason displayed: *"Filled Full Name and Email from profile. Left Phone blank (not in profile)."*
- **Handling File(s):** `src/ai/prompts.ts`, `src/sidepanel/components/profile.tsx`.

---

### 7.2 Corrupted or Malformed Skills JSON Import
- **Trigger:** User imports a corrupted or tampered `sahayak-skills.json` file.
- **Risk:** Crashing the skills gallery or injecting malicious scripts.
- **Deterministic Detection:** `src/sidepanel/components/skills.tsx` validates imported JSON against strict schema:
  - Must be an array of objects.
  - Each item must have `id` (string), `title` (string max 60 chars), `promptTemplate` (string max 2000 chars).
  - Disallow any `<script>` tags or javascript protocol URLs.
- **Safe Behavior:** Reject import with clear notification; do not overwrite existing skills.
- **User-Facing Copy & UI State:**
  - Red alert: *"Invalid skills file format. Please import a valid sahayak-skills.json export."*
- **Handling File(s):** `src/sidepanel/components/skills.tsx`.

---

### 7.3 Storage Quota Limits
- **Trigger:** User accumulates dozens of action logs or large profile data over months.
- **Risk:** Exceeding `chrome.storage.local` quota (5MB default without `unlimitedStorage`).
- **Deterministic Detection:** Storage manager tracks usage and applies FIFO eviction to action logs.
- **Safe Behavior:**
  - Action log capped at **last 20 sessions** (`src/shared/limits.ts`). Older logs automatically pruned.
  - Ephemeral agent loops live in `chrome.storage.session` which resets when the browser session closes.
- **User-Facing Copy & UI State:** Seamless performance; no storage warnings.
- **Handling File(s):** `src/shared/storage.ts`, `src/shared/limits.ts`.

---

## 8. Master Error Copy & UI State Matrix

| Error Code | Trigger Condition | Exact User-Facing Copy | Actionable Resolution |
|---|---|---|---|
| `missing_key` | API key is missing or blank. | *"Please enter your Gemini API key in Settings to get started."* | Button: `[Open Settings]` |
| `invalid_key` | HTTP 400/401/403 on API call. | *"Your Gemini API key appears to be invalid or unauthorized. Please verify your key in Settings."* | Button: `[Check Key]` |
| `rate_limited` | HTTP 429 received and fallback exhausted. | *"Sahayak is waiting for the free model. Please try again in a few moments."* | Auto-retry or wait button |
| `sensitive_page` | URL matches banking, payment, or auth denylist. | *"Sahayak is paused for your safety: Actions are disabled on sensitive or private pages."* | Informational banner |
| `protected_field`| Field is password, OTP, or credit card. | *"For your protection, Sahayak cannot interact with password or financial fields."* | Element unbadged |
| `off_page` | Answer not found in page context. | *"This information is not available on the current page."* | Grounded refusal |
| `consequential_action` | Target is Submit, Pay, Transfer, or Delete. | *"⚠️ High Consequence Action: This will submit data or make changes. Are you sure you want Sahayak to proceed?"* | Secondary Confirm Modal |
| `max_steps_reached` | 8 consecutive steps completed. | *"Maximum step limit reached (8 steps). Please review the page and resume if needed."* | Button: `[Resume]` |
| `stale_element` | DOM element missing or re-rendered before click. | *"The page updated while waiting. Re-scanning current elements..."* | Automatic re-scan |
| `model_unavailable` | Network failure or 5xx server error. | *"The AI service is temporarily unavailable. Please check your connection and try again."* | Button: `[Retry]` |
| `empty_page` | Readability & innerText yield < 50 characters. | *"Sahayak could not find enough readable text on this page. Try using 'Ask about this screen' instead."* | Button: `[Ask Screen]` |
| `tab_closed` | Active tab closed during running errand. | *"The target tab was closed. Task ended."* | Return to idle |
| `user_stopped` | User pressed Stop or Kill-switch. | *"Task stopped by user."* | Clear badges & idle |

