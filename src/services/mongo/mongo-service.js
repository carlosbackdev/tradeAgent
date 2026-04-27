/**
 * services/mongo/index.js
 * MongoDB data access functions for decisions, orders and performance.
 */

import { ObjectId } from 'mongodb';
import { logger } from '../../utils/logger.js';
import { connectDB, disconnectDB, getDB } from './client.js';

function withActiveOrders(filter = {}) {
  if (filter.status === 'cancelled') return filter;

  const activeClause = { status: { $ne: 'cancelled' } };
  if (Object.prototype.hasOwnProperty.call(filter, 'status')) {
    return { $and: [activeClause, filter] };
  }
  return { ...filter, ...activeClause };
}

function safeParse(val) {
  const p = parseFloat(val);
  return Number.isNaN(p) ? null : p;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').replace('/', '-').toUpperCase();
}

function toNullableNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function resolvePositionQty(positionSummary = {}) {
  return Number(
    positionSummary?.totalOpenQty ??
    positionSummary?.totalQty ??
    positionSummary?.qty ??
    0
  );
}

export {
  connectDB,
  disconnectDB,
  getDB,
};

export async function saveDecision(decision, trigger = 'cron', chatId = null) {
  const db = await connectDB();
  const decisionsCollection = db.collection('decisions');

  const doc = {
    created_at: new Date(),
    chat_id: chatId ? String(chatId) : null,
    symbol: decision.symbol,
    action: decision.action,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    summaryReasoning: decision.summaryReasoning || null,
    marketSummary: decision.marketSummary || null,
    risks: decision.risks,
    trigger,
    positionPct: decision.positionPct || null,
    currentPrice: decision.currentPrice || null,
    usdAmount: decision.usdAmount,
    orderType: decision.orderType,
    takeProfit: decision.takeProfit || null,
    stopLoss: decision.stopLoss || null,
    rendimiento: decision.rendimiento !== undefined ? decision.rendimiento : null,
    model: decision.model || null,
    forced: decision.forced === true,
    forcedReason: decision.forcedReason || null,
    defensive: decision.defensive === true,
    defensiveReason: decision.defensiveReason || null,
    lifecyclePhase: decision.lifecyclePhase || null,
    riskFactors: Array.isArray(decision.riskFactors) ? decision.riskFactors : [],
    maxRoiSeen: decision.maxRoiSeen !== undefined ? safeParse(decision.maxRoiSeen) : null,
    currentRoi: decision.currentRoi !== undefined ? safeParse(decision.currentRoi) : null,
    profitRetracementPct: decision.profitRetracementPct !== undefined ? safeParse(decision.profitRetracementPct) : null,
    positionLifecyclePhase: decision.positionLifecyclePhase || null,
    fifoMatched: typeof decision.fifoMatched === 'boolean' ? decision.fifoMatched : null,
  };

  try {
    const result = await decisionsCollection.insertOne(doc);
    logger.debug(`📊 Decision saved (ID: ${result.insertedId}) | user: ${chatId} | TP: ${decision.takeProfit} SL: ${decision.stopLoss}`);
    return { ...doc, _id: result.insertedId };
  } catch (err) {
    logger.error('Failed to save decision', err.message);
    throw err;
  }
}

