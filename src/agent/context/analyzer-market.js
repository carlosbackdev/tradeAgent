/**
 * agent/analyzer service
 */

export function buildAnalyzerMessage(context) {
  return `
UTC: ${new Date().toISOString()}

BALANCES:
${JSON.stringify(context.balances, null, 2)}

OPEN ORDERS COUNT: ${context.openOrders}

MARKET DATA:
${JSON.stringify(context.pairs, null, 2)}

INDICATORS:
${JSON.stringify(context.indicators, null, 2)}

PREVIOUS DECISIONS:
${Object.keys(context.previousDecisions || {}).length > 0
  ? JSON.stringify(context.previousDecisions, null, 2)
  : 'None — first analysis.'}

CONSTRAINTS:
MAX_TRADE_SIZE=${process.env.MAX_TRADE_SIZE},
MIN_ORDER=${process.env.MIN_ORDER},
DRY_RUN=${process.env.DRY_RUN}
`.trim();
}