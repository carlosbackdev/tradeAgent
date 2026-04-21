/**
 * workflow/order-executor.js
 * Executes decisions: validates, applies safety buffers, and places orders
 */

import { OrderManager } from '../../revolut/orders.js';
import { notifyOrderExecuted, notifyError } from '../../telegram/handles.js';
import { saveOrder } from '../../utils/mongodb.js';
import { logger } from '../../utils/logger.js';

// ── Position-sizing helpers ────────────────────────────────────────

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getAvailableUsd(balanceArray) {
  return parseFloat(balanceArray.find(b => b.currency === 'USD')?.total || 0);
}

function getAvailableCoin(balanceArray, symbol) {
  // symbol might be 'BTC-USD' or 'BTC/USD'
  const baseCurrency = symbol.replace('/', '-').split('-')[0];
  return parseFloat(balanceArray.find(b => b.currency === baseCurrency)?.total || 0);
}

export async function executeDecisions(decisions, coin, balanceArray, indicators, lastOrder, config, rendimiento = null, dbConnected = false, chatId = null) {
  const execResults = [];
  let executedCount = 0, skippedCount = 0, errorCount = 0;

  // Initialize OrderManager for placing orders
  const { RevolutClient } = await import('../../revolut/client.js');
  const client = new RevolutClient(config);
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

    let usd = null;
    const rawPositionPct = Number(d.positionPct ?? 0);
    const positionPct = Number.isFinite(rawPositionPct) && rawPositionPct > 0
      ? clamp(rawPositionPct, 0, config.trading.maxTradeSize)
      : 0;

    if (positionPct > 0) {
      // ── positionPct mode (new) ──────────────────────────────
      if (d.action === 'BUY') {
        const usdBalance = getAvailableUsd(balanceArray);
        usd = usdBalance * positionPct;
        logger.info(`📐 BUY positionPct=${(positionPct * 100).toFixed(0)}% of $${usdBalance.toFixed(2)} USD → $${usd.toFixed(2)}`);
      }

      if (d.action === 'SELL') {
        const normalizedSymbol = d.symbol.replace('/', '-');
        const currentPrice = indicators[normalizedSymbol]?.currentPrice || 0;
        const coinBalance = getAvailableCoin(balanceArray, d.symbol);

        if (currentPrice <= 0) {
          execResults.push({ ...d, rendimiento, status: 'error', error: `No current price for ${d.symbol}` });
          errorCount++;
          logger.error(`❌ No current price for ${d.symbol}, skipping SELL`);
          continue;
        }

        const qtyToSell = coinBalance * positionPct;
        usd = qtyToSell * currentPrice;
        logger.info(`📐 SELL positionPct=${(positionPct * 100).toFixed(0)}% of ${coinBalance.toFixed(6)} ${d.symbol.split('-')[0]} → $${usd.toFixed(2)}`);
      }
    } else {
      // ── Legacy usdAmount mode (backward compat) ────────────
      usd = parseFloat(d.usdAmount);
      logger.info(`💡 Legacy usdAmount mode: $${usd} for ${d.symbol}`);

      // Legacy SELL auto-fill if amount is missing
      if (d.action === 'SELL' && (isNaN(usd) || usd === 0)) {
        const baseCurrency = d.symbol.split('-')[0];
        const baseBalance = parseFloat(balanceArray.find(b => b.currency === baseCurrency)?.total || 0);
        const normalizedSymbol = d.symbol.replace('/', '-');
        const currentPrice = indicators[normalizedSymbol]?.currentPrice || 0;
        usd = parseFloat((baseBalance * currentPrice).toFixed(2));
        logger.info(`💱 SELL auto-fill (legacy): ${baseBalance} ${baseCurrency} @ $${currentPrice} ≈ $${usd}`);
      }
    }

    // Store calculated positionPct back on decision for auditing
    d.positionPct = positionPct;

    usd = parseFloat((usd || 0).toFixed(2));
    d.usdAmount = usd;

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
            positionPct: d.positionPct || 0,
            usdAmount: usd,
            revolutOrderId: orderResult.venue_order_id || orderResult.orderId || '',
            takeProfit: d.takeProfit || null,
            stopLoss: d.stopLoss || null,
            riskRewardRatio: rrMetrics?.riskRewardRatio || null,
            status: 'executed',
            rendimiento: orderRendimiento,
            chatId
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
