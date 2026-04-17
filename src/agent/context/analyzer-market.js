/**
 * agent/analyzer service
 */

import { config } from '../../config/config.js';

export function buildAnalyzerMessage(context) {
  // Build a proper JSON structure that Claude can parse easily
  const analysisData = {
    timestamp: new Date().toISOString(),
    balances: context.balances || {},
    openOrders: Array.isArray(context.openOrders) ? context.openOrders : [],
    marketData: context.pairs || [],
    indicators: context.indicators || {},
    previousDecisions: context.previousDecisions || {},
    lastExecutedOrder: context.lastExecutedOrder || null,
    rendimiento: context.rendimiento !== undefined ? context.rendimiento : null,
    constraints: {
      MAX_TRADE_SIZE: config.trading.maxTradeSize,
      MIN_ORDER: config.trading.minOrderUsd,
      DRY_RUN: config.debug.dryRun,
      TAKE_PROFIT_PCT: config.trading.takeProfitPct,
      STOP_LOSS_PCT: config.trading.stopLossPct,
    },
  };

  return JSON.stringify(analysisData, null, 2);
}