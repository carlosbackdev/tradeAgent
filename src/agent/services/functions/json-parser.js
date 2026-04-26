/**
 * agent/services/functions/json-parser.js
 * Robustly parse raw JSON from any LLM response.
 */

import { logger } from '../../../utils/logger.js';

/**
 * Robustly parse raw JSON from any LLM response.
 * @param {string} raw - Raw text returned by the model
 * @returns {Object}
 */
export function parseLlmJsonResponse(raw) {
  if (!raw) throw new Error('LLM returned an empty response');
  
  const cleanedRaw = raw.trim();
  
  // 1. Direct attempt
  try {
    return JSON.parse(cleanedRaw);
  } catch (_) {
    // Continue to more robust methods
  }

  logger.debug('Direct JSON parse failed, attempting deep cleanup and repair…');
  
  const firstBrace = cleanedRaw.indexOf('{');
  const lastBrace = cleanedRaw.lastIndexOf('}');

  // 2. Try to extract between first and last brace (handles extra text around JSON)
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = cleanedRaw.substring(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {
      // If it fails, maybe it's just markdown?
      const noMarkdown = candidate.replace(/```json\s?|```/gi, '').trim();
      try { return JSON.parse(noMarkdown); } catch (e2) {}
    }
  }

  // 3. Attempt to repair truncated JSON (handles missing closing braces/brackets)
  if (firstBrace !== -1) {
    logger.warn('JSON appears truncated or malformed, attempting auto-repair...');
    
    // Start from the first brace
    let candidate = cleanedRaw.substring(firstBrace);
    
    // Remove markdown if present at the start
    candidate = candidate.replace(/```json\s?|```/gi, '').trim();
    
    // Remove trailing junk that often appears in truncated responses
    // (like "...", or a trailing comma)
    candidate = candidate.replace(/(\.|\,)+$/, '').trim();

    // Robustly close open braces and brackets
    let stack = [];
    let inString = false;
    let escaped = false;
    
    for (let i = 0; i < candidate.length; i++) {
      const char = candidate[i];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (!inString) {
        if (char === '{' || char === '[') stack.push(char);
        else if (char === '}' || char === ']') {
          if (stack.length > 0) {
            const last = stack[stack.length - 1];
            if ((char === '}' && last === '{') || (char === ']' && last === '[')) {
              stack.pop();
            }
          }
        }
      }
    }

    let repaired = candidate;
    if (inString) repaired += '"';
    
    while (stack.length > 0) {
      const last = stack.pop();
      if (last === '{') repaired += '}';
      else if (last === '[') repaired += ']';
    }

    try {
      return JSON.parse(repaired);
    } catch (e) {
      logger.debug(`Auto-repair failed: ${e.message}`);
    }
  }

  throw new Error(`No valid JSON object found in response: ${cleanedRaw.substring(0, 100)}...`);
}

// Keep old export name as alias for backward compatibility
export const parseClaudeJsonResponse = parseLlmJsonResponse;
