/**
 * agent/services/functions/analyzer-context-enricher.js
 * Enriches analyzer context with lifecycle and compact portfolio state.
 */

import { getActivePositionLifecycleStates, updatePositionLifecycleState } from '../../../services/mongo/mongo-service.js';
import { logger } from '../../../utils/logger.js';

export class AnalyzerContextEnricher {
  static async enrich({
    analyzerContext,
    previousDecisionsBySymbol,
    openPositionSummary,
    rendimiento,
    crossSymbolRecentOpenBuy,
    lookbackMinutes,
    snapshotSymbol,
    indicators,
    higherTfIndicators,
    crossTfConfluence,
    dbConnected = false,
    chatId = null,
    minOrderUsd = 0
  }) {
    analyzerContext.previousDecisions = previousDecisionsBySymbol;
    analyzerContext.openLots = withLotSymbol(openPositionSummary?.openLots || [], snapshotSymbol);
    analyzerContext.rendimiento = rendimiento;
    analyzerContext.rendimientoAcumulado = analyzerContext.tradingStats?.accumulatedRendimiento ?? null;
    analyzerContext.crossSymbolRecentOpenBuy = crossSymbolRecentOpenBuy;
    analyzerContext.NextAnalysis = lookbackMinutes;

    const lastPrice = previousDecisionsBySymbol?.[snapshotSymbol]?.[0]?.price || 0;
    const currentPrice = indicators?.[snapshotSymbol]?.currentPrice || 0;

    analyzerContext.currentPrice = currentPrice;
    analyzerContext.lastPrice = lastPrice;
    analyzerContext.priceChangeSinceLastAnalysisPct = (lastPrice > 0 && currentPrice > 0)
      ? parseFloat((((currentPrice - lastPrice) / lastPrice) * 100).toFixed(2))
      : 0;

    if (higherTfIndicators) {
      analyzerContext.higherTimeframe = {
        interval: `${higherTfIndicators.interval}min`,
        confluence: higherTfIndicators.confluence,
        rsi14: higherTfIndicators.rsi14,
        bbPosition: higherTfIndicators.bbPosition,
        note: 'Macro trend context - entry decisions should align with this'
      };
    }

    analyzerContext.crossTfConfluence = crossTfConfluence;

    const lifecycleCurrentPrice = indicators?.[snapshotSymbol]?.currentPrice || currentPrice || 0;
    let lifecycleState = null;

    if (dbConnected) {
      try {
        lifecycleState = await updatePositionLifecycleState({
          symbol: snapshotSymbol,
          chatId,
          positionSummary: openPositionSummary,
          currentPrice: lifecycleCurrentPrice,
          minOrderUsd
        });
      } catch (err) {
        logger.warn(`Failed to update lifecycle state for ${snapshotSymbol}: ${err.message}`);
      }
    }

    analyzerContext.positionLifecycle = {
      [snapshotSymbol]: lifecycleState || buildNoPositionLifecycle(snapshotSymbol, lifecycleCurrentPrice)
    };

    analyzerContext.lastSellSummary = buildLastSellSummary(previousDecisionsBySymbol?.[snapshotSymbol] || []);
    analyzerContext.lastBuySummary = buildLastBuySummary(previousDecisionsBySymbol?.[snapshotSymbol] || []);

    const { otherOpenPositions, highRiskOpenPositionsCount, totalManagedCryptoUsd } = await buildOtherOpenPositions({
      analyzerContext,
      indicators,
      snapshotSymbol,
      dbConnected,
      chatId
    });

    analyzerContext.otherOpenPositions = otherOpenPositions;
    analyzerContext.totalManagedOpenPositions = Array.isArray(analyzerContext?.tradingStats?.openPositions)
      ? analyzerContext.tradingStats.openPositions.length
      : 0;
    analyzerContext.totalManagedCryptoUsd = totalManagedCryptoUsd;
    analyzerContext.highRiskOpenPositionsCount = highRiskOpenPositionsCount;

    return {
      lifecycleState,
      currentPrice,
      lastPrice,
      lifecycleCurrentPrice
    };
  }
}

