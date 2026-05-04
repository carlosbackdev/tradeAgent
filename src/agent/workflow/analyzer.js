/**
 * workflow/analyzer.js
 * Decision layer: prepares LLM payload, calls model, and returns trading intent.
 */

import { clientAgentInstance } from '../job/client-agent-main.js';
import { callAgentWithFallback, isFallbackChainEnabled } from '../services/fallback-chain.js';
import { buildAnalyzerMessage } from '../context/analyzer-market.js';
import { buildFinalContext } from '../context/formatters/context-summary.js';
import { logger } from '../../utils/logger.js';
import { resolveEffectiveTpSl } from '../policies/effective-trading-config.js';

export async function analyzeTradingIntent({
  forcedDecision = null,
  analyzerContext,
  openPositionSummary,
  openOrdersThisCoin = [],
  question = '',
  effectiveConfig,
  coin
}) {
  if (forcedDecision) {
    return { decisions: [forcedDecision], marketSummary: '', usedModel: null };
  }

  const payload = buildAnalyzerMessage(
    buildFinalContext(analyzerContext, {
      openLots: openPositionSummary?.openLots,
      openOrdersThisCoin
    }),
    question,
    effectiveConfig.trading,
    coin
  );

  let decision = null;
  if (isFallbackChainEnabled(effectiveConfig)) {
    logger.info('🔗 Usando fallback chain para LLM analysis');
    decision = await callAgentWithFallback(payload, effectiveConfig, effectiveConfig.trading);
  } else {
    const llmCfg = effectiveConfig.llm;
    decision = await clientAgentInstance.callAgentAnalyzer(
      payload,
      llmCfg.apiKey,
      llmCfg.model,
      effectiveConfig.trading,
      llmCfg
    );
  }

  const decisions = Array.isArray(decision?.decisions) ? decision.decisions : [];
  const { takeProfitPct, stopLossPct } = resolveEffectiveTpSl(effectiveConfig.trading);
  for (const d of decisions) {
    d.takeProfit = d.takeProfit || takeProfitPct;
    d.stopLoss = d.stopLoss || stopLossPct;
  }

  return decision;
}
