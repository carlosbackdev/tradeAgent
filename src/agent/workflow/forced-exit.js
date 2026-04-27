/**
 * workflow/forced-exit.js
 * Handles emergency exits (Stop Loss / Take Profit) by clearing open orders and refreshing balance.
 */

import { logger } from '../../utils/logger.js';
import { getOpenPositionSummary } from '../../services/mongo/mongo-service.js';

/**
 * Checks if a decision is a forced exit and handles order cancellation and balance refresh.
 * Returns true if the loop should continue.
 * Modifies the decision object in place if needed.
 */
export async function handleForcedExit(d, {
  orders,
  openOrders,
  client,
  indicators,
  balanceArray = [],
  chatId
}) {
  const isForcedExit =
    d.forced === true ||
    (d.confidence === 100 && String(d.reasoning || '').includes('Forced'));

  if (!isForcedExit || d.action !== 'SELL') {
    return { shouldSkip: false };
  }

  const normalizedSymbol = d.symbol.replace('/', '-');
  const baseCurrency = normalizedSymbol.split('-')[0];
  const currentPrice = Number(indicators?.[normalizedSymbol]?.currentPrice || d.price || 0);

  logger.warn(`🚨 Handling forced ${d.forcedReason || 'EXIT'} for ${normalizedSymbol}`);

  // 1. Cancel open SELL orders for this symbol first.
  const cancelledSellOrders = await cancelOpenSellOrdersForSymbol({
    orders,
    symbol: normalizedSymbol,
    openOrders,
    reason: d.forcedReason || 'FORCED_EXIT'
  });

  // 2. Refresh balances, but do not depend on client.getBalances().
  const availableBaseQty = await resolveAvailableBaseQty({
    client,
    balanceArray,
    baseCurrency,
    cancelledSellOrders,
    openOrders,
    symbol: normalizedSymbol
  });

  // 3. Get FIFO position quantity.
  const openPositionSummary = await getOpenPositionSummary(normalizedSymbol, currentPrice, chatId);

  const fifoQty = Number(
    openPositionSummary?.totalQty ??
    openPositionSummary?.qty ??
    0
  );

  logger.warn(
    `🧮 Forced ${d.forcedReason || 'EXIT'} ${normalizedSymbol} qty check: ` +
    `availableBaseQty=${availableBaseQty}, fifoQty=${fifoQty}, openLots=${openPositionSummary?.openLots?.length || 0}`
  );

  if (openPositionSummary?.openLots?.length > 0) {
    for (const lot of openPositionSummary.openLots) {
      logger.info(
        `📦 FIFO lot ${normalizedSymbol}: id=${lot._id}, remaining_qty=${lot.remaining_qty}, lot_status=${lot.lot_status}`
      );
    }
  }

  /**
   * Normal safe case:
   * Sell only the minimum between exchange available qty and FIFO qty.
   */
  let qtyToSell = 0;

  if (availableBaseQty > 0 && fifoQty > 0) {
    qtyToSell = Math.min(availableBaseQty, fifoQty);
  }

  /**
   * Defensive forced STOP_LOSS fallback:
   * If exchange says there is available balance but FIFO is 0,
   * do not block emergency exit. Sell exchange balance defensively.
   *
   * This avoids being trapped because Mongo/FIFO is temporarily out of sync.
   */
  if (qtyToSell <= 0 && d.forcedReason === 'STOP_LOSS' && availableBaseQty > 0) {
    qtyToSell = availableBaseQty;
    d.fifoMatched = false;

    logger.warn(
      `⚠️ No FIFO qty found for ${normalizedSymbol}, but exchange available balance exists. ` +
      `Executing defensive STOP_LOSS with availableBaseQty=${availableBaseQty}`
    );
  }

  if (qtyToSell <= 0) {
    logger.warn(
      `⚠️ Forced ${d.forcedReason || 'EXIT'} skipped for ${normalizedSymbol}: ` +
      `no available qty (${availableBaseQty}) or no FIFO position (${fifoQty})`
    );

    return {
      shouldSkip: true,
      reason: `No qty to sell after cancellation. available=${availableBaseQty}, fifo=${fifoQty}`
    };
  }

  if (!currentPrice || currentPrice <= 0) {
    logger.warn(`⚠️ Forced ${d.forcedReason || 'EXIT'} skipped for ${normalizedSymbol}: invalid current price ${currentPrice}`);
    return {
      shouldSkip: true,
      reason: `Invalid current price ${currentPrice}`
    };
  }

  /**
   * Your executor is using legacy usdAmount SELL mode.
   * Keep usdAmount, but base it on corrected qty.
   */
  const refreshedUsdAmount = qtyToSell * currentPrice * 0.999;

  d.usdAmount = Number(refreshedUsdAmount.toFixed(2));
  d.qty = Number(qtyToSell.toFixed(8));
  d.symbol = normalizedSymbol;
  d.orderType = d.orderType || 'market';

  logger.warn(
    `🔴 Forced ${d.forcedReason || 'EXIT'} executing ${normalizedSymbol}: ` +
    `qty=${d.qty}, usdAmount=$${d.usdAmount}, price=${currentPrice}`
  );

  return { shouldSkip: false };
}