export async function saveOrder({
  decisionId,
  symbol,
  side,
  orderType,
  qty,
  price,
  positionPct,
  usdAmount,
  revolutOrderId,
  takeProfit,
  stopLoss,
  riskRewardRatio,
  status,
  error,
  rendimiento,
  chatId,
  realizedPnlUsd = null,
  realizedRoiPct = null,
  fifoMatches = null,
  forced = false,
  forcedReason = null,
  defensive = false,
  defensiveReason = null,
  lifecyclePhase = null,
  riskFactors = [],
  maxRoiSeen = null,
  currentRoi = null,
  profitRetracementPct = null,
  positionLifecyclePhase = null,
  fifoMatched = null,
}) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');

  const parsedQty = safeParse(qty);
  const parsedPrice = safeParse(price);

  const doc = {
    created_at: new Date(),
    chat_id: chatId ? String(chatId) : null,
    decision_id: decisionId,
    symbol,
    side,
    order_type: orderType,
    qty: parsedQty,
    price: parsedPrice,
    position_pct: safeParse(positionPct),
    usd_amount: safeParse(usdAmount),
    revolut_order_id: revolutOrderId,
    take_profit: safeParse(takeProfit),
    stop_loss: safeParse(stopLoss),
    risk_reward_ratio: safeParse(riskRewardRatio),
    status,
    error: error || null,
    rendimiento: rendimiento !== undefined ? safeParse(rendimiento) : null,
    forced: forced === true,
    forced_reason: forcedReason || null,
    defensive: defensive === true,
    defensive_reason: defensiveReason || null,
    lifecycle_phase: lifecyclePhase || null,
    risk_factors: Array.isArray(riskFactors) ? riskFactors : [],
    max_roi_seen: maxRoiSeen !== null ? safeParse(maxRoiSeen) : null,
    current_roi: currentRoi !== null ? safeParse(currentRoi) : null,
    profit_retracement_pct: profitRetracementPct !== null ? safeParse(profitRetracementPct) : null,
    position_lifecycle_phase: positionLifecyclePhase || null,
    fifo_matched: typeof fifoMatched === 'boolean' ? fifoMatched : null,
  };

  if (status === 'executed') {
    if (side === 'buy' && parsedQty && parsedPrice) {
      doc.remaining_qty = parsedQty;
      doc.remaining_cost_usd = parsedQty * parsedPrice;
      doc.lot_status = 'open';
      doc.closed_at = null;
    } else if (side === 'sell') {
      doc.realized_pnl_usd = realizedPnlUsd !== null ? safeParse(realizedPnlUsd) : null;
      doc.realized_roi_pct = realizedRoiPct !== null ? safeParse(realizedRoiPct) : null;
      doc.fifo_matches = fifoMatches || [];
    }
  }

  try {
    const result = await ordersCollection.insertOne(doc);
    logger.info(`✅ Order SAVED to MongoDB: ${side.toUpperCase()} ${symbol} ($${doc.usd_amount}) | user: ${chatId} | ID: ${result.insertedId}`);
    return { ...doc, _id: result.insertedId };
  } catch (err) {
    logger.error('❌ Failed to save order to MongoDB', err.message);
    throw err;
  }
}

export async function savePortfolioSnapshot(balances, chatId = null) {
  const db = await connectDB();
  const snapshotsCollection = db.collection('portfolio_snapshots');

  const doc = {
    created_at: new Date(),
    chat_id: chatId ? String(chatId) : null,
    balances,
  };

  try {
    const result = await snapshotsCollection.insertOne(doc);
    logger.debug(`💰 Portfolio snapshot saved (ID: ${result.insertedId}) | user: ${chatId}`);
    return { ...doc, _id: result.insertedId };
  } catch (err) {
    logger.error('Failed to save portfolio snapshot', err.message);
    throw err;
  }
}

export async function getPreviousDecisions(symbol, chatId = null, limit = 3) {
  const db = await connectDB();
  const decisionsCollection = db.collection('decisions');

  try {
    const querySymbol = { $in: [symbol, symbol.replace('-', '/'), symbol.replace('/', '-')] };
    const query = { symbol: querySymbol };
    if (chatId) query.chat_id = String(chatId);

    return await decisionsCollection.find(query).sort({ created_at: -1 }).limit(limit).toArray();
  } catch (err) {
    logger.warn(`Failed to get previous decisions for ${symbol}: ${err.message}`);
    return [];
  }
}

export async function getRecentDecisions(limit = 5, filter = {}) {
  const db = await connectDB();
  const decisionsCollection = db.collection('decisions');

  try {
    return await decisionsCollection.find(filter).sort({ created_at: -1 }).limit(limit).toArray();
  } catch (err) {
    logger.error('Failed to get recent decisions', err.message);
    throw err;
  }
}

export async function getExecutedOrders(limit = 5, filter = {}) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');

  try {
    return await ordersCollection.find(withActiveOrders(filter)).sort({ created_at: -1 }).limit(limit).toArray();
  } catch (err) {
    logger.error('Failed to get executed orders', err.message);
    throw err;
  }
}

