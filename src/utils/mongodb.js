/**
 * src/utils/mongodb.js
 * MongoDB connection and models for trading decisions, orders, and portfolio snapshots.
 */

import { MongoClient, Db } from 'mongodb';
import { logger } from './logger.js';
import { config } from '../config/config.js';

let db = null;
let client = null;

/**
 * Connect to MongoDB
 */
export async function connectDB() {
  if (db) return db;

  const uri = config.mongodb.uri;
  const dbName = config.mongodb.dbName;

  try {

    client = new MongoClient(uri, {
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000,
    });

    await client.connect();
    db = client.db(dbName);

    // Verify connection
    await db.admin().ping();

    // Initialize collections
    await initializeCollections();

    return db;
  } catch (err) {
    logger.error('MongoDB connection failed', err.message);
    throw new Error(`Database connection failed: ${err.message}`);
  }
}

/**
 * Initialize collections with indexes
 */
async function initializeCollections() {
  try {
    // Decisions collection
    const decisionsCollection = db.collection('decisions');
    await decisionsCollection.createIndex({ created_at: -1 });
    await decisionsCollection.createIndex({ symbol: 1 });
    await decisionsCollection.createIndex({ trigger: 1 });

    // Orders collection
    const ordersCollection = db.collection('orders');
    await ordersCollection.createIndex({ created_at: -1 });
    await ordersCollection.createIndex({ decision_id: 1 });
    await ordersCollection.createIndex({ symbol: 1 });
    await ordersCollection.createIndex({ status: 1 });

    // Portfolio snapshots collection
    const snapshotsCollection = db.collection('portfolio_snapshots');
    await snapshotsCollection.createIndex({ created_at: -1 });

  } catch (err) {
    logger.warn('Failed to initialize collections', err.message);
    // Don't throw - collections might already exist
  }
}

/**
 * Save a trading decision
 * @param {Object} decision - Claude's decision
 * @param {string} trigger - 'cron' or 'manual'
 * @returns {Object} Saved document with _id
 */
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
    risks: decision.risks,
    trigger,
    positionPct: decision.positionPct || null,
    currentPrice: decision.currentPrice || null,   // market price at decision time
    usdAmount: decision.usdAmount,
    orderType: decision.orderType,
    takeProfit: decision.takeProfit || null,
    stopLoss: decision.stopLoss || null,
    rendimiento: decision.rendimiento !== undefined ? decision.rendimiento : null
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

/**
 * Save an executed order
 * @param {Object} params - Order details
 * @returns {Object} Saved order document
 */
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
}) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');

  const safeParse = (val) => {
    const p = parseFloat(val);
    return isNaN(p) ? null : p;
  };

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


/**
 * Save portfolio snapshot
 * @param {Object} balances - Current portfolio balances
 * @returns {Object} Saved snapshot document
 */