async function buildOtherOpenPositions({ analyzerContext, indicators, snapshotSymbol, dbConnected, chatId }) {
  const openPositions = Array.isArray(analyzerContext?.tradingStats?.openPositions)
    ? analyzerContext.tradingStats.openPositions
    : [];
  const normalizedCurrent = normalizeSymbol(snapshotSymbol);
  const basePositions = openPositions
    .filter((p) => normalizeSymbol(p.symbol) !== normalizedCurrent)
    .slice(0, 10);

  let lifecycleBySymbol = {};
  if (dbConnected) {
    try {
      const lifecycleRows = await getActivePositionLifecycleStates(chatId, {
        excludeSymbol: snapshotSymbol,
        limit: 20
      });
      lifecycleBySymbol = lifecycleRows.reduce((acc, row) => {
        acc[normalizeSymbol(row.symbol)] = row;
        return acc;
      }, {});
    } catch (err) {
      logger.warn(`Failed to fetch lifecycle states for other positions: ${err.message}`);
    }
  }

  const otherOpenPositions = basePositions.map((pos) => {
    const normalized = normalizeSymbol(pos.symbol);
    const lifecycle = lifecycleBySymbol[normalized] || null;
    const symbolCurrentPrice = Number(indicators?.[normalized]?.currentPrice || 0);
    const estimatedUsdValue = symbolCurrentPrice > 0
      ? Number((Number(pos.qty || 0) * symbolCurrentPrice).toFixed(2))
      : Number(pos.totalCost || 0);

    return {
      symbol: normalized,
      qty: Number(pos.qty || 0),
      avgPrice: Number(pos.avgPrice || 0),
      estimatedUsdValue,
      currentRoiPct: toNumber(lifecycle?.current_roi_pct, null),
      maxRoiSeen: toNumber(lifecycle?.max_unrealized_roi_pct, null),
      profitRetracementPct: toNumber(lifecycle?.profit_retracement_pct, null),
      phase: lifecycle?.phase || null,
      lastAction: lifecycle?.last_action || null,
      cooldownUntil: lifecycle?.cooldown_until || null,
      riskFactors: Array.isArray(lifecycle?.risk_factors) ? lifecycle.risk_factors : []
    };
  }).slice(0, 10);

  const highRiskOpenPositionsCount = otherOpenPositions.filter((p) =>
    ['IN_DRAWDOWN', 'PROFIT_RETRACEMENT', 'THESIS_INVALIDATION', 'RESIDUAL_DUST'].includes(String(p.phase || '')) ||
    (Array.isArray(p.riskFactors) && p.riskFactors.length >= 3)
  ).length;

  const totalManagedCryptoUsd = Number(openPositions
    .map((p) => {
      const normalized = normalizeSymbol(p.symbol);
      const currentPrice = Number(indicators?.[normalized]?.currentPrice || 0);
      return currentPrice > 0
        ? Number((Number(p.qty || 0) * currentPrice).toFixed(2))
        : Number(p.totalCost || 0);
    })
    .reduce((sum, usd) => sum + Number(usd || 0), 0)
    .toFixed(2));

  return { otherOpenPositions, highRiskOpenPositionsCount, totalManagedCryptoUsd };
}

function buildLastSellSummary(history) {
  const lastSell = (history || []).find((d) => String(d.action || '').toUpperCase() === 'SELL');
  if (!lastSell) return null;

  return {
    timestamp: lastSell.timestamp,
    confidence: lastSell.confidence ?? null,
    summaryReasoning: lastSell.summaryReasoning || null
  };
}

function buildLastBuySummary(history) {
  const lastBuy = (history || []).find((d) => String(d.action || '').toUpperCase() === 'BUY');
  if (!lastBuy) return null;

  return {
    timestamp: lastBuy.timestamp,
    confidence: lastBuy.confidence ?? null,
    summaryReasoning: lastBuy.summaryReasoning || null
  };
}

function withLotSymbol(lots, symbol) {
  const normalized = normalizeSymbol(symbol);
  return (lots || []).map((lot) => ({
    ...lot,
    symbol: normalizeSymbol(lot.symbol || normalized)
  }));
}

function buildNoPositionLifecycle(symbol, currentPrice) {
  return {
    symbol: normalizeSymbol(symbol),
    phase: 'NO_POSITION',
    current_roi_pct: 0,
    max_unrealized_roi_pct: 0,
    profit_retracement_pct: 0,
    total_qty: 0,
    avg_entry_price: 0,
    current_price: currentPrice,
    estimated_usd_value: 0,
    is_residual: false,
    is_below_min_order: false,
    cooldown_until: null,
    last_defensive_sell_at: null,
    last_exit_at: null
  };
}

function normalizeSymbol(symbol) {
  return String(symbol || '').replace('/', '-').toUpperCase();
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