export async function getOpenBuyLots(symbol, chatId = null) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');

  const querySymbol = { $in: [symbol, symbol.replace('-', '/'), symbol.replace('/', '-')] };
  const query = {
    symbol: querySymbol,
    side: 'buy',
    status: 'executed',
    lot_status: { $in: ['open', 'partially_closed'] },
  };
  if (chatId) query.chat_id = String(chatId);

  try {
    const DUST_THRESHOLD_USD = 0.12;
    const lots = await ordersCollection.find(query).sort({ created_at: 1 }).toArray();
    return lots
      .map(lot => ({
        ...lot,
        remaining_qty: Number(lot.remaining_qty),
        remaining_cost_usd: Number(lot.remaining_cost_usd),
      }))
      .filter(lot =>
        lot.remaining_qty > 0 &&
        lot.remaining_cost_usd >= DUST_THRESHOLD_USD
      );
  } catch (err) {
    logger.warn(`Failed to get open buy lots for ${symbol}: ${err.message}`);
    return [];
  }
}

export async function markOrderCancelled({ revolutOrderId, symbol = null, chatId = null, reason = null }) {
  if (!revolutOrderId) {
    return { matchedCount: 0, modifiedCount: 0 };
  }

  const db = await connectDB();
  const ordersCollection = db.collection('orders');

  const query = {
    revolut_order_id: String(revolutOrderId),
    status: { $ne: 'cancelled' },
  };

  if (symbol) query.symbol = { $in: [symbol, symbol.replace('-', '/'), symbol.replace('/', '-')] };
  if (chatId) query.chat_id = String(chatId);

  const result = await ordersCollection.updateOne(query, {
    $set: {
      status: 'cancelled',
      cancelled_at: new Date(),
      error: reason || null,
    },
  });

  if (result.modifiedCount > 0) {
    logger.info(`🟠 Order marked as cancelled in MongoDB: ${revolutOrderId}`);
  }

  return { matchedCount: result.matchedCount || 0, modifiedCount: result.modifiedCount || 0 };
}

export async function applySellToOpenLots(symbol, sellQty, sellPrice, chatId = null) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');

  const DUST_THRESHOLD_USD = 0.12;

  let remainingSellQty = Number(sellQty);
  let totalRealizedPnlUsd = 0;
  const fifoMatches = [];

  const openLots = await getOpenBuyLots(symbol, chatId);

  for (const lot of openLots) {
    if (remainingSellQty <= 0.00000001) break;

    const lotRemainingQty = Number(lot.remaining_qty);
    if (lotRemainingQty <= 0) continue;

    const consumeQty = Math.min(lotRemainingQty, remainingSellQty);
    const costPerUnit = Number(lot.price);
    const exitValue = consumeQty * Number(sellPrice);
    const entryCost = consumeQty * costPerUnit;
    const pnlUsd = exitValue - entryCost;
    const roiPct = entryCost > 0 ? (pnlUsd / entryCost) * 100 : 0;

    fifoMatches.push({
      buy_order_id: lot._id,
      qty_closed: consumeQty,
      entry_price: costPerUnit,
      exit_price: Number(sellPrice),
      pnl_usd: Number(pnlUsd.toFixed(2)),
      roi_pct: Number(roiPct.toFixed(2)),
      entry_created_at: lot.created_at,
    });

    totalRealizedPnlUsd += pnlUsd;
    remainingSellQty -= consumeQty;

    const rawRemainingQty = lotRemainingQty - consumeQty;
    const rawRemainingCostUsd = rawRemainingQty * costPerUnit;

    const shouldCloseAsDust = rawRemainingCostUsd < DUST_THRESHOLD_USD;

    const finalRemainingQty = shouldCloseAsDust ? 0 : Number(rawRemainingQty.toFixed(8));
    const finalRemainingCostUsd = shouldCloseAsDust ? 0 : Number(rawRemainingCostUsd.toFixed(8));
    const newLotStatus = shouldCloseAsDust ? 'closed' : 'partially_closed';

    const updateDoc = {
      $set: {
        remaining_qty: finalRemainingQty,
        remaining_cost_usd: finalRemainingCostUsd,
        lot_status: newLotStatus,
      },
    };

    if (newLotStatus === 'closed') {
      updateDoc.$set.closed_at = new Date();
    }

    await ordersCollection.updateOne({ _id: lot._id }, updateDoc);
  }

  const totalCostBasis = fifoMatches.reduce((sum, m) => sum + (m.qty_closed * m.entry_price), 0);
  const realizedRoiPct = totalCostBasis > 0 ? (totalRealizedPnlUsd / totalCostBasis) * 100 : 0;

  return {
    fifoMatches,
    realizedPnlUsd: Number(totalRealizedPnlUsd.toFixed(2)),
    realizedRoiPct: Number(realizedRoiPct.toFixed(2)),
    totalQtyMatched: Number(sellQty) - remainingSellQty,
  };
}

