/**
 * workflow/forced-exit.js
 * Handles emergency exits (Stop Loss / Take Profit) by clearing open orders and refreshing balance.
 */

import { logger } from '../../utils/logger.js';
import { getOpenPositionSummary } from '../../services/mongo/mongo-service.js';

/**
 * Checks if a decision is a forced exit and handles order cancellation and balance refresh.
 * Returns true if the loop should continue (e.g. if the forced exit was skipped).
 * Modifies the decision object in place if needed.
 */
export async function handleForcedExit(d, {
  orders,
  openOrders,
  client,
  indicators,
  balanceArray,
  chatId
}) {
  const isForcedExit = d.forced === true || (d.confidence === 100 && String(d.reasoning || '').includes('Forced'));

  if (!isForcedExit || d.action !== 'SELL') {
    return { shouldSkip: false };
  }

  const normalizedSymbol = d.symbol.replace('/', '-');
  const baseCurrency = normalizedSymbol.split('-')[0];
  const currentPrice = indicators[normalizedSymbol]?.currentPrice || 0;

  // 1. Cancel open SELL orders for this symbol
  await cancelOpenSellOrdersForSymbol({
    orders,
    symbol: d.symbol,
    openOrders,
    reason: d.forcedReason || 'FORCED_EXIT'
  });

  // 2. Refresh balances to get real available qty
  let availableBaseQty = 0;
  try {
    const refreshedBalances = await client.getBalances();
    const balanceData = refreshedBalances?.data || refreshedBalances || [];
    const baseBal = balanceData.find(b => b.currency === baseCurrency);
    // On Revolut X, 'available' might be in a different field or we might need to assume total is available after cancellation
    availableBaseQty = Number(baseBal?.available ?? baseBal?.total ?? 0);
    logger.info(`🔄 Refreshed ${baseCurrency} balance after cancellation: ${availableBaseQty}`);
  } catch (err) {
    logger.warn(`⚠️ Failed to refresh balances after cancellation: ${err.message}. Using last known data.`);
    const baseBal = balanceArray.find(b => b.currency === baseCurrency);
    availableBaseQty = Number(baseBal?.total || 0);
  }

  // 3. Get FIFO position quantity to avoid selling manual holdings
  const openPositionSummary = await getOpenPositionSummary(d.symbol, currentPrice, chatId);
  const fifoQty = Number(openPositionSummary?.totalQty || openPositionSummary?.qty || 0);

  // 4. Calculate final sellable quantity (min of available and FIFO)
  const qtyToSell = Math.min(availableBaseQty, fifoQty);

  if (qtyToSell <= 0) {
    logger.warn(`⚠️ Forced ${d.forcedReason || 'EXIT'} skipped for ${d.symbol}: no available qty (${availableBaseQty}) or no FIFO position (${fifoQty})`);
    return { shouldSkip: true, reason: 'No qty to sell after cancellation' };
  }

  // 5. Update usdAmount for the market order
  const refreshedUsdAmount = qtyToSell * currentPrice * 0.999;
  d.usdAmount = Number(refreshedUsdAmount.toFixed(2));

  logger.warn(`🔴 Forced ${d.forcedReason || 'EXIT'} executing ${d.symbol} with available qty ${qtyToSell.toFixed(8)} ($${d.usdAmount})`);
  
  return { shouldSkip: false };
}

/**
 * Cancels all open SELL orders for a specific symbol.
 * Useful before executing a forced SL/TP market exit.
 */
async function cancelOpenSellOrdersForSymbol({ orders, symbol, openOrders = [], reason }) {
  const normalizedSymbol = symbol.replace('/', '-');

  const sellOrders = (openOrders || []).filter((order) => {
    const orderSymbol = String(order.symbol || order.instrument || '').replace('/', '-');
    const side = String(order.side || '').toLowerCase();
    const status = String(order.status || '').toLowerCase();

    const isSameSymbol = orderSymbol === normalizedSymbol;
    const isSell = side === 'sell';
    const isOpen = !['filled', 'executed', 'cancelled', 'canceled', 'rejected', 'failed'].includes(status);

    return isSameSymbol && isSell && isOpen;
  });

  if (sellOrders.length === 0) {
    logger.info(`ℹ️ No open SELL orders to cancel for ${normalizedSymbol} before ${reason}`);
    return [];
  }

  const cancelled = [];

  for (const order of sellOrders) {
    const orderId = order.id || order.orderId || order.revolut_order_id;

    if (!orderId) {
      logger.warn(`⚠️ Cannot cancel SELL order for ${normalizedSymbol}: missing order id`);
      continue;
    }

    try {
      await orders.cancelOrder(orderId);
      cancelled.push(orderId);
      logger.warn(`🧹 Cancelled open SELL order ${orderId} for ${normalizedSymbol} before ${reason}`);
    } catch (err) {
      logger.warn(`⚠️ Failed to cancel SELL order ${orderId} for ${normalizedSymbol}: ${err.message}`);
    }
  }

  return cancelled;
}
