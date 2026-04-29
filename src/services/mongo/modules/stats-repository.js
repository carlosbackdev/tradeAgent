import { connectDB } from '../client.js';
import { logger, withActiveOrders } from './shared.js';

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
    const [orders, totalDecisions] = await Promise.all([
      ordersCollection.find(withActiveOrders({ ...query, status: 'executed', price: { $ne: null }, qty: { $ne: null } })).sort({ created_at: 1 }).toArray(),
      decisionsCollection.countDocuments(query)
    ]);

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

        const trackedPosKey = Object.keys(positions).find((k) => k.startsWith(realBal.currency + '-'));
        const botQty = trackedPosKey && positions[trackedPosKey]
          ? positions[trackedPosKey].openLots.reduce((sum, l) => sum + l.qty, 0)
          : 0;

        if (botQty > realQty) {
          const factor = realQty > 0 ? (realQty / botQty) : 0;
          if (positions[trackedPosKey] && positions[trackedPosKey].openLots) {
            positions[trackedPosKey].openLots.forEach((lot) => { lot.qty *= factor; });
          }
        } else if (realQty > botQty) {
          manualPositions.push({
            symbol: realBal.currency + '-USD',
            qty: Number((realQty - botQty).toFixed(8)),
          });
        }
      }
    }

    const totalRoiPct = totalInvested > 0
      ? Number(((totalRealizedPnL / totalInvested) * 100).toFixed(2))
      : 0;

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
        .filter((p) => p.qty > 0 && p.totalCost >= 1),
      manualPositions,
      accumulatedRendimiento: totalRoiPct,
    };
  } catch (err) {
    logger.error('Failed to get trading performance', err.message);
    return null;
  }
}

export async function getAccumulatedRendimiento(chatId = null) {
  const performance = await getTradingPerformance(chatId);
  const n = Number(performance?.accumulatedRendimiento);
  return Number.isFinite(n) ? n : 0;
}