export async function getOpenPositionSummary(symbol, currentPrice, chatId = null) {
  const openLots = await getOpenBuyLots(symbol, chatId);

  if (openLots.length === 0) {
    return {
      openLots: [],
      totalOpenQty: 0,
      totalOpenCost: 0,
      avgEntryPrice: 0,
      unrealizedPnlUsd: 0,
      unrealizedRoiPct: 0,
      oldestOpenLot: null,
    };
  }

  let totalOpenQty = 0;
  let totalOpenCost = 0;

  const enrichedLots = openLots.map(lot => {
    const remainingQty = Number(lot.remaining_qty);
    const entryPrice = Number(lot.price);
    const cost = remainingQty * entryPrice;

    totalOpenQty += remainingQty;
    totalOpenCost += cost;

    const currentValue = remainingQty * Number(currentPrice);
    const pnlUsd = currentValue - cost;
    const roiPct = cost > 0 ? (pnlUsd / cost) * 100 : 0;

    return {
      symbol: normalizeSymbol(symbol),
      _id: lot._id,
      created_at: lot.created_at,
      remaining_qty: remainingQty,
      entry_price: entryPrice,
      remaining_cost_usd: cost,
      unrealized_pnl_usd: Number(pnlUsd.toFixed(2)),
      unrealized_roi_pct: Number(roiPct.toFixed(2)),
    };
  });

  const avgEntryPrice = totalOpenQty > 0 ? totalOpenCost / totalOpenQty : 0;
  const totalCurrentValue = totalOpenQty * Number(currentPrice);
  const unrealizedPnlUsd = totalCurrentValue - totalOpenCost;
  const unrealizedRoiPct = totalOpenCost > 0 ? (unrealizedPnlUsd / totalOpenCost) * 100 : 0;

  return {
    openLots: enrichedLots,
    totalOpenQty: Number(totalOpenQty.toFixed(8)),
    totalOpenCost: Number(totalOpenCost.toFixed(2)),
    avgEntryPrice: Number(avgEntryPrice.toFixed(8)),
    unrealizedPnlUsd: Number(unrealizedPnlUsd.toFixed(2)),
    unrealizedRoiPct: Number(unrealizedRoiPct.toFixed(2)),
    oldestOpenLot: enrichedLots.length > 0 ? enrichedLots[0] : null,
  };
}

export async function getActivePositionLifecycleStates(chatId = null, { excludeSymbol = null, limit = 10 } = {}) {
  const db = await connectDB();
  const lifecycleCollection = db.collection('position_lifecycle');

  const query = { active: true };
  if (chatId) query.chat_id = String(chatId);
  if (excludeSymbol) query.symbol = { $ne: normalizeSymbol(excludeSymbol) };

  return lifecycleCollection
    .find(query)
    .sort({ updated_at: -1 })
    .limit(Math.max(1, Number(limit) || 10))
    .toArray();
}

export async function getPositionLifecycleState(symbol, chatId = null) {
  const db = await connectDB();
  const lifecycleCollection = db.collection('position_lifecycle');
  const normalizedSymbol = normalizeSymbol(symbol);

  const query = { symbol: normalizedSymbol };
  if (chatId) query.chat_id = String(chatId);

  const doc = await lifecycleCollection.findOne(query);
  return doc || null;
}

