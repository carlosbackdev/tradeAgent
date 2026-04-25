/**
 * agent/services/clientAgent.js
 * Generic multi-provider LLM client.
 * Supports: anthropic | openai | deepseek | gemini
 * Provider is resolved from config.llm.provider (or passed explicitly via llmConfig).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSystemPrompt } from '../context/prompts/trading-system-prompt.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config/config.js';

// ─── JSON parser ─────────────────────────────────────────────────────────────

/**
 * Robustly parse raw JSON from any LLM response.
 * @param {string} raw - Raw text returned by the model
 * @returns {Object}
 */
export function parseLlmJsonResponse(raw) {
  if (!raw) throw new Error('LLM returned an empty response');
  
  const cleanedRaw = raw.trim();
  try {
    return JSON.parse(cleanedRaw);
  } catch (_) {
    logger.debug('Direct JSON parse failed, attempting deep cleanup and repair…');
    
    let firstBrace = cleanedRaw.indexOf('{');
    let lastBrace = cleanedRaw.lastIndexOf('}');
    
    // Si no hay cierre pero hay apertura, intentamos reparar el truncamiento
    if (firstBrace !== -1 && lastBrace <= firstBrace) {
      logger.warn('JSON appears truncated, attempting auto-repair...');
      let repaired = cleanedRaw + '\n      ]\n    }\n  ]\n}'; // Intento de cierre agresivo para nuestra estructura
      try { return JSON.parse(repaired.substring(firstBrace)); } catch(e) {}
      
      // Segundo intento de reparación más simple
      repaired = cleanedRaw + ' }'; 
      try { return JSON.parse(repaired.substring(firstBrace)); } catch(e) {}
    }

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const candidate = cleanedRaw.substring(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(candidate);
      } catch (e) {
        // Si falla, intentamos limpiar markdown
        const noMarkdown = candidate.replace(/```json\s?|```/gi, '').trim();
        try { return JSON.parse(noMarkdown); } catch (e2) {}
      }
    }
    throw new Error(`No valid JSON object found in response: ${cleanedRaw.substring(0, 100)}...`);
  }
}

// Keep old export name as alias for backward compatibility
export const parseClaudeJsonResponse = parseLlmJsonResponse;

// ─── Provider helpers ─────────────────────────────────────────────────────────

async function callAnthropic({ apiKey, model, systemPrompt, userMessage }) {
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    temperature: 0.1,
    system: systemPrompt,
    messages: [{ role: 'user', content: [{ type: 'text', text: userMessage }] }],
  });
  return response.content.map(b => b.text || '').join('').trim();
}

async function callOpenAICompat({ apiKey, model, systemPrompt, userMessage, baseUrl }) {
  // Works for OpenAI and DeepSeek (both use the OpenAI SDK format)
  const { OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey,
    ...(baseUrl ? { baseURL: baseUrl } : {}),
  });
  const response = await client.chat.completions.create({
    model,
    max_tokens: 2048,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });
  return response.choices?.[0]?.message?.content?.trim() || '';
}

async function callGemini({ apiKey, model, systemPrompt, userMessage }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig: {
      temperature: 0.1,
      response_mime_type: 'application/json',
      maxOutputTokens: 4096,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
    ]
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errBody}`);
  }
  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Call the configured LLM provider with a user message + system prompt.
 *
 * @param {string}   userMessage    - The prompt to send
 * @param {string}   [apiKey]       - Override API key (per-user); falls back to config.llm.apiKey
 * @param {string}   [model]        - Override model name; falls back to config.llm.model
 * @param {object}   [tradingConfig]- Trading config used to build default system prompt
 * @param {string}   [systemPrompt] - Override system prompt
 * @param {object}   [llmConfig]    - Full llm config override { provider, apiKey, model   }
 * @returns {Promise<Object>}
 */
export async function callAiWithCustomPrompt(
  userMessage,
  apiKey = null,
  model = null,
  tradingConfig = null,
  systemPrompt = null,
  llmConfig = null,
) {
  const effectiveSystemPrompt = systemPrompt || getSystemPrompt(tradingConfig || config.trading);

  // Resolve provider config: explicit llmConfig > config.llm global
  const provider = llmConfig?.provider || config.llm.provider || 'anthropic';
  const effectiveModel = model || llmConfig?.model || config.llm.model || 'claude-haiku-4-5';
  const effectiveApiKey = (apiKey ? String(apiKey).trim() : null)
    || llmConfig?.apiKey
    || config.llm.apiKey
    || '';

  logger.info(`🧠 LLM call → provider: ${provider} | model: ${effectiveModel}`);

  if (!effectiveApiKey || effectiveApiKey.length < 10) {
    throw new Error(`No valid API Key provided for provider "${provider}"`);
  }

  const params = {
    apiKey: effectiveApiKey,
    model: effectiveModel,
    systemPrompt: effectiveSystemPrompt,
    userMessage,
  };

  let raw;
  switch (provider) {
    case 'anthropic':
      raw = await callAnthropic(params);
      break;
    case 'openai':
    case 'deepseek':
      raw = await callOpenAICompat(params);
      break;
    case 'groq':
      raw = await callOpenAICompat({ ...params, baseUrl: 'https://api.groq.com/openai/v1' });
      break;
    case 'gemini':
      raw = await callGemini(params);
      break;
    default:
      throw new Error(`Unsupported LLM provider: "${provider}"`);
  }

  return parseLlmJsonResponse(raw);
}

// ─── Backward-compat aliases ─────────────────────────────────────────────────

/** @deprecated Use callAiWithCustomPrompt */
export const callClaudeWithCustomPrompt = callAiWithCustomPrompt;

export async function callAgentAnalyzer(userMessage, apiKey = null, model = null, tradingConfig = null, llmConfig = null) {
  logger.info(`🧠 callAgentAnalyzer → provider: ${llmConfig?.provider || config.llm.provider}`);
  logger.info('User Message: ', userMessage);
  return callAiWithCustomPrompt(userMessage, apiKey, model, tradingConfig, null, llmConfig);
}