/**
 * Resolve available base quantity after cancelling open SELL limits.
 * Avoids calling non-existing client.getBalances().
 */
async function resolveAvailableBaseQty({
  client,
  balanceArray = [],
  baseCurrency,
  cancelledSellOrders = [],
  openOrders = [],
  symbol
}) {
  // 1. Try known possible client methods safely.
  const refreshCandidates = [
    'getBalances',
    'getBalance',
    'fetchBalances',
    'fetchBalance',
    'getAccounts',
    'getPortfolio'
  ];

  for (const methodName of refreshCandidates) {
    if (typeof client?.[methodName] !== 'function') continue;

    try {
      const refreshed = await client[methodName]();
      const balanceData = normalizeBalancesResponse(refreshed);
      const baseBal = balanceData.find((b) => String(b.currency).toUpperCase() === baseCurrency);

      const available = Number(baseBal?.available ?? baseBal?.total ?? baseBal?.amount ?? 0);

      if (Number.isFinite(available) && available > 0) {
        logger.info(`🔄 Refreshed ${baseCurrency} balance via ${methodName}: ${available}`);
        return available;
      }
    } catch (err) {
      logger.warn(`⚠️ Failed refreshing balances via ${methodName}: ${err.message}`);
    }
  }

  /**
   * 2. Fallback to last known balanceArray.
   * Prefer available, but after cancelling SELL orders total can be safer if available is stale.
   */
  const baseBal = (balanceArray || []).find((b) => String(b.currency).toUpperCase() === baseCurrency);

  let fallbackQty = Number(baseBal?.available ?? 0);

  if (!Number.isFinite(fallbackQty) || fallbackQty <= 0) {
    fallbackQty = Number(baseBal?.total ?? baseBal?.amount ?? 0);
  }

  /**
   * 3. If we cancelled SELL orders, old available might still be stale.
   * Estimate released quantity from cancelled open SELL orders for same symbol.
   */
  if (cancelledSellOrders.length > 0) {
    const normalizedSymbol = symbol.replace('/', '-');

    const releasedQty = (openOrders || [])
      .filter((order) => {
        const orderId = order.id || order.orderId || order.revolut_order_id;
        const orderSymbol = String(order.symbol || order.instrument || '').replace('/', '-');
        const side = String(order.side || '').toLowerCase();

        return cancelledSellOrders.includes(orderId) &&
          orderSymbol === normalizedSymbol &&
          side === 'sell';
      })
      .reduce((sum, order) => {
        return sum + Number(order.qty || order.quantity || order.base_size || order.size || 0);
      }, 0);

    if (releasedQty > 0) {
      fallbackQty = Math.max(fallbackQty, releasedQty);
      logger.warn(`🔄 Estimated released ${baseCurrency} qty from cancelled SELL orders: ${releasedQty}`);
    }
  }

  logger.warn(`⚠️ Using fallback ${baseCurrency} balance: ${fallbackQty}`);

  return Number.isFinite(fallbackQty) ? fallbackQty : 0;
}

function normalizeBalancesResponse(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.balances)) return response.balances;
  if (Array.isArray(response?.data?.balances)) return response.data.balances;
  if (Array.isArray(response?.accounts)) return response.accounts;
  if (Array.isArray(response?.data?.accounts)) return response.data.accounts;

  return [];
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