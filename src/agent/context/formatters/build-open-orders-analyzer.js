/**
 * open-orders-analyzer-prompt.js
 * Constructs prompts and context for Claude to analyze open orders
 * Uses 3-layer structure (exchangeTruth, botState, decisionContext) like main analyzer
 */

/**
 * Build enriched analysis context for open order (3-layer structure)
 * @param {Object} openOrder - The open order
 * @param {Object} analyzerContext - Full trading context
 * @param {string} symbol - Trading symbol
 * @returns {Object} Enriched context for Claude with 3-layer structure
 */
export function buildOpenOrderAnalysisContext(openOrder, analyzerContext, symbol, tradingConfig = null) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const currentPrice = toNumber(
    analyzerContext.currentPrice ||
    analyzerContext.indicators?.[normalizedSymbol]?.currentPrice ||
    analyzerContext.indicators?.[symbol]?.currentPrice ||
    0,
    0
  );
  const indicators = analyzerContext.indicators?.[normalizedSymbol] || analyzerContext.indicators?.[symbol] || {};

  const createdAtRaw = openOrder.created_at
    ?? openOrder.createdAt
    ?? openOrder.created_date
    ?? openOrder.updated_date
    ?? openOrder.timestamp
    ?? openOrder.created
    ?? null;
  const createdAtMs = toTimestampMs(createdAtRaw);
  const orderAgeMinutes = createdAtMs ? Math.max(0, Math.round((Date.now() - createdAtMs) / 60000)) : null;

  const orderContext = {
    symbol,
    order_type: openOrder.orderType || openOrder.order_type || 'market',
    side: openOrder.side || 'buy',
    quantity: toNumber(openOrder.quantity ?? openOrder.qty ?? 0, 0),
    placed_at_price: toNumber(openOrder.price ?? openOrder.limit_price ?? currentPrice, currentPrice),
    current_price: currentPrice,
    status: openOrder.state || openOrder.status || 'pending',
    created_at: openOrder.created_at || new Date().toISOString(),
  };

  const priceDiff = orderContext.placed_at_price
    ? ((currentPrice - orderContext.placed_at_price) / orderContext.placed_at_price * 100)
    : 0;

  const balances = analyzerContext.balances || {};
  const usdBalance = parseFloat(balances.fiat?.USD ?? balances.crypto?.USD?.amount ?? 0) || 0;

  const pair = (analyzerContext.pairs || []).find(p => normalizeSymbol(p.symbol) === normalizedSymbol);
  const bestBid = pair?.orderBookTop?.bestBid?.price ?? null;
  const bestAsk = pair?.orderBookTop?.bestAsk?.price ?? null;
  const spreadAbs = (bestBid && bestAsk) ? Number((bestAsk - bestBid).toFixed(4)) : null;
  const spreadPct = (spreadAbs && bestBid) ? Number(((spreadAbs / bestBid) * 100).toFixed(3)) : null;

  return {
    open_order: orderContext,
    order_age_minutes: orderAgeMinutes,
    price_moved_pct: parseFloat(priceDiff.toFixed(2)),
    spread_abs: spreadAbs,
    spread_pct: spreadPct,
    usd_available: parseFloat(usdBalance.toFixed(2)),
    rendimiento_pct: analyzerContext.rendimiento ?? null,
    indicators_snapshot: {
      rsi_14: toNumber(indicators.rsi14),
      macd_line: toNumber(indicators.macdLine),
      macd_signal: toNumber(indicators.macdSignal),
      macd_histogram: toNumber(indicators.macdHistogram),
      ema_12: toNumber(indicators.ema12),
      ema_26: toNumber(indicators.ema26),
      sma_20: toNumber(indicators.sma20),
      bb_upper: toNumber(indicators.bbUpper),
      bb_middle: toNumber(indicators.bbMid ?? indicators.bbMiddle),
      bb_lower: toNumber(indicators.bbLower),
      confluence: indicators.confluence || null,
    },
    trading_constraints: {
      MAX_TRADE_SIZE: Number(tradingConfig?.maxTradeSize ?? 0.25),
      MIN_ORDER: Number(tradingConfig?.minOrderUsd ?? 0),
      TAKE_PROFIT_PCT: Number(tradingConfig?.takeProfitPct ?? 0),
      STOP_LOSS_PCT: Number(tradingConfig?.stopLossPct ?? 0),
    },
    trading_history: analyzerContext.previousDecisions?.[normalizedSymbol] || analyzerContext.previousDecisions?.[symbol] || [],
    open_lots: analyzerContext.openLots || [],
  };
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toTimestampMs(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').replace('/', '-').toUpperCase();
}


