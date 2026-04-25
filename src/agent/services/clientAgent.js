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
  try {
    return JSON.parse(raw);
  } catch (_) {
    logger.debug('Direct JSON parse failed, attempting cleanup…');
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Failed to extract JSON from LLM response: ${raw.substring(0, 500)}…`);
    }
    const cleaned = jsonMatch[0]
      .replace(/^```json\s*/i, '')
      .replace(/```$/, '')
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch (parseErr) {
      logger.error('JSON Parse Error. Snippet:', raw.substring(0, 500));
      throw new Error(`LLM JSON parse failed: ${parseErr.message}`);
    }
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
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });
  return response.choices?.[0]?.message?.content?.trim() || '';
}

async function callGemini({ apiKey, model, systemPrompt, userMessage }) {
  const endpoint = (`https://generativelanguage.googleapis.com/v1beta/models/${model}`) + `:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
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
