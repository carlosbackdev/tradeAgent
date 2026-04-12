/**
 * src/utils/mongodb.js
 * MongoDB connection and models for trading decisions, orders, and portfolio snapshots.
 */

import { MongoClient, Db } from 'mongodb';
import { logger } from './logger.js';

let db = null;
let client = null;

/**
 * Connect to MongoDB
 */
export async function connectDB() {
  if (db) return db;

  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  const dbName = process.env.MONGODB_DB || 'revolut-trading-agent';

  try {
    logger.info(`Connecting to MongoDB: ${uri}`);
    
    client = new MongoClient(uri, {
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000,
    });

    await client.connect();
    db = client.db(dbName);

    // Verify connection
    await db.admin().ping();
    logger.info(`✅ Connected to MongoDB database: ${dbName}`);

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

    logger.debug('✅ Collections initialized with indexes');
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
    stopLoss: decision.stopLoss || null
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
    const decisions = await decisionsCollection
      .find({ symbol })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
    
    logger.debug(`📜 Retrieved ${decisions.length} previous decisions for ${symbol}`);
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
export async function getRecentDecisions(limit = 20, filter = {}) {
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
export async function getExecutedOrders(limit = 20, filter = {}) {
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
export async function getTradingStats() {
  const db = await connectDB();
  const ordersCollection = db.collection('orders');
  const decisionsCollection = db.collection('decisions');

  try {
    const totalOrders = await ordersCollection.countDocuments({ status: 'executed' });
    const totalDecisions = await decisionsCollection.countDocuments();
    const totalBuys = await ordersCollection.countDocuments({ side: 'buy', status: 'executed' });
    const totalSells = await ordersCollection.countDocuments({ side: 'sell', status: 'executed' });

    return {
      totalDecisions,
      totalOrders,
      totalBuys,
      totalSells,
      executionRate: totalOrders > 0 ? ((totalOrders / totalDecisions) * 100).toFixed(1) + '%' : '0%',
    };
  } catch (err) {
    logger.error('Failed to get trading stats', err.message);
    return null;
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
