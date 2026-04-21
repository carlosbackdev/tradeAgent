/**
 * open-orders-analyzer-prompt.js
 * Constructs prompts and context for Claude to analyze open orders
 * Follows the same pattern as buildAnalyzerMessage for consistency
 */

import { getOpenOrderSystemPrompt } from '../prompts/open-orders-system-prompt.js';

/**
 * Build enriched analysis context for open order
 * @param {Object} openOrder - The open order
 * @param {Object} analyzerContext - Full trading context (indicators, balances, history, etc.)
 * @param {string} symbol - Trading symbol
 * @returns {Object} Enriched context for Claude
 */
export function buildOpenOrderAnalysisContext(openOrder, analyzerContext, symbol) {
  const currentPrice = analyzerContext.lastPrice || analyzerContext.indicators?.[symbol]?.currentPrice || 0;
  const indicators = analyzerContext.indicators?.[symbol] || {};

  const orderContext = {
    symbol,
    order_type: openOrder.orderType || openOrder.order_type || 'market',
    side: openOrder.side || 'buy',
    quantity: openOrder.quantity || openOrder.qty || 0,
    price: openOrder.price || currentPrice,
    current_price: currentPrice,
    status: openOrder.state || openOrder.status || 'pending',
    created_at: openOrder.created_at || new Date().toISOString(),
  };

  const priceDiff = ((currentPrice - orderContext.price) / orderContext.price * 100).toFixed(2);

  const balances = analyzerContext.balances || {};
  const usdBalance = parseFloat(
    balances.find ? balances.find(b => b.currency === 'USD')?.total
    : (balances.USD?.total ?? balances.USD ?? 0)
  ) || 0;

  return {
    open_order: orderContext,
    price_diff_pct: parseFloat(priceDiff),
    usd_available_for_buy: parseFloat(usdBalance.toFixed(2)),
    rendimiento_pct: analyzerContext.rendimiento ?? null,
    market_conditions: {
      current_price: currentPrice,
      rsi_14: indicators.rsi14 || null,
      macd_line: indicators.macdLine || null,
      macd_signal: indicators.macdSignal || null,
      macd_histogram: indicators.macdHistogram || null,
      ema_20: indicators.ema20 || null,
      ema_50: indicators.ema50 || null,
      sma_200: indicators.sma200 || null,
      bb_upper: indicators.bbUpper || null,
      bb_lower: indicators.bbLower || null,
      bb_mid: indicators.bbMid || null,
      confluence: indicators.confluence || null,
    },
    trading_history: analyzerContext.previousDecisions?.[symbol] || [],
    account_balance: analyzerContext.balances || {},
  };
}

/**
 * Build user message for open order analysis
 * @param {Object} openOrderContext - Result from buildOpenOrderAnalysisContext
 * @param {string} symbol - Trading symbol
 * @returns {string} JSON string message for Claude
 */
export function buildOpenOrderAnalysisMessage(openOrderContext, symbol) {
  const { open_order, price_diff_pct, market_conditions, trading_history } = openOrderContext;

  const historyText = trading_history.length > 0
    ? trading_history.map(d =>
      `- ${d.action.toUpperCase()}: ${d.confidence}% confidence - "${d.reasoning}"`
    ).join('\n')
    : '- No previous decisions';

  const analysisData = {
    timestamp: new Date().toISOString(),
    analysis_type: 'open_order_decision',
    symbol,
    open_order: {
      order_type: open_order.order_type,
      side: open_order.side,
      quantity: open_order.quantity,
      placed_at_price: open_order.price,
      status: open_order.status,
    },
    market_state: {
      current_price: market_conditions.current_price,
      price_moved_pct: price_diff_pct,
      rsi_14: market_conditions.rsi_14,
      macd_line: market_conditions.macd_line,
      ema_20: market_conditions.ema_20,
      ema_50: market_conditions.ema_50,
      bb_upper: market_conditions.bb_upper,
      bb_lower: market_conditions.bb_lower,
      confluence: market_conditions.confluence,
    },
    position_info: {
      rendimiento_pct: openOrderContext.rendimiento_pct,
      usd_available_for_buy: openOrderContext.usd_available_for_buy,
    },
    previous_decisions_for_symbol: historyText,
    your_task: 'Decide: keep, cancel, or buy_more? Use positionPct (0-1) for buy_more sizing.',
  };

  return JSON.stringify(analysisData, null, 2);
}
