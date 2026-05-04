/**
 * services/mongo/decision-persistence-service.js
 * Encapsulates decision persistence logic for one executor cycle.
 */

import { saveDecision } from './mongo-service.js';
import { logger } from '../../utils/logger.js';
import { resolveEffectiveTpSl } from '../../agent/policies/effective-trading-config.js';

export class DecisionPersistenceService {
  static async saveCycleDecisions({
    dbConnected = false,
    decisions = [],
    indicators = {},
    effectiveConfig,
    rendimiento = null,
    usedModel = null,
    marketSummary = '',
    triggerReason = 'cron',
    chatId = null
  }) {
    if (!dbConnected || !Array.isArray(decisions) || decisions.length === 0) {
      return decisions;
    }

    for (const d of decisions) {
      if (!d?.symbol) continue;

      const symbolForPrice = d.symbol.replace('/', '-');
      const currentPrice = indicators[symbolForPrice]?.currentPrice;

      if (currentPrice && d.action !== 'HOLD') {
        const { takeProfitPct: tpPct, stopLossPct: slPct } = resolveEffectiveTpSl(effectiveConfig?.trading);

        if (d.action === 'BUY') {
          if (tpPct > 0) d.takeProfit = (currentPrice * (1 + tpPct / 100)).toFixed(2);
          if (slPct > 0) d.stopLoss = (currentPrice * (1 - slPct / 100)).toFixed(2);
        }
      }

      try {
        const saved = await saveDecision({
          symbol: d.symbol,
          action: d.action,
          confidence: d.confidence,
          reasoning: d.reasoning || '',
          summaryReasoning: d.summaryReasoning || buildSummaryReasoning(d),
          marketSummary: marketSummary || '',
          risks: d.risks || '',
          positionPct: parseFloat(d.positionPct) || 0,
          currentPrice: currentPrice || null,
          usdAmount: parseFloat(d.usdAmount) || 0,
          orderType: d.orderType || 'market',
          takeProfit: d.takeProfit || null,
          stopLoss: d.stopLoss || null,
          rendimiento: rendimiento !== null ? rendimiento : null,
          model: usedModel || null,
          forced: d.forced === true,
          forcedReason: d.forcedReason || null,
          defensive: d.defensive === true,
          defensiveReason: d.defensiveReason || null,
          lifecyclePhase: d.lifecyclePhase || null,
          riskFactors: d.riskFactors || [],
          maxRoiSeen: d.maxRoiSeen,
          currentRoi: d.currentRoi,
          profitRetracementPct: d.profitRetracementPct,
          positionLifecyclePhase: d.positionLifecyclePhase || null,
          fifoMatched: typeof d.fifoMatched === 'boolean' ? d.fifoMatched : null,
        }, triggerReason, chatId);

        d.mongoDecisionId = saved?._id;
      } catch (err) {
        logger.warn(`⚠️  Failed to save decision for ${d.symbol}: ${err.message}`);
      }
    }

    return decisions;
  }
}

function buildSummaryReasoning(decision) {
  if (!decision) return null;
  if (decision.summaryReasoning) return decision.summaryReasoning;

  if (decision.defensiveReason) {
    return `SELL defensivo por ${String(decision.defensiveReason).replaceAll('_', ' ').toLowerCase()}`;
  }

  const action = String(decision.action || 'HOLD').toUpperCase();
  return `${action} por evaluación de contexto`;
}
