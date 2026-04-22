/**
 * src/agent/context/open-order-analyzer.js
 * Analyzes open orders using Claude AI. Multi-user support.
 */

import { logger } from '../../utils/logger.js';
import { callClaudeWithCustomPrompt } from '../services/clientAgent.js';
import {
  buildOpenOrderAnalysisContext,
  buildOpenOrderAnalysisMessage,
} from './formatters/build-open-orders-analyzer.js';
import { getOpenOrderSystemPrompt } from './prompts/open-orders-system-prompt.js';

/**
    },
 * Ask Claude AI whether to keep, cancel, or add more to an open order
 */
export async function analyzeOpenOrderWithClaude(openOrder, analyzerContext, symbol, apiKey, model, tradingConfig) {
  
  try {
    logger.info(`🤖 Analyzing open order for ${symbol} with Claude...`);

    const analysisContext = buildOpenOrderAnalysisContext(openOrder, analyzerContext, symbol, tradingConfig);
    const userMessage = buildOpenOrderAnalysisMessage(analysisContext, symbol, tradingConfig);
    const systemPrompt = getOpenOrderSystemPrompt(tradingConfig);
    
    logger.info(`📨 OPEN ORDER ANALYZER → Claude payload (3-layer):\n${userMessage}`);

    const decision = await callClaudeWithCustomPrompt(userMessage, apiKey, model, tradingConfig, systemPrompt);
    const payload = Array.isArray(decision?.decisions) ? decision.decisions[0] : decision;

    if (!payload || !payload.action) {
      return { action: 'keep', reasoning: 'Invalid response from Claude', confidence: 20 };
    }

    const normalizedAction = String(payload.action || '').toLowerCase().trim().replace(/\s+/g, '_');

    if (!['keep', 'cancel', 'buy_more'].includes(normalizedAction)) {
      return { action: 'keep', reasoning: `Unexpected action "${payload.action}"`, confidence: 30 };
    }

    return {
      action: normalizedAction,
      reasoning: payload.reasoning || 'No reasoning provided',
      confidence: Math.max(0, Math.min(100, parseInt(payload.confidence) || 50)),
      positionPct: Math.max(0, Math.min(1, Number(payload.positionPct) || 0)),
      buy_more_quantity: Math.max(0, parseFloat(payload.buy_more_quantity ?? decision?.buy_more_quantity) || 0),
    };

  } catch (err) {

    logger.error(`❌ Claude analysis failed: ${err.message}`);

    return { action: 'keep', reasoning: 'Analysis error', confidence: 25 };
  }
}
