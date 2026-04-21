/**
 * agent/analyzer service
 */

import { config } from '../../config/config.js';

export function buildAnalyzerMessage(context, question = '') {

  const usableBalances = JSON.parse(JSON.stringify(context.balances || {}));

  if (usableBalances.usd) {
    usableBalances.usd = parseFloat((usableBalances.usd * 0.99).toFixed(2));
  }

  if (usableBalances.crypto) {
    for (const coin in usableBalances.crypto) {
      if (usableBalances.crypto[coin].estimatedUsdValue) {
        usableBalances.crypto[coin].amount = usableBalances.crypto[coin].amount * 0.99;
        usableBalances.crypto[coin].estimatedUsdValue = parseFloat((usableBalances.crypto[coin].estimatedUsdValue * 0.99).toFixed(2));
      }
    }
  }

  const analysisData = {
    timestamp: new Date().toISOString(),
    balances: usableBalances,
    openOrders: Array.isArray(context.openOrders) ? context.openOrders : [],
    marketData: context.pairs || [],
    indicators: context.indicators || {},
    previousDecisions: context.previousDecisions || {},
    openLots: context.openLots || [],
    recentSells: context.recentSells || [],
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

  if (question != '') {
    analysisData.question = 'User extra question: ' + question;
  }

  return JSON.stringify(analysisData, null, 2);
}