/**
 * Build user message for open order analysis using 3-layer structure
 * Focused on: 1) The open order state, 2) Current bot position/holdings, 3) Technical decision factors
 */
export function buildOpenOrderAnalysisMessage(openOrderContext, symbol, tradingConfig = null) {
  const {
    open_order,
    price_moved_pct,
    spread_abs,
    spread_pct,
    order_age_minutes,
    indicators_snapshot,
    trading_constraints,
    trading_history,
    open_lots,
    usd_available,
    rendimiento_pct,
  } = openOrderContext;

  const placedAtPrice = toNumber(open_order.placed_at_price, 0);
  const quantity = toNumber(open_order.quantity, 0);
  const currentPrice = toNumber(open_order.current_price, 0);
  const priceMovedPct = toNumber(price_moved_pct, 0);
  const rendimiento = rendimiento_pct !== null ? toNumber(rendimiento_pct, null) : null;
  const orderAgeAssessment = getOrderAgeAssessment(order_age_minutes, tradingConfig);

  const analysisData = {
    timestamp: new Date().toISOString(),
    analysis_type: 'open_order_decision',
    symbol,

    exchangeTruth: {
      open_order: {
        side: open_order.side,
        type: open_order.order_type,
        placed_at_price: placedAtPrice ? parseFloat(placedAtPrice.toFixed(2)) : null,
        quantity: quantity ? parseFloat(quantity.toFixed(8)) : 0,
        age_minutes: order_age_minutes,
      },
      current_market: {
        price: currentPrice,
        price_moved_from_order_pct: parseFloat(priceMovedPct.toFixed(2)),
        spread_abs,
        spread_pct,
      },
    },

    botState: {
      position_status: {
        rendimiento_pct: rendimiento !== null ? parseFloat(rendimiento.toFixed(2)) : null,
        open_lots: open_lots.length,
        usd_available: usd_available,
      },
      recent_decisions: trading_history.slice(0, 3).map(d => ({
        action: d.action.toUpperCase(),
        confidence: d.confidence,
        atPrice: d.price,
        reasoning: d.reasoning || null,
      })) || [],
    },

    decisionContext: {
      technical_indicators: indicators_snapshot,
      order_age_assessment: orderAgeAssessment,
      spread_assessment: spread_pct
        ? (spread_pct < 0.1 ? 'Tight' : spread_pct < 0.3 ? 'Normal' : 'Wide')
        : 'Unknown',
      constraints: {
        HOLD_IF_PRICE_MOVE_LT_PCT: 0.5,
        CANCEL_IF_SPREAD_GT_PCT: 0.5,
        CANCEL_IF_CONFLUENCE_FLIPS: true,
        MAX_TRADE_SIZE: Number(trading_constraints?.MAX_TRADE_SIZE ?? tradingConfig?.maxTradeSize ?? 0.25),
        MIN_ORDER: Number(trading_constraints?.MIN_ORDER ?? tradingConfig?.minOrderUsd ?? 0),
        TAKE_PROFIT_PCT: Number(trading_constraints?.TAKE_PROFIT_PCT ?? tradingConfig?.takeProfitPct ?? 0),
        STOP_LOSS_PCT: Number(trading_constraints?.STOP_LOSS_PCT ?? tradingConfig?.stopLossPct ?? 0),
      },
    },

    your_task: 'Decide: "keep" (leave as-is), "cancel" (remove order), or "buy_more" (place additional BUY). Return action, reasoning, confidence (0-100), and positionPct if buy_more.',
  };

  return JSON.stringify(analysisData, null, 2);
}

function getOrderAgeAssessment(orderAgeMinutes, tradingConfig = null) {
  const minutes = toNumber(orderAgeMinutes, null);
  if (minutes === null || minutes < 0) return 'Unknown';

  const baseThresholds = {
    veryRecent: 15,
    recent: 180,
    maturing: 720,
  };

  const vision = String(tradingConfig?.visionAgent || 'short').toLowerCase();
  const multiplier = (vision === 'moderate' || vision === 'medium')
    ? 3
    : ((vision === 'conservative' || vision === 'long') ? 6 : 1);

  const veryRecentLimit = baseThresholds.veryRecent * multiplier;
  const recentLimit = baseThresholds.recent * multiplier;
  const maturingLimit = baseThresholds.maturing * multiplier;

  if (minutes < veryRecentLimit) return 'Very recent';
  if (minutes <= recentLimit) return 'Recent';
  if (minutes <= maturingLimit) return 'Maturing';
  return 'Aging';
}
