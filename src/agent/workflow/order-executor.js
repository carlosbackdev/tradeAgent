/**
 * workflow/order-executor.js
 * Executes decisions: validates, applies safety buffers, and places orders
 */

import { OrderManager } from '../../revolut/orders.js';
import { notifyOrderExecuted, notifyError } from '../../telegram/handles.js';
import { saveOrder } from '../../utils/mongodb.js';
import { logger } from '../../utils/logger.js';

export async function executeDecisions(decisions, coin, balanceArray, indicators, lastOrder, config, rendimiento = null, dbConnected = false) {
  const execResults = [];
  let executedCount = 0, skippedCount = 0, errorCount = 0;

  // Initialize OrderManager for placing orders
  const { RevolutClient } = await import('../../revolut/client.js');
  const client = new RevolutClient();
  const orders = new OrderManager(client);

  for (const d of decisions) {
    if (!d.symbol) continue;

    // ── Guards ────────────────────────────────────────────────
    if (d.action === 'HOLD') {
      execResults.push({ ...d, rendimiento, status: 'skipped', reason: 'HOLD decision' });
      skippedCount++;
      continue;
    }

    if (d.confidence < 55) {
      execResults.push({ ...d, rendimiento, status: 'skipped', reason: `Low confidence (${d.confidence}%)` });
      skippedCount++;
      continue;
    }

    let usd = parseFloat(d.usdAmount);

    // Auto-fill SELL orders if amount is missing/0
    if (d.action === 'SELL' && (isNaN(usd) || usd === 0)) {
      const baseCurrency = d.symbol.split('-')[0];
      const baseBalance = parseFloat(balanceArray.find(b => b.currency === baseCurrency)?.total || 0);
      const normalizedSymbol = d.symbol.replace('/', '-');
      const currentPrice = indicators[normalizedSymbol]?.currentPrice || 0;
      // 99.5% buffer for SELL auto-fills
      usd = parseFloat((baseBalance * currentPrice * 0.995).toFixed(2));
      d.usdAmount = usd;
      logger.info(`💱 SELL auto-fill: ${baseBalance} ${baseCurrency} @ $${currentPrice} ≈ $${d.usdAmount} (99.5% buffer)`);
    }

    // ── Safety Buffers to avoid Revolut "Insufficient Balance" errors ──

    if (d.action === 'BUY') {
      const usdBalance = parseFloat(balanceArray.find(b => b.currency === 'USD')?.total || 0);
      const maxAllowedBuy = parseFloat((usdBalance * 0.995).toFixed(2)); // Keep 0.5% for fees/slippage
      if (usd > maxAllowedBuy) {
        logger.info(`🛡️ BUY amount capped: $${usd} → $${maxAllowedBuy} (99.5% of balance to cover fees)`);
        usd = maxAllowedBuy;
        d.usdAmount = usd;
      }
    }

    if (d.action === 'SELL') {
      const baseCurrency = d.symbol.split('-')[0];
      const baseBalance = parseFloat(balanceArray.find(b => b.currency === baseCurrency)?.total || 0);
      const normalizedSymbol = d.symbol.replace('/', '-');
      const currentPrice = indicators[normalizedSymbol]?.currentPrice || 0;
      if (currentPrice > 0 && baseBalance > 0) {
        const maxSellUsd = parseFloat((baseBalance * currentPrice * 0.995).toFixed(2)); // 99.5% for sell
        if (usd > maxSellUsd) {
          logger.info(`🛡️ SELL amount capped: $${usd} → $${maxSellUsd} (99.5% for safety)`);
          usd = maxSellUsd;
          d.usdAmount = usd;
        }
      }
    }

    const minOrder = config.trading.minOrderUsd;
    if (isNaN(usd) || usd < minOrder) {
      execResults.push({ ...d, rendimiento, status: 'skipped', reason: `Amount $${usd} < minimum $${minOrder}` });
      skippedCount++;
      continue;
    }

    // ── Execute ───────────────────────────────────────────────
    try {
      const normalizedSymbol = d.symbol.replace('/', '-');
      const currentPrice = indicators[normalizedSymbol]?.currentPrice;
      if (!currentPrice) throw new Error(`No current price in indicators for ${d.symbol}`);

      let rrMetrics = null;
      if (d.takeProfit && d.stopLoss) {
        rrMetrics = OrderManager.calcRiskReward(
          currentPrice,
          parseFloat(d.takeProfit),
          parseFloat(d.stopLoss),
          d.action.toLowerCase()
        );
      }

      logger.info(
        `💼 ${d.action} ${d.symbol}: $${usd}` +
        (rrMetrics ? ` | R/R: ${rrMetrics.riskRewardRatio}` : '')
      );

      const orderResult = await orders.placeOrder({
        symbol: d.symbol,
        side: d.action.toLowerCase(),
        type: d.orderType ?? 'market',
        usdAmount: usd,
        price: d.limitPrice,
        currentPrice: currentPrice,
        takeProfit: d.takeProfit,
        stopLoss: d.stopLoss,
      });

      execResults.push({ ...d, rendimiento, status: 'executed', usdAmount: usd, orderResult, rrMetrics });
      executedCount++;

      // 🔔 Notify order execution immediately
      try {
        await notifyOrderExecuted({
          symbol: d.symbol,
          side: d.action.toLowerCase(),
          qty: orderResult.qty || 'pte.',
          usdAmount: usd.toFixed(2),
          price: currentPrice.toFixed(2),
        });
      } catch (err) {
        logger.warn(`⚠️  Failed to notify order execution: ${err.message}`);
      }

      // Save order to MongoDB
      if (dbConnected && orderResult) {
        try {
          let orderRendimiento = null;
          if (d.action.toLowerCase() === 'sell' && lastOrder?.price && currentPrice) {
            orderRendimiento = parseFloat(
              (((currentPrice - lastOrder.price) / lastOrder.price) * 100).toFixed(2)
            );
            logger.info(`📊 Realised rendimiento for ${d.symbol}: ${orderRendimiento}% (entry $${lastOrder.price} → exit $${currentPrice})`);
          }

          await saveOrder({
            decisionId: d.mongoDecisionId,
            symbol: d.symbol,
            side: d.action.toLowerCase(),
            orderType: d.orderType || 'market',
            qty: orderResult.qty || '',
            price: currentPrice,
            usdAmount: usd,
            revolutOrderId: orderResult.venue_order_id || orderResult.orderId || '',
            takeProfit: d.takeProfit || null,
            stopLoss: d.stopLoss || null,
            riskRewardRatio: rrMetrics?.riskRewardRatio || null,
            status: 'executed',
            rendimiento: orderRendimiento,
          });
        } catch (err) {
          logger.warn(`⚠️  Failed to save order: ${err.message}`);
        }
      }
    } catch (err) {
      execResults.push({ ...d, rendimiento, status: 'error', error: err.message });
      errorCount++;
      logger.error(`❌ ${d.symbol}: ${err.message}`);
      await notifyError(`Order failed for ${d.symbol}: ${err.message}`).catch(() => { });
    }
  }

  return { execResults, executedCount, skippedCount, errorCount };
}