export async function updatePositionLifecycleState({
  symbol,
  chatId = null,
  positionSummary = null,
  currentPrice = null,
  minOrderUsd = 0
}) {
  const db = await connectDB();
  const lifecycleCollection = db.collection('position_lifecycle');
  const normalizedSymbol = normalizeSymbol(symbol);
  const now = new Date();

  const query = { symbol: normalizedSymbol };
  if (chatId) query.chat_id = String(chatId);

  const existing = await lifecycleCollection.findOne(query);
  const safeSummary = positionSummary || {};

  const totalQty = resolvePositionQty(safeSummary);
  const avgEntryPrice = toNullableNumber(safeSummary?.avgEntryPrice, 0);
  const currentRoi = toNullableNumber(safeSummary?.unrealizedRoiPct, 0);
  const effectiveCurrentPrice = toNullableNumber(currentPrice, 0);
  const estimatedUsdValue = Number((Math.max(0, totalQty) * Math.max(0, effectiveCurrentPrice)).toFixed(2));
  const isBelowMinOrder = Number(minOrderUsd) > 0 && estimatedUsdValue > 0 && estimatedUsdValue < Number(minOrderUsd);
  const isResidual = isBelowMinOrder || (estimatedUsdValue > 0 && estimatedUsdValue < 15);
  const previousMaxRoi = toNullableNumber(existing?.max_unrealized_roi_pct, currentRoi);
  const maxRoiSeen = Math.max(previousMaxRoi ?? currentRoi, currentRoi);
  const profitRetracementPct = Number((maxRoiSeen - currentRoi).toFixed(4));

  let phase = 'IN_POSITION';
  let active = totalQty > 0;

  if (!active) {
    phase = 'NO_POSITION';
  } else if (isBelowMinOrder) {
    phase = 'RESIDUAL_DUST';
  } else if (maxRoiSeen >= 1.5 && currentRoi <= (maxRoiSeen - 0.8)) {
    phase = 'PROFIT_RETRACEMENT';
  } else if (currentRoi > 0) {
    phase = 'IN_PROFIT';
  } else if (currentRoi < 0) {
    phase = 'IN_DRAWDOWN';
  }

  const mergedRiskFactors = Array.isArray(existing?.risk_factors) ? existing.risk_factors : [];

  const nextState = {
    chat_id: chatId ? String(chatId) : null,
    symbol: normalizedSymbol,
    active,
    phase,
    current_roi_pct: Number(currentRoi.toFixed(4)),
    max_unrealized_roi_pct: Number(maxRoiSeen.toFixed(4)),
    profit_retracement_pct: Number(profitRetracementPct.toFixed(4)),
    total_qty: Number(totalQty.toFixed(8)),
    avg_entry_price: Number(avgEntryPrice.toFixed(8)),
    current_price: Number(effectiveCurrentPrice.toFixed(8)),
    estimated_usd_value: estimatedUsdValue,
    is_residual: isResidual,
    is_below_min_order: isBelowMinOrder,
    last_action: existing?.last_action || null,
    last_defensive_sell_at: existing?.last_defensive_sell_at || null,
    last_exit_at: existing?.last_exit_at || null,
    cooldown_until: existing?.cooldown_until || null,
    risk_factors: mergedRiskFactors,
    updated_at: now,
  };

  await lifecycleCollection.updateOne(
    query,
    {
      $set: nextState,
      $setOnInsert: { created_at: now },
    },
    { upsert: true }
  );

  return {
    ...nextState,
    created_at: existing?.created_at || now,
  };
}

export async function markLifecycleAfterSell({
  symbol,
  chatId = null,
  actionType = 'SELL',
  cooldownMinutes = 360,
  riskFactors = null,
  phase = null
}) {
  const db = await connectDB();
  const lifecycleCollection = db.collection('position_lifecycle');
  const normalizedSymbol = normalizeSymbol(symbol);
  const now = new Date();
  const safeCooldownMinutes = Math.max(0, Number(cooldownMinutes) || 0);
  const cooldownUntil = safeCooldownMinutes > 0
    ? new Date(now.getTime() + (safeCooldownMinutes * 60 * 1000))
    : null;

  const query = { symbol: normalizedSymbol };
  if (chatId) query.chat_id = String(chatId);

  const existing = await lifecycleCollection.findOne(query);
  const isDefensive = String(actionType || '').toUpperCase().includes('DEFENSIVE');
  const updateSet = {
    chat_id: chatId ? String(chatId) : null,
    symbol: normalizedSymbol,
    last_action: actionType,
    updated_at: now,
    cooldown_until: cooldownUntil,
  };

  if (phase) {
    updateSet.phase = phase;
  }
  if (Array.isArray(riskFactors)) {
    updateSet.risk_factors = riskFactors;
  }
  if (isDefensive) {
    updateSet.last_defensive_sell_at = now;
  } else {
    updateSet.last_exit_at = now;
  }

  await lifecycleCollection.updateOne(
    query,
    {
      $set: updateSet,
      $setOnInsert: { created_at: now },
    },
    { upsert: true }
  );

  return {
    ...existing,
    ...updateSet,
    created_at: existing?.created_at || now,
  };
}

