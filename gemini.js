/**
 * Sahayak - Gemini AI Client & Task Planner
 * Model Strategy:
 *   Primary: gemini-2.0-flash
 *   Fallback 1: gemini-3.5-flash-lite
 *   Fallback 2: gemini-3.6-flash
 *   Final Fallback: Groq (llama-3.3-70b-versatile)
 */

const GEMINI_CONFIG = {
  models: [
    'gemini-2.0-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash'
  ],
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
  groqUrl: 'https://api.groq.com/openai/v1/chat/completions',
  timeoutMs: 30000 // 30 seconds limit
};

function getShortModelName(modelName) {
  return modelName.replace('gemini-', '');
}

/**
 * Retrieve saved API keys and preferences from chrome.storage.local
 */
async function getStoredCredentials() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['geminiApiKey', 'groqApiKey', 'language'], (res) => {
      resolve({
        apiKey: (res.geminiApiKey || '').trim(),
        groqKey: (res.groqApiKey || '').trim(),
        language: res.language || 'en'
      });
    });
  });
}

/**
 * Core function to execute generateContent against Gemini REST API
 */
async function callGeminiRaw(modelName, apiKey, payload) {
  const url = `${GEMINI_CONFIG.baseUrl}/${modelName}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_CONFIG.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      let errorMsg = `HTTP ${response.status}`;
      let errorStatus = '';
      try {
        const errJson = await response.json();
        errorMsg = errJson?.error?.message || errorMsg;
        errorStatus = errJson?.error?.status || '';
      } catch (e) {
        // Non-JSON response body
      }

      console.warn(`[Sahayak AI] ${modelName} returned HTTP ${response.status}: ${errorMsg}`);

      const err = new Error(errorMsg);
      err.status = response.status;
      err.modelName = modelName;

      if (response.status === 429) {
        err.code = 'rate_limited';
      } else if (response.status === 503) {
        err.code = 'model_overloaded';
      } else if (response.status === 404 || errorMsg.toLowerCase().includes('not found')) {
        err.code = 'model_not_found';
      } else if (response.status === 400 || response.status === 401 || response.status === 403) {
        if (
          errorMsg.toLowerCase().includes('key') ||
          errorMsg.toLowerCase().includes('credential') ||
          response.status === 403
        ) {
          err.code = 'invalid_key';
        } else {
          err.code = 'bad_request';
        }
      } else {
        err.code = 'server_error';
      }

      throw err;
    }

    const data = await response.json();
    return data;
  } catch (err) {
    clearTimeout(timer);

    if (err.name === 'AbortError') {
      const timeoutErr = new Error('Request timed out after 30 seconds');
      timeoutErr.code = 'timeout';
      timeoutErr.status = 504;
      timeoutErr.modelName = modelName;
      throw timeoutErr;
    }

    if (!err.code) {
      err.code = 'network_error';
    }
    throw err;
  }
}

/**
 * Fallback caller for Groq Cloud API when all Gemini models fail
 */
async function callGroqFallback(groqKey, payload) {
  const userText = payload?.contents?.[0]?.parts?.[0]?.text || '';
  const sysText = payload?.systemInstruction?.parts?.[0]?.text || '';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_CONFIG.timeoutMs);

  try {
    const response = await fetch(GEMINI_CONFIG.groqUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: sysText },
          { role: 'user', content: userText }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq HTTP ${response.status}: ${errText}`);
    }

    const groqData = await response.json();
    const content = groqData?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from Groq');

    return {
      candidates: [
        {
          content: {
            parts: [{ text: content }]
          }
        }
      ],
      provider: 'groq'
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Robust caller with ordered model fallback:
 * gemini-2.0-flash -> retry 3s on 503 -> gemini-3.5-flash-lite -> gemini-3.6-flash -> Groq
 */
async function callGemini(payload, onFallback = null) {
  const { apiKey, groqKey } = await getStoredCredentials();

  if (!apiKey) {
    const err = new Error('Missing Gemini API Key');
    err.code = 'missing_key';
    throw err;
  }

  let lastError = null;
  const failureLog = [];

  for (let i = 0; i < GEMINI_CONFIG.models.length; i++) {
    const modelName = GEMINI_CONFIG.models[i];
    const nextModel = GEMINI_CONFIG.models[i + 1];

    try {
      return await callGeminiRaw(modelName, apiKey, payload);
    } catch (err) {
      lastError = err;
      let statusCode = err.status || (err.code === 'rate_limited' ? 429 : 503);

      // If gemini-2.0-flash returns 503 (high demand), wait 3 seconds and retry SAME model once
      if (modelName === 'gemini-2.0-flash' && (statusCode === 503 || err.code === 'model_overloaded') && !err.retried) {
        const retryNotice = '3.8-flash overloaded (503), waiting 3s to retry...';
        console.warn(`[Sahayak AI] ${retryNotice}`);
        if (typeof onFallback === 'function') {
          onFallback(retryNotice);
        }

        await new Promise((r) => setTimeout(r, 3000));

        try {
          return await callGeminiRaw(modelName, apiKey, payload);
        } catch (retryErr) {
          retryErr.retried = true;
          lastError = retryErr;
          err = retryErr;
          statusCode = retryErr.status || 503;
          failureLog.push(`${getShortModelName(modelName)} (503 retry failed)`);
        }
      } else {
        failureLog.push(`${getShortModelName(modelName)} (${statusCode})`);
      }

      // If the API key itself is invalid or unauthorized, fail immediately
      if (err.code === 'invalid_key') {
        throw err;
      }

      // Check if next Gemini model is available in the chain
      if (nextModel) {
        const currentShort = getShortModelName(modelName);
        const nextShort = getShortModelName(nextModel);

        let reason = 'overloaded';
        if (statusCode === 429) reason = 'rate limited';
        else if (statusCode === 404) reason = 'unavailable';
        else if (statusCode === 500 || statusCode === 502) reason = 'server error';

        const fallbackMsg = `${currentShort} ${reason} (${statusCode}), trying ${nextShort}...`;
        console.warn(`[Sahayak AI] ${fallbackMsg}`);

        if (typeof onFallback === 'function') {
          onFallback(fallbackMsg);
        }

        // Try next model
        continue;
      }
    }
  }

  // If ALL Gemini models fail, attempt Groq fallback if configured
  if (groqKey) {
    const groqMsg = 'All Gemini failed, trying Groq...';
    console.warn(`[Sahayak AI] ${groqMsg}`);
    if (typeof onFallback === 'function') {
      onFallback(groqMsg);
    }

    try {
      return await callGroqFallback(groqKey, payload);
    } catch (groqErr) {
      console.error('[Sahayak AI] Groq fallback failed:', groqErr);
      failureLog.push(`groq (${groqErr.message})`);
    }
  }

  // All models (and Groq if available) failed
  const failSummary = failureLog.join(' -> ');
  const combinedErr = new Error(
    `All AI models failed: ${failSummary}. Last error: ${lastError?.message || 'High demand'}`
  );
  combinedErr.code = lastError?.code || 'model_unavailable';
  combinedErr.status = lastError?.status;
  throw combinedErr;
}

/**
 * Task Planner: Break a user task into a structured step-by-step plan
 * @param {string} taskText - The user instruction
 * @param {object} pageContext - Active tab details (title, url)
 * @param {string} language - 'en' | 'hinglish'
 * @param {function} onFallback - Callback for fallback status notifications
 * @returns {Promise<{ planTitle: string, steps: Array<{ stepNumber: number, description: string, actionType: string }> }>}
 */
async function planTaskWithGemini(taskText, pageContext = {}, language = 'en', onFallback = null) {
  const langPrompt = language === 'hinglish' 
    ? 'Language: Output in natural Hinglish (conversational Hindi written in English/Latin script mixed with English technical terms).' 
    : 'Language: Output in clear English.';

  const systemInstruction = `You are Sahayak, an intelligent Chrome side-panel AI agent.
Your objective is to decompose the user's web browser task into a concise, actionable, step-by-step plan (minimum 2 steps, maximum 8 steps).

${langPrompt}

Current Webpage Context:
- Page Title: "${pageContext.title || 'Unknown'}"
- Page URL: "${pageContext.url || 'Unknown'}"

Output Requirements:
- You must return valid JSON ONLY matching this schema:
{
  "planTitle": "A concise title for this task",
  "steps": [
    {
      "stepNumber": 1,
      "description": "Short description of the action",
      "actionType": "read" | "click" | "type" | "select" | "scroll" | "verify" | "done"
    }
  ]
}
- Maximum 8 steps.
- Make each step specific and logical for a browser assistant.
- Strictly adhere to JSON format. Do not include markdown code fences or explanatory prose outside the JSON.`;

  const payload = {
    contents: [
      {
        parts: [
          { text: `Task to plan: "${taskText}"` }
        ]
      }
    ],
    systemInstruction: {
      parts: [
        { text: systemInstruction }
      ]
    },
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json'
    }
  };

  const rawResult = await callGemini(payload, onFallback);

  // Extract text candidate
  const textContent = rawResult?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textContent) {
    const err = new Error('Empty response received from AI model');
    err.code = 'model_unavailable';
    throw err;
  }

  // Parse JSON output safely
  try {
    const cleanedJson = textContent.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleanedJson);

    if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      throw new Error('Invalid plan schema: missing steps array');
    }

    parsed.steps = parsed.steps.slice(0, 8).map((step, idx) => ({
      stepNumber: step.stepNumber || idx + 1,
      description: step.description || `Step ${idx + 1}`,
      actionType: step.actionType || 'verify'
    }));

    parsed.planTitle = parsed.planTitle || 'Task Execution Plan';
    if (rawResult.provider === 'groq') {
      parsed.planTitle = `${parsed.planTitle} (via Groq)`;
    }
    return parsed;
  } catch (parseErr) {
    console.error('[Sahayak AI] JSON parse error:', parseErr, textContent);
    const err = new Error('Failed to parse structured plan from AI');
    err.code = 'json_parse_error';
    throw err;
  }
}

// Attach to window for global access in side panel
window.SahayakAI = {
  callGemini,
  callGeminiRaw,
  planTaskWithGemini,
  getStoredCredentials,
  CONFIG: GEMINI_CONFIG
};
