/**
 * services/mongo/index.js
 * Backward-compatible facade over split Mongo modules.
 */

import { ObjectId } from 'mongodb';
import { connectDB, disconnectDB, getDB } from './client.js';
import { logger, safeParse } from './modules/shared.js';
import {
  saveOrder,
  getExecutedOrders,
  getOpenBuyLots,
  markOrderCancelled,
  applySellToOpenLots,
  getOpenPositionSummary,
  getRecentOpenBuyFromOtherSymbols
} from './modules/orders-repository.js';
import {
  getActivePositionLifecycleStates,
  getPositionLifecycleState,
  updatePositionLifecycleState,
  markLifecycleAfterSell
} from './modules/lifecycle-repository.js';
import {
  getTradingStats,
  getTradingPerformance,
  getAccumulatedRendimiento
} from './modules/stats-repository.js';

export {
  connectDB,
  disconnectDB,
  getDB,
  saveOrder,
  getExecutedOrders,
  getOpenBuyLots,
  markOrderCancelled,
  applySellToOpenLots,
  getOpenPositionSummary,
  getRecentOpenBuyFromOtherSymbols,
  getActivePositionLifecycleStates,
  getPositionLifecycleState,
  updatePositionLifecycleState,
  markLifecycleAfterSell,
  getTradingStats,
  getTradingPerformance,
  getAccumulatedRendimiento,
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
    logger.debug(`?? Decision saved (ID: ${result.insertedId}) | user: ${chatId} | TP: ${decision.takeProfit} SL: ${decision.stopLoss}`);
    return { ...doc, _id: result.insertedId };
  } catch (err) {
    logger.error('Failed to save decision', err.message);
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
    logger.debug(`?? Portfolio snapshot saved (ID: ${result.insertedId}) | user: ${chatId}`);
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

export async function getDecisionById(id) {
  if (!id) return null;
  try {
    const db = await connectDB();
    const decisionsCollection = db.collection('decisions');
    const queryId = (typeof id === 'string') ? new ObjectId(id) : id;
    return await decisionsCollection.findOne({ _id: queryId });
  } catch (err) {
    logger.warn(`?? Failed to get decision by ID ${id}: ${err.message}`);
    return null;
  }
}