export async function getTradingStats(chatId = null) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');
  const decisionsCollection = db.collection('decisions');

  const query = {};
  if (chatId) query.chat_id = String(chatId);
  else return null;

  try {
    const [totalOrders, totalDecisions, totalBuys, totalSells] = await Promise.all([
      ordersCollection.countDocuments(withActiveOrders({ ...query, status: 'executed' })),
      decisionsCollection.countDocuments(query),
      ordersCollection.countDocuments(withActiveOrders({ ...query, side: 'buy', status: 'executed' })),
      ordersCollection.countDocuments(withActiveOrders({ ...query, side: 'sell', status: 'executed' })),
    ]);

    return {
      totalDecisions,
      totalOrders,
      totalBuys,
      totalSells,
      executionRate: totalDecisions > 0 ? ((totalOrders / totalDecisions) * 100).toFixed(1) + '%' : '0%',
    };
  } catch (err) {
    logger.error('Failed to get trading stats', err.message);
    return null;
  }
}

export async function getTradingPerformance(chatId = null, realBalances = null) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');
  const decisionsCollection = db.collection('decisions');

  const query = {};
  if (chatId) query.chat_id = String(chatId);
  else return null;

  try {
    const [orders, totalDecisions, sellOrdersWithRendimiento] = await Promise.all([
      ordersCollection.find(withActiveOrders({ ...query, status: 'executed', price: { $ne: null }, qty: { $ne: null } })).sort({ created_at: 1 }).toArray(),
      decisionsCollection.countDocuments(query),
      ordersCollection.find(withActiveOrders({ ...query, side: 'sell', status: 'executed', rendimiento: { $ne: null, $type: 'double' } })).project({ rendimiento: 1 }).toArray(),
    ]);

    const accumulatedRendimiento = parseFloat(sellOrdersWithRendimiento.reduce((sum, o) => sum + (Number(o.rendimiento) || 0), 0).toFixed(2));

    const positions = {};
    let totalRealizedPnL = 0;
    let totalInvested = 0;
    let totalBuys = 0;
    let totalSells = 0;
    let winningTrades = 0;
    let losingTrades = 0;

    for (const order of orders) {
      const symbol = (order.symbol || '').replace('/', '-');
      const qty = Number(order.qty);
      const price = Number(order.price);

      if (!symbol || Number.isNaN(qty) || qty <= 0 || Number.isNaN(price) || price <= 0) {
        logger.warn(`⚠️ Skipping invalid order ${order._id}: qty=${order.qty} price=${order.price}`);
        continue;
      }

      if (!positions[symbol]) positions[symbol] = { openLots: [], realizedPnL: 0 };
      const pos = positions[symbol];

      if (order.side === 'buy') {
        totalInvested += qty * price;
        totalBuys++;
        pos.openLots.push({ qty, price });
      }

      if (order.side === 'sell') {
        totalSells++;
        let remainingSellQty = qty;
        let sellPnl = 0;

        while (remainingSellQty > 0.00000001 && pos.openLots.length > 0) {
          const oldestLot = pos.openLots[0];
          const consumeQty = Math.min(oldestLot.qty, remainingSellQty);
          const pnl = (price - oldestLot.price) * consumeQty;
          sellPnl += pnl;

          oldestLot.qty -= consumeQty;
          if (oldestLot.qty <= 0.00000001) pos.openLots.shift();
          remainingSellQty -= consumeQty;
        }

        pos.realizedPnL += sellPnl;
        totalRealizedPnL += sellPnl;
        if (sellPnl > 0) winningTrades++;
        else if (sellPnl < 0) losingTrades++;
      }
    }

    const totalOrders = totalBuys + totalSells;
    const closedTrades = winningTrades + losingTrades;
    const manualPositions = [];

    if (realBalances) {
      const balanceArray = Array.isArray(realBalances) ? realBalances : (realBalances.data || []);

      for (const realBal of balanceArray) {
        if (['USD', 'EUR', 'GBP'].includes(realBal.currency)) continue;
        const realQty = Number(realBal.total || 0);
        if (realQty <= 0) continue;

        const trackedPosKey = Object.keys(positions).find(k => k.startsWith(realBal.currency + '-'));
        const botQty = trackedPosKey && positions[trackedPosKey]
          ? positions[trackedPosKey].openLots.reduce((sum, l) => sum + l.qty, 0)
          : 0;

        if (botQty > realQty) {
          const factor = realQty > 0 ? (realQty / botQty) : 0;
          if (positions[trackedPosKey] && positions[trackedPosKey].openLots) {
            positions[trackedPosKey].openLots.forEach(lot => { lot.qty *= factor; });
          }
        } else if (realQty > botQty) {
          manualPositions.push({
            symbol: realBal.currency + '-USD',
            qty: Number((realQty - botQty).toFixed(8)),
          });
        }
      }
    }

    return {
      totalDecisions,
      totalOrders,
      totalBuys,
      totalSells,
      executionRate: totalDecisions > 0 ? ((totalOrders / totalDecisions) * 100).toFixed(1) + '%' : '0%',
      totalRealizedPnL: Number(totalRealizedPnL.toFixed(2)),
      totalInvested: Number(totalInvested.toFixed(2)),
      roiRealized: totalInvested > 0 ? ((totalRealizedPnL / totalInvested) * 100).toFixed(2) + '%' : '0%',
      winningTrades,
      losingTrades,
      closedTrades,
      winRate: closedTrades > 0 ? ((winningTrades / closedTrades) * 100).toFixed(1) + '%' : '0%',
      openPositions: Object.entries(positions)
        .map(([symbol, p]) => {
          const totalQty = p.openLots.reduce((sum, lot) => sum + lot.qty, 0);
          const totalCost = p.openLots.reduce((sum, lot) => sum + (lot.qty * lot.price), 0);
          return {
            symbol,
            qty: Number(totalQty.toFixed(8)),
            avgPrice: totalQty > 0 ? Number((totalCost / totalQty).toFixed(8)) : 0,
            totalCost: Number(totalCost.toFixed(2)),
          };
        })
        .filter(p => p.qty > 0 && p.totalCost >= 1),
      manualPositions,
      accumulatedRendimiento,
    };
  } catch (err) {
    logger.error('Failed to get trading performance', err.message);
    return null;
  }
}

