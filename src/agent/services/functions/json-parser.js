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
