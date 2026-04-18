
/**
 * agent/context/prompt.js
 * System prompt and Anthropic client for the analyzer.
*/
import { getSystemPrompt } from '../context/prompt.js';
import Anthropic from '@anthropic-ai/sdk';
import { buildAnalyzerMessage } from '../context/analyzer-market.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config/config.js';

export const client = new Anthropic({ apiKey: config.anthropic.apiKey });

export async function callAgentAnalyzer(context, question) {
  let userMessage = buildAnalyzerMessage(context, question);

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 2048,
    system: getSystemPrompt(config.trading),
    messages: [{ role: 'user', content: [{ type: 'text', text: userMessage }] }],
  });

  const raw = response.content
    .map(block => block.text || '')
    .join('')
    .trim();

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

