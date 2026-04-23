
/**
 * agent/context/prompt.js
 * System prompt and Anthropic client for the analyzer.
*/
import Anthropic from '@anthropic-ai/sdk';
import { getSystemPrompt } from '../context/prompts/trading-system-prompt.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config/config.js';

// No global client needed for multi-user support

/**
 * Parse Claude's JSON response robustly
 * @param {string} raw - Raw response text from Claude
 * @returns {Object} Parsed JSON object
 */
export function parseClaudeJsonResponse(raw) {
  try {
    // Try parsing directly first
    return JSON.parse(raw);
  } catch (err) {
    logger.debug('Direct JSON parse failed, attempting cleanup...');

    // Attempt to extract JSON if Claude added conversational text
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Failed to extract JSON from response: ${raw.substring(0, 500)}...`);
    }

    const cleaned = jsonMatch[0]
      .replace(/^```json\s*/i, '')
      .replace(/```$/, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch (parseErr) {
      logger.error('JSON Parse Error. Raw response snippet:', raw.substring(0, 500));
      throw new Error(`Claude JSON parse failed: ${parseErr.message}`);
    }
  }
}

/**
 * Call Claude with custom message and system prompt
 */
export async function callClaudeWithCustomPrompt(userMessage, apiKey = null, model = null, tradingConfig = null, systemPrompt = null) {
  const effectiveSystemPrompt = systemPrompt || getSystemPrompt(tradingConfig || config.trading);
  const effectiveModel = model || config.anthropic.model;
  const hasExplicitApiKey = apiKey !== null && apiKey !== undefined;
  const effectiveApiKey = hasExplicitApiKey ? String(apiKey).trim() : (config.anthropic.apiKey || '');
  logger.info(`🔑 Effective System Prompt: ${effectiveSystemPrompt}`);

  if (!effectiveApiKey || !effectiveApiKey.startsWith('sk-')) {
    throw new Error('No Anthropic API Key provided');
  }

  const anthropic = new Anthropic({ apiKey: effectiveApiKey });

  const response = await anthropic.messages.create({
    model: effectiveModel,
    max_tokens: 2048,
    system: effectiveSystemPrompt,
    messages: [{ role: 'user', content: [{ type: 'text', text: userMessage }] }],
  });

  const raw = response.content
    .map(block => block.text || '')
    .join('')
    .trim();

  return parseClaudeJsonResponse(raw);
}

export async function callAgentAnalyzer(userMessage, apiKey = null, model = null, tradingConfig = null) {
  return callClaudeWithCustomPrompt(userMessage, apiKey, model, tradingConfig);
}

