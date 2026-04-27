/**
 * context-summary.js
 * Helpers to format and summarize context data for the LLM.
 */

export function formatOpenLots(lots) {
  if (!Array.isArray(lots)) return [];
  return lots.map(lot => ({
    created_at: lot.created_at instanceof Date ? lot.created_at.toISOString() : (lot.created_at || 'unknown'),
    remaining_qty: lot.remaining_qty,
    entry_price: lot.entry_price,
    remaining_cost_usd: lot.remaining_cost_usd,
    unrealized_pnl_usd: lot.unrealized_pnl_usd,
    unrealized_roi_pct: lot.unrealized_roi_pct
  }));
}

export function summarizeRecentSells(sells, limit = 3) {
  if (!Array.isArray(sells)) return [];
  return sells.slice(0, limit).map(s => ({
    created_at: s.created_at instanceof Date ? s.created_at.toISOString() : (s.created_at || 'unknown'),
    qty: s.qty,
    price: s.price,
    usd_amount: s.usd_amount,
    realized_pnl_usd: s.realized_pnl_usd,
    realized_roi_pct: s.realized_roi_pct,
    reasoning: s.decisionContext?.reasoning || 'No reasoning available'
  }));
}

export function formatLastSell(order) {
  if (!order || order.side !== 'sell') return null;
  const createdAt = order.created_at instanceof Date ? order.created_at : new Date(order.created_at);
  const ageMs = Date.now() - createdAt.getTime();
  const ageMinutes = Math.floor(ageMs / 60000);

  return {
    created_at: createdAt.toISOString(),
    lastSellAgeMinutes: ageMinutes,
    qty: order.qty,
    price: order.price,
    usd_amount: order.usd_amount,
    realized_pnl_usd: order.realized_pnl_usd,
    realized_roi_pct: order.realized_roi_pct,
    reasoning: order.decisionContext?.reasoning || 'No reasoning available'
  };
}

/**
 * Deeply clean objects of internal MongoDB fields or null errors.
 * Converts Date objects to ISO strings to avoid empty objects in JSON.
 */
export function cleanContextForAi(obj) {
  if (!obj) return obj;
  
  if (obj instanceof Date) {
    return obj.toISOString();
  }

  if (Array.isArray(obj)) {
    return obj.map(cleanContextForAi);
  }

  if (typeof obj === 'object') {
    const cleaned = {};
    for (const [key, val] of Object.entries(obj)) {
      // Remove internal fields that increase token usage
      if (key === '_id' || key === 'chat_id' || key === 'decision_id' || key === 'revolut_order_id' || key === 'fifo_matches') continue;
      // Skip null errors or empty risks to keep it clean
      if (val === null && (key === 'error' || key === 'risks')) continue;
      
      cleaned[key] = cleanContextForAi(val);
    }
    return cleaned;
  }

  return obj;
}

/**
 * Builds the final context object for the AI, removing unnecessary fields
 * and formatting complex objects into concise summaries.
 */
export function buildFinalContext(analyzerContext, params) {
  const { 
    openLots, 
    recentSells, 
    lastOrder, 
    openOrdersThisCoin 
  } = params;

  const recentTradingSummary = {
    recentClosedTrades: analyzerContext.tradingStats?.closedTrades || 0,
    winningTrades: analyzerContext.tradingStats?.winningTrades || 0,
    losingTrades: analyzerContext.tradingStats?.losingTrades || 0,
    winRate: analyzerContext.tradingStats?.winRate || 0,
    accumulatedRendimiento: analyzerContext.tradingStats?.accumulatedRendimiento || 0,
    recentSells: summarizeRecentSells(recentSells, 3),
    lastSell: formatLastSell(lastOrder),
  };

  const normalizeSide = (side) => {
    const s = String(side || '').toUpperCase();
    if (s === 'BUYI') return 'BUY';
    return s;
  };

  const analyzerContextForAi = {
    ...analyzerContext,
    openLots: formatOpenLots(openLots),
    openOrders: (openOrdersThisCoin || []).map(o => ({
      id: o.revolut_order_id || o.id,
      symbol: o.symbol,
      side: normalizeSide(o.side),
      qty: o.qty,
      type: o.type,
      created_at: o.created_at
    })),
    recentTradingSummary,
    // Explicitly remove heavy/redundant fields
    recentSells: undefined,
    lastExecutedOrder: undefined,
  };

  return cleanContextForAi(analyzerContextForAi);
}
