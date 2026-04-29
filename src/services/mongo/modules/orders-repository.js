import { connectDB } from '../client.js';
import { logger, normalizeSymbol, safeParse, withActiveOrders } from './shared.js';

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
      .map((lot) => ({
        ...lot,
        remaining_qty: Number(lot.remaining_qty),
        remaining_cost_usd: Number(lot.remaining_cost_usd),
      }))
      .filter((lot) =>
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

export async function applySellToOpenLots(symbol, sellQty, sellPrice, chatId = null, options = {}) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');

  const DUST_THRESHOLD_USD = 0.12;
  const normalizedSymbol = normalizeSymbol(symbol);
  const residualCloseBelowUsd = Number(options?.residualCloseBelowUsd || 0);
  const shouldCloseResidual = Number.isFinite(residualCloseBelowUsd) && residualCloseBelowUsd > DUST_THRESHOLD_USD;

  let remainingSellQty = Number(sellQty);
  let totalRealizedPnlUsd = 0;
  const fifoMatches = [];

  const openLots = await getOpenBuyLots(normalizedSymbol, chatId);

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

  let autoClosedResidualUsd = 0;
  let autoClosedResidualLots = 0;

  if (shouldCloseResidual) {
    const residualQuery = {
      symbol: { $in: [normalizedSymbol, normalizedSymbol.replace('-', '/')] },
      side: 'buy',
      status: 'executed',
      lot_status: { $in: ['open', 'partially_closed'] },
      remaining_qty: { $gt: 0 },
      remaining_cost_usd: { $gt: DUST_THRESHOLD_USD, $lt: residualCloseBelowUsd }
    };
    if (chatId) residualQuery.chat_id = String(chatId);

    const residualLots = await ordersCollection.find(residualQuery).toArray();
    autoClosedResidualLots = residualLots.length;
    autoClosedResidualUsd = residualLots.reduce((sum, lot) => sum + Number(lot.remaining_cost_usd || 0), 0);

    if (autoClosedResidualLots > 0) {
      await ordersCollection.updateMany(
        residualQuery,
        {
          $set: {
            remaining_qty: 0,
            remaining_cost_usd: 0,
            lot_status: 'closed',
            closed_at: new Date(),
            closed_reason: 'AUTO_RESIDUAL_SELL_ALL'
          }
        }
      );

      logger.info(
        `Auto-closed ${autoClosedResidualLots} residual lot(s) for ${normalizedSymbol} below $${residualCloseBelowUsd.toFixed(2)} ` +
        `(approx residual $${autoClosedResidualUsd.toFixed(2)})`
      );
    }
  }

  const totalCostBasis = fifoMatches.reduce((sum, m) => sum + (m.qty_closed * m.entry_price), 0);
  const realizedRoiPct = totalCostBasis > 0 ? (totalRealizedPnlUsd / totalCostBasis) * 100 : 0;

  return {
    fifoMatches,
    realizedPnlUsd: Number(totalRealizedPnlUsd.toFixed(2)),
    realizedRoiPct: Number(realizedRoiPct.toFixed(2)),
    totalQtyMatched: Number(sellQty) - remainingSellQty,
    autoClosedResidualLots,
    autoClosedResidualUsd: Number(autoClosedResidualUsd.toFixed(2)),
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

  const enrichedLots = openLots.map((lot) => {
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