export async function savePortfolioSnapshot(balances, chatId = null) {
  const db = await connectDB();
  const snapshotsCollection = db.collection('portfolio_snapshots');

  const doc = {
    created_at: new Date(),
    chat_id: chatId ? String(chatId) : null,
    balances: balances,
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

/**
 * Get previous decisions for a specific symbol
 * @param {string} symbol - Trading pair (e.g., "BTC/USD")
 * @param {number} limit - Number of previous decisions to return (default: 3)
 * @returns {Array} Previous decisions sorted by date (newest first)
 */
export async function getPreviousDecisions(symbol, chatId = null, limit = 3) {
  const db = await connectDB();
  const decisionsCollection = db.collection('decisions');

  try {
    const querySymbol = { $in: [symbol, symbol.replace('-', '/'), symbol.replace('/', '-')] };
    const query = { symbol: querySymbol };
    if (chatId) query.chat_id = String(chatId);

    const decisions = await decisionsCollection
      .find(query)
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();

    return decisions;
  } catch (err) {
    logger.warn(`Failed to get previous decisions for ${symbol}: ${err.message}`);
    return [];
  }
}

/**
 * Get recent decisions
 * @param {number} limit - Number of decisions to return
 * @param {Object} filter - Optional MongoDB filter
 * @returns {Array} Recent decisions
 */
export async function getRecentDecisions(limit = 5, filter = {}) {
  const db = await connectDB();
  const decisionsCollection = db.collection('decisions');

  try {
    return await decisionsCollection
      .find(filter)
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
  } catch (err) {
    logger.error('Failed to get recent decisions', err.message);
    throw err;
  }
}

/**
 * Get executed orders
 * @param {number} limit - Number of orders to return
 * @param {Object} filter - Optional MongoDB filter
 * @returns {Array} Executed orders
 */
export async function getExecutedOrders(limit = 5, filter = {}) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');

  try {
    return await ordersCollection
      .find(filter)
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
  } catch (err) {
    logger.error('Failed to get executed orders', err.message);
    throw err;
  }
}

/**
 * Get open BUY lots (FIFO order)
 */
export async function getOpenBuyLots(symbol, chatId = null) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');

  const querySymbol = { $in: [symbol, symbol.replace('-', '/'), symbol.replace('/', '-')] };
  const query = {
    symbol: querySymbol,
    side: 'buy',
    lot_status: { $in: ['open', 'partially_closed'] }
  };
  if (chatId) query.chat_id = String(chatId);

  try {
    const lots = await ordersCollection
      .find(query)
      .sort({ created_at: 1 }) // FIFO
      .toArray();

    return lots.map(lot => ({
      ...lot,
      remaining_qty: Number(lot.remaining_qty),
      remaining_cost_usd: Number(lot.remaining_cost_usd),
    })).filter(lot => lot.remaining_qty > 0);
  } catch (err) {
    logger.warn(`Failed to get open buy lots for ${symbol}: ${err.message}`);
    return [];
  }
}

/**
 * Apply a SELL execution to open BUY lots (FIFO matching)
 */
export async function applySellToOpenLots(symbol, sellQty, sellPrice, chatId = null) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');

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
      entry_created_at: lot.created_at
    });

    totalRealizedPnlUsd += pnlUsd;
    remainingSellQty -= consumeQty;

    const newRemainingQty = lotRemainingQty - consumeQty;
    const newRemainingCostUsd = newRemainingQty * costPerUnit;
    const newLotStatus = newRemainingQty > 0.00000001 ? 'partially_closed' : 'closed';

    const updateDoc = {
      $set: {
        remaining_qty: newRemainingQty,
        remaining_cost_usd: newRemainingCostUsd,
        lot_status: newLotStatus
      }
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
    totalQtyMatched: Number(sellQty) - remainingSellQty
  };
}

/**
 * Get a summary of the real open position from DB lots
 */
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
      oldestOpenLot: null
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
      _id: lot._id,
      created_at: lot.created_at,
      remaining_qty: remainingQty,
      entry_price: entryPrice,
      remaining_cost_usd: cost,
      unrealized_pnl_usd: Number(pnlUsd.toFixed(2)),
      unrealized_roi_pct: Number(roiPct.toFixed(2))
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
    oldestOpenLot: enrichedLots.length > 0 ? enrichedLots[0] : null
  };
}

/**
 * Get trading statistics
 * @returns {Object} Trading stats
 */
/**
 * Get trading statistics — counts from decisions + orders collections
 * @returns {Object|null}
 */
export async function getTradingStats(chatId = null) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');
  const decisionsCollection = db.collection('decisions');

  const query = {};
  if (chatId) query.chat_id = String(chatId);
  else return null; // No stats without a user context in multi-user mode

  try {
    const [totalOrders, totalDecisions, totalBuys, totalSells] = await Promise.all([
      ordersCollection.countDocuments({ ...query, status: 'executed' }),
      decisionsCollection.countDocuments(query),
      ordersCollection.countDocuments({ ...query, side: 'buy', status: 'executed' }),
      ordersCollection.countDocuments({ ...query, side: 'sell', status: 'executed' }),
    ]);

    return {
      totalDecisions,
      totalOrders,
      totalBuys,
      totalSells,
      executionRate: totalDecisions > 0
        ? ((totalOrders / totalDecisions) * 100).toFixed(1) + '%'
        : '0%',
    };
  } catch (err) {
    logger.error('Failed to get trading stats', err.message);
    return null;
  }
}

