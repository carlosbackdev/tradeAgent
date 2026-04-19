/**
 * context/open-order-analyzer.js
 * Analyzes open orders using Claude AI with full trading context
 */

import { logger } from '../../utils/logger.js';
import { callClaudeWithCustomPrompt } from '../services/clientAgent.js';
import {
  buildOpenOrderAnalysisContext,
  buildOpenOrderAnalysisMessage,
} from './open-orders-analyzer-prompt.js';
import { getOpenOrderSystemPrompt } from './prompts/open-orders-system-prompt.js';

/**
 * Ask Claude AI whether to keep, cancel, or add more to an open order
 * Uses full analyzer context for enriched decision-making
 * Reuses callClaudeWithCustomPrompt to avoid duplicating JSON parsing logic
 * @param {Object} openOrder - The open order object
 * @param {Object} analyzerContext - Full trading context (indicators, balances, history, etc.)
 * @param {string} symbol - Trading symbol
 * @returns {Promise<Object>} Decision: { action: 'keep'|'cancel'|'buy_more', reasoning: string, confidence: number, buy_more_quantity: number }
 */
export async function analyzeOpenOrderWithClaude(openOrder, analyzerContext, symbol) {
  try {
    logger.info(`🤖 Analyzing open order for ${symbol} with Claude...`);

    // Build analysis context using shared prompt module
    const analysisContext = buildOpenOrderAnalysisContext(openOrder, analyzerContext, symbol);
    const userMessage = buildOpenOrderAnalysisMessage(analysisContext, symbol);
    const systemPrompt = getOpenOrderSystemPrompt();

    // Call Claude - reuses robust JSON parsing from clientAgent
    const decision = await callClaudeWithCustomPrompt(userMessage, systemPrompt);

    if (!decision || !decision.action) {
      logger.warn(`⚠️ Invalid Claude response for order analysis: missing action field`);
      return { action: 'keep', reasoning: 'Invalid response from Claude', confidence: 20, buy_more_quantity: 0 };
    }

    // Normalize action: handle uppercase, spaces, dashes
    const normalizedAction = (decision.action || '').toLowerCase().trim().replace(/\s+/g, '_');
    
    // Validate action is one of expected values
    if (!['keep', 'cancel', 'buy_more'].includes(normalizedAction)) {
      logger.warn(`⚠️ Claude returned unexpected action: "${decision.action}" → defaulting to KEEP`);
      return { action: 'keep', reasoning: `Unexpected action "${decision.action}": ${decision.reasoning}`, confidence: 30, buy_more_quantity: 0 };
    }

    // Parse and validate confidence
    let confidence = parseInt(decision.confidence) || 50;
    confidence = Math.max(0, Math.min(100, confidence)); // Clamp 0-100
    
    // Parse buy_more_quantity
    let buyMoreQty = 0;
    if (normalizedAction === 'buy_more' && decision.buy_more_quantity) {
      buyMoreQty = Math.max(0, parseFloat(decision.buy_more_quantity) || 0);
    }

    logger.info(`🤖 Claude decision: ${normalizedAction} (confidence: ${confidence}% | qty: ${buyMoreQty})`);
    
    return {
      action: normalizedAction,
      reasoning: decision.reasoning || 'No reasoning provided',
      confidence,
      buy_more_quantity: buyMoreQty,
    };
  } catch (err) {
    logger.error(`❌ Claude analysis failed: ${err.message}`);
    return { action: 'keep', reasoning: 'Analysis error, keeping order safe', confidence: 25, buy_more_quantity: 0 };
  }
}