export async function getAccumulatedRendimiento(chatId = null) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');

  const query = {
    side: 'sell',
    status: 'executed',
    rendimiento: { $ne: null, $type: 'double' },
  };
  if (chatId) query.chat_id = String(chatId);
  else return 0;

  try {
    const sellOrders = await ordersCollection.find(withActiveOrders(query)).project({ rendimiento: 1 }).toArray();
    const total = sellOrders.reduce((sum, o) => sum + (Number(o.rendimiento) || 0), 0);
    return parseFloat(total.toFixed(2));
  } catch (err) {
    logger.error('Failed to get accumulated rendimiento', err.message);
    return 0;
  }
}

export async function getDecisionById(id) {
  if (!id) return null;
  try {
    const db = await connectDB();
    const decisionsCollection = db.collection('decisions');
    const queryId = (typeof id === 'string') ? new ObjectId(id) : id;
    return await decisionsCollection.findOne({ _id: queryId });
  } catch (err) {
    logger.warn(`⚠️ Failed to get decision by ID ${id}: ${err.message}`);
    return null;
  }
}

export async function getRecentOpenBuyFromOtherSymbols(currentSymbol, lookbackMinutes, chatId = null) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');

  const since = new Date(Date.now() - (lookbackMinutes * 60 * 1000));
  const normalizedCurrent = String(currentSymbol || '').replace('/', '-').toUpperCase();

  const query = {
    side: 'buy',
    status: 'executed',
    lot_status: { $in: ['open', 'partially_closed'] },
    created_at: { $gte: since },
    symbol: { $ne: normalizedCurrent },
  };

  if (chatId) query.chat_id = String(chatId);

  const doc = await ordersCollection.find(query).sort({ created_at: -1 }).limit(1).next();
  if (!doc) return null;

  return {
    symbol: doc.symbol,
    openedAt: doc.created_at,
    qty: Number(doc.remaining_qty ?? doc.qty ?? 0),
    costUsd: Number(doc.remaining_cost_usd ?? doc.usd_amount ?? 0),
    entryPrice: Number(doc.price ?? 0),
  };
}
