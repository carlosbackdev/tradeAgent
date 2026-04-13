/**
 * agent/analyzer service
 */

export function buildAnalyzerMessage(context) {
  // Build a proper JSON structure that Claude can parse easily
  const analysisData = {
    timestamp: new Date().toISOString(),
    balances: context.balances || {},
    openOrders: Array.isArray(context.openOrders) ? context.openOrders : [],
    marketData: context.pairs || [],
    indicators: context.indicators || {},
    previousDecisions: context.previousDecisions || {},
    constraints: {
      MAX_TRADE_SIZE: parseFloat(process.env.MAX_TRADE_SIZE || '1'),
      MIN_ORDER: parseFloat(process.env.MIN_ORDER || '5'),
      DRY_RUN: process.env.DRY_RUN === 'true',
    },
  };

  return analysisData;
}