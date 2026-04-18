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
export async function saveDecision(decision, trigger = 'cron') {
  const db = await connectDB();
  const decisionsCollection = db.collection('decisions');

  const doc = {
    created_at: new Date(),
    symbol: decision.symbol,
    action: decision.action,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    risks: decision.risks,
    trigger,
    usdAmount: decision.usdAmount,
    orderType: decision.orderType,
    takeProfit: decision.takeProfit || null,
    stopLoss: decision.stopLoss || null,
    rendimiento: decision.rendimiento !== undefined ? decision.rendimiento : null
  };

  try {
    const result = await decisionsCollection.insertOne(doc);
    logger.debug(`📊 Decision saved (ID: ${result.insertedId}) | TP: ${decision.takeProfit} SL: ${decision.stopLoss}`);
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
  usdAmount,
  revolutOrderId,
  takeProfit,
  stopLoss,
  riskRewardRatio,
  status,
  error,
  rendimiento,
}) {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');

  const doc = {
    created_at: new Date(),
    decision_id: decisionId,
    symbol,
    side,
    order_type: orderType,
    qty: parseFloat(qty),
    price: price ? parseFloat(price) : null,
    usd_amount: parseFloat(usdAmount),
    revolut_order_id: revolutOrderId,
    take_profit: takeProfit ? parseFloat(takeProfit) : null,
    stop_loss: stopLoss ? parseFloat(stopLoss) : null,
    risk_reward_ratio: riskRewardRatio ? parseFloat(riskRewardRatio) : null,
    status,
    error: error || null,
    rendimiento: rendimiento !== undefined ? parseFloat(rendimiento) : null,
  };

  try {
    const result = await ordersCollection.insertOne(doc);
    logger.debug(`💼 Order saved with TP: ${takeProfit}, SL: ${stopLoss} (ID: ${result.insertedId})`);
    return { ...doc, _id: result.insertedId };
  } catch (err) {
    logger.error('Failed to save order', err.message);
    throw err;
  }
}

/**
 * Save portfolio snapshot
 * @param {Object} balances - Current portfolio balances
 * @returns {Object} Saved snapshot document
 */
export async function savePortfolioSnapshot(balances) {
  const db = await connectDB();
  const snapshotsCollection = db.collection('portfolio_snapshots');

  const doc = {
    created_at: new Date(),
    balances: balances, // Stored as-is (MongoDB handles objects)
  };

  try {
    const result = await snapshotsCollection.insertOne(doc);
    logger.debug(`💰 Portfolio snapshot saved (ID: ${result.insertedId})`);
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
export async function getPreviousDecisions(symbol, limit = 3) {
  const db = await connectDB();
  const decisionsCollection = db.collection('decisions');

  try {
    const querySymbol = { $in: [symbol, symbol.replace('-', '/'), symbol.replace('/', '-')] };
    const decisions = await decisionsCollection
      .find({ symbol: querySymbol })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();

    return decisions;
  } catch (err) {
    logger.warn(`Failed to get previous decisions for ${symbol}: ${err.message}`);
    return []; // Return empty array on error - don't fail the cycle
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
 * Get trading statistics
 * @returns {Object} Trading stats
 */
/**
 * Get trading statistics — counts from decisions + orders collections
 * @returns {Object|null}
 */
export async function getTradingStats() {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');
  const decisionsCollection = db.collection('decisions');

  try {
    const [totalOrders, totalDecisions, totalBuys, totalSells] = await Promise.all([
      ordersCollection.countDocuments({ status: 'executed' }),
      decisionsCollection.countDocuments(),
      ordersCollection.countDocuments({ side: 'buy', status: 'executed' }),
      ordersCollection.countDocuments({ side: 'sell', status: 'executed' }),
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
export async function getTradingPerformance() {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');
  const decisionsCollection = db.collection('decisions');

  try {
    // Parallel: fetch all executed orders + decision count
    const [orders, totalDecisions, sellOrdersWithRendimiento] = await Promise.all([
      ordersCollection
        .find({ status: 'executed', price: { $ne: null }, qty: { $ne: null } })
        .sort({ created_at: 1 })
        .toArray(),
      decisionsCollection.countDocuments(),
      // Sum rendimiento stored on SELL orders (realized PnL% per trade, can be negative)
      ordersCollection
        .find({ side: 'sell', status: 'executed', rendimiento: { $ne: null, $type: 'double' } })
        .project({ rendimiento: 1 })
        .toArray(),
    ]);

    // Accumulated rendimiento = sum of all stored sell rendimientos (+ adds, - subtracts)
    const accumulatedRendimiento = parseFloat(
      sellOrdersWithRendimiento
        .reduce((sum, o) => sum + (Number(o.rendimiento) || 0), 0)
        .toFixed(2)
    );

    // ── Walk orders chronologically, tracking per-symbol positions ──
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
        positions[symbol] = { qty: 0, totalCost: 0, avgPrice: 0, realizedPnL: 0 };
      }

      const pos = positions[symbol];

      if (order.side === 'buy') {
        pos.totalCost += qty * price;
        pos.qty += qty;
        pos.avgPrice = pos.qty > 0 ? pos.totalCost / pos.qty : 0;
        totalInvested += qty * price;
        totalBuys++;
      }

      if (order.side === 'sell') {
        totalSells++;
        // Never sell more than we hold to avoid negative positions
        const sellQty = Math.min(qty, pos.qty);

        if (sellQty > 0) {
          const pnl = (price - pos.avgPrice) * sellQty;
          pos.realizedPnL += pnl;
          totalRealizedPnL += pnl;

          if (pnl > 0) winningTrades++;
          else if (pnl < 0) losingTrades++;

          pos.qty -= sellQty;
          pos.totalCost -= pos.avgPrice * sellQty;

          if (pos.qty <= 0) {
            pos.qty = 0;
            pos.totalCost = 0;
            pos.avgPrice = 0;
          }
        }
      }
    }

    const totalOrders = totalBuys + totalSells;
    const closedTrades = winningTrades + losingTrades;

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
      // ── Open positions still holding inventory (skip dust < $1) ──
      openPositions: Object.entries(positions)
        .filter(([, p]) => p.qty > 0 && p.totalCost >= 1)
        .map(([symbol, p]) => ({
          symbol,
          qty: Number(p.qty.toFixed(8)),
          avgPrice: Number(p.avgPrice.toFixed(8)),
          totalCost: Number(p.totalCost.toFixed(2))
        })),
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
export async function getAccumulatedRendimiento() {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');

  try {
    const sellOrders = await ordersCollection
      .find({
        side: 'sell',
        status: 'executed',
        rendimiento: { $ne: null, $type: 'double' }
      })
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
