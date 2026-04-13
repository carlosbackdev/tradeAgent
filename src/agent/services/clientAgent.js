
/**
 * agent/context/prompt.js
 * System prompt and Anthropic client for the analyzer.
*/
import { SYSTEM_PROMPT } from '../context/prompt.js';
import Anthropic from '@anthropic-ai/sdk';
import { buildAnalyzerMessage } from '../context/analyzer-market.js';

export const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function callAgentAnalyzer(context) {
  const userMessage = buildAnalyzerMessage(context);

 const response = await client.messages.create({
    model:      process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
    max_tokens: 600,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: userMessage }],
  });
  

   const raw = response.content
    .map(block => block.text || '')
    .join('')
    .trim();

  try {
    return JSON.parse(raw);
  } 
  catch {
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/```$/, '')
      .trim();

    return JSON.parse(cleaned);
  }
}