/**
 * Get full trading performance — PnL, win rate, open positions.
 * Calculates realised P&L by walking through buy/sell pairs chronologically
 * (FIFO average-cost method, per symbol).
 * Also includes decision/order counts from getTradingStats.
 * @returns {Object|null}
 */
export async function getTradingPerformance(chatId = null, realBalances = null) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');
  const decisionsCollection = db.collection('decisions');

  const query = {};
  if (chatId) query.chat_id = String(chatId);
  else return null;

  try {
    // Parallel: fetch all executed orders + decision count
    const [orders, totalDecisions, sellOrdersWithRendimiento] = await Promise.all([
      ordersCollection
        .find({ ...query, status: 'executed', price: { $ne: null }, qty: { $ne: null } })
        .sort({ created_at: 1 })
        .toArray(),
      decisionsCollection.countDocuments(query),
      // Sum rendimiento stored on SELL orders (realized PnL% per trade, can be negative)
      ordersCollection
        .find({ ...query, side: 'sell', status: 'executed', rendimiento: { $ne: null, $type: 'double' } })
        .project({ rendimiento: 1 })
        .toArray(),
    ]);

    // Accumulated rendimiento = sum of all stored sell rendimientos (+ adds, - subtracts)
    const accumulatedRendimiento = parseFloat(
      sellOrdersWithRendimiento
        .reduce((sum, o) => sum + (Number(o.rendimiento) || 0), 0)
        .toFixed(2)
    );

    // ── Walk orders chronologically, tracking per-symbol positions (FIFO) ──
    const positions = {};
    let totalRealizedPnL = 0;
    let totalInvested = 0;
    let totalBuys = 0;
    let totalSells = 0;
    let winningTrades = 0;
    let losingTrades = 0;

    for (const order of orders) {
      // Normalise symbol: treat BTC/USD and BTC-USD as the same position
      const symbol = (order.symbol || '').replace('/', '-');
      const qty = Number(order.qty);
      const price = Number(order.price);

      // Skip corrupted/legacy records with non-numeric qty or price
      if (!symbol || isNaN(qty) || qty <= 0 || isNaN(price) || price <= 0) {
        logger.warn(`⚠️ Skipping invalid order ${order._id}: qty=${order.qty} price=${order.price}`);
        continue;
      }

      if (!positions[symbol]) {
        positions[symbol] = { openLots: [], realizedPnL: 0 };
      }

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

        // FIFO consumption
        while (remainingSellQty > 0.00000001 && pos.openLots.length > 0) {
          const oldestLot = pos.openLots[0];
          const consumeQty = Math.min(oldestLot.qty, remainingSellQty);

          const pnl = (price - oldestLot.price) * consumeQty;
          sellPnl += pnl;

          oldestLot.qty -= consumeQty;
          if (oldestLot.qty <= 0.00000001) {
            pos.openLots.shift(); // fully consumed
          }
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

    // Option B + Visibility: Cap MongoDB positions at physical balances, and expose un-managed balances to UI
    if (realBalances) {
      const balanceArray = Array.isArray(realBalances) ? realBalances : (realBalances.data || []);

      // 1. Check all physical crypto assets
      for (const realBal of balanceArray) {
        if (['USD', 'EUR', 'GBP'].includes(realBal.currency)) continue;

        const realQty = Number(realBal.total || 0);
        if (realQty <= 0) continue;

        const trackedPosKey = Object.keys(positions).find(k => k.startsWith(realBal.currency + '-'));
        const botQty = trackedPosKey && positions[trackedPosKey]
          ? positions[trackedPosKey].openLots.reduce((sum, l) => sum + l.qty, 0)
          : 0;

        if (botQty > realQty) {
          // Sync: Bot thinks we have more than we physically do (e.g. manual sell outside app)
          const factor = realQty > 0 ? (realQty / botQty) : 0;
          if (positions[trackedPosKey] && positions[trackedPosKey].openLots) {
            positions[trackedPosKey].openLots.forEach(lot => {
              lot.qty *= factor;
            });
          }
        } else if (realQty > botQty) {
          // UI: We have physical balance the bot didn't buy (manual deposit / legacy)
          manualPositions.push({
            symbol: realBal.currency + '-USD', // Assume USD quote for simplicity
            qty: Number((realQty - botQty).toFixed(8))
          });
        }
      }
    }

    return {
      // ── Order / decision counts ──
      totalDecisions,
      totalOrders,
      totalBuys,
      totalSells,
      executionRate: totalDecisions > 0
        ? ((totalOrders / totalDecisions) * 100).toFixed(1) + '%'
        : '0%',
      // ── Realised PnL ──
      totalRealizedPnL: Number(totalRealizedPnL.toFixed(2)),
      totalInvested: Number(totalInvested.toFixed(2)),
      roiRealized: totalInvested > 0
        ? ((totalRealizedPnL / totalInvested) * 100).toFixed(2) + '%'
        : '0%',
      // ── Win/loss stats ──
      winningTrades,
      losingTrades,
      closedTrades,
      winRate: closedTrades > 0
        ? ((winningTrades / closedTrades) * 100).toFixed(1) + '%'
        : '0%',
      // ── Positions ──
      openPositions: Object.entries(positions)
        .map(([symbol, p]) => {
          const totalQty = p.openLots.reduce((sum, lot) => sum + lot.qty, 0);
          const totalCost = p.openLots.reduce((sum, lot) => sum + (lot.qty * lot.price), 0);
          return {
            symbol,
            qty: Number(totalQty.toFixed(8)),
            avgPrice: totalQty > 0 ? Number((totalCost / totalQty).toFixed(8)) : 0,
            totalCost: Number(totalCost.toFixed(2))
          };
        })
        .filter(p => p.qty > 0 && p.totalCost >= 1),
      manualPositions, // Explicitly separate manual holdings
      // ── Accumulated rendimiento from stored sell orders (sum, can be negative) ──
      // This is the simple sum of each trade's realized % stored at execution time.
      accumulatedRendimiento,
    };
  } catch (err) {
    logger.error('Failed to get trading performance', err.message);
    return null;
  }
}

/**
 * Get the accumulated rendimiento by summing all stored rendimiento values
 * from SELL orders. Positive trades add, negative trades subtract.
 * Returns a float (can be negative) or 0 if no data.
 * @returns {number}
 */
export async function getAccumulatedRendimiento(chatId = null) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');

  const query = {
    side: 'sell',
    status: 'executed',
    rendimiento: { $ne: null, $type: 'double' }
  };
  if (chatId) query.chat_id = String(chatId);
  else return 0;

  try {
    const sellOrders = await ordersCollection
      .find(query)
      .project({ rendimiento: 1 })
      .toArray();

    const total = sellOrders.reduce((sum, o) => sum + (Number(o.rendimiento) || 0), 0);
    return parseFloat(total.toFixed(2));
  } catch (err) {
    logger.error('Failed to get accumulated rendimiento', err.message);
    return 0;
  }
}

/**
 * Disconnect from MongoDB
 */
export async function disconnectDB() {
  if (client) {
    await client.close();
    db = null;
    client = null;
    logger.info('Disconnected from MongoDB');
  }
}

/**
 * Get database instance
 */
export function getDB() {
  if (!db) {
    throw new Error('Database not connected. Call connectDB() first.');
  }
  return db;
}

/**
 * Get a specific decision by its ID
 * @param {any} id - Database ID (string or ObjectId)
 * @returns {Promise<Object|null>}
 */
export async function getDecisionById(id) {
  if (!id) return null;
  try {
    const db = await connectDB();
    const decisionsCollection = db.collection('decisions');

    // Dynamic import to avoid circular dependencies or top-level issues if needed,
    // though here we just need it for the constructor.
    const { ObjectId } = await import('mongodb');
    const queryId = (typeof id === 'string') ? new ObjectId(id) : id;

    return await decisionsCollection.findOne({ _id: queryId });
  } catch (err) {
    logger.warn(`⚠️ Failed to get decision by ID ${id}: ${err.message}`);
    return null;
  }
}
