/**
 * workflow/order-executor.js
 * Executes decisions: validates, applies safety buffers, and places orders
 */

import { OrderManager } from '../../revolut/orders.js';
import { notifyOrderExecuted, notifyError } from '../../telegram/handles.js';
import { saveOrder, applySellToOpenLots, markLifecycleAfterSell } from '../../services/mongo/mongo-service.js';
import { logger } from '../../utils/logger.js';
import { getAvailableUsdReal, getAvailableCoinReal } from './available-balance.js';
import { getHoldConfidenceThreshold } from '../context/prompts/confidence-threshold.js';
import { handleForcedExit } from './forced-exit.js';

export async function executeDecisions(
  decisions,
  coin,
  balanceArray,
  openOrders,
  realAvailableBalances,
  indicators,
  config,
  rendimiento = null,
  dbConnected = false,
  chatId = null,
  managedPositions = []
) {
  const execResults = [];
  let executedCount = 0, skippedCount = 0, errorCount = 0;

  const holdThreshold = getHoldConfidenceThreshold(config.trading?.personalityAgent);
  const maxTradeSizePct = normalizeMaxTradeSizePct(config.trading?.maxTradeSize);

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

    if (d.confidence < holdThreshold) {
      execResults.push({ ...d, rendimiento, status: 'skipped', reason: `Low confidence (${d.confidence}%)` });
      skippedCount++;
      continue;
    }

    let usd = null;

    const rawPositionPct = normalizeForAiPositionPct(d.positionPct ?? 0);

    const maxPctForAction = d.action === 'SELL' ? 100 : maxTradeSizePct;
    const effectivePositionPct = Number.isFinite(rawPositionPct) && rawPositionPct > 0
      ? clamp(rawPositionPct, 0, maxPctForAction)
      : 0;

    const positionPctDecimal = effectivePositionPct / 100;

    if (positionPctDecimal > 0) {
      // ── positionPct mode ────────────────────────────────────
      if (d.action === 'BUY') {
        const usdBalance = Number(
          realAvailableBalances?.availableByCurrency?.USD ??
          getAvailableUsdReal(balanceArray, openOrders)
        );

        usd = usdBalance * positionPctDecimal;

        logger.info(
          `📐 BUY positionPct=${effectivePositionPct.toFixed(0)}% of $${usdBalance.toFixed(2)} USD → $${usd.toFixed(2)}`
        );
      }

      if (d.action === 'SELL') {
        const normalizedSymbol = d.symbol.replace('/', '-');
        const baseCurrency = normalizedSymbol.split('-')[0];
        const currentPrice = indicators[normalizedSymbol]?.currentPrice || 0;

        // Option B: Sell ONLY based on bot-managed positions
        const managedPos = managedPositions.find(p => p.symbol.startsWith(baseCurrency + '-'));
        const coinManagedBalance = managedPos ? managedPos.qty : 0;

        const coinAvailableReal = Number(
          realAvailableBalances?.availableByCurrency?.[baseCurrency] ??
          getAvailableCoinReal(balanceArray, openOrders, normalizedSymbol)
        );

        const coinSellable = Math.min(coinManagedBalance, coinAvailableReal);

        if (currentPrice <= 0) {
          execResults.push({ ...d, rendimiento, status: 'error', error: `No current price for ${d.symbol}` });
          errorCount++;
          logger.error(`❌ No current price for ${d.symbol}, skipping SELL`);
          continue;
        }

        const qtyToSell = coinSellable * positionPctDecimal;
        usd = qtyToSell * currentPrice;

        logger.info(
          `📐 SELL positionPct=${effectivePositionPct.toFixed(0)}% of sellable ${coinSellable.toFixed(6)} ${baseCurrency} → $${usd.toFixed(2)}`
        );
      }
    } else {
      // ── Legacy usdAmount mode (backward compat) ────────────
      usd = parseFloat(d.usdAmount);
      logger.info(`💡 Legacy usdAmount mode: $${usd} for ${d.symbol}`);

      // Legacy SELL auto-fill if amount is missing
      if (d.action === 'SELL' && (isNaN(usd) || usd === 0)) {
        const baseCurrency = d.symbol.split('-')[0];
        const managedPos = managedPositions.find(p => p.symbol.startsWith(baseCurrency + '-'));
        const coinManagedBalance = managedPos ? managedPos.qty : 0;

        const coinAvailableReal = Number(
          realAvailableBalances?.availableByCurrency?.[baseCurrency] ??
          getAvailableCoinReal(balanceArray, openOrders, d.symbol)
        );

        const coinSellable = Math.min(coinManagedBalance, coinAvailableReal);
        const normalizedSymbol = d.symbol.replace('/', '-');
        const currentPrice = indicators[normalizedSymbol]?.currentPrice || 0;

        usd = parseFloat((coinSellable * currentPrice).toFixed(2));

        logger.info(
          `💱 SELL auto-fill (legacy sellable): ${coinSellable} ${baseCurrency} @ $${currentPrice} ≈ $${usd}`
        );
      }
    }

    // Store normalized decimal positionPct back on decision for auditing/persistence
    d.positionPct = positionPctDecimal;

    usd = parseFloat((usd || 0).toFixed(2));
    d.usdAmount = usd;

    if (d.action === 'BUY') {
      const usdAvailable = Number(
        realAvailableBalances?.availableByCurrency?.USD ??
        getAvailableUsdReal(balanceArray, openOrders)
      );

      if (usd > usdAvailable + 0.01) {
        execResults.push({
          ...d,
          rendimiento,
          status: 'skipped',
          reason: `Insufficient available USD ($${usdAvailable.toFixed(2)}) after open BUY limits`
        });
        skippedCount++;
        continue;
      }
    }

    if (d.action === 'SELL') {
      const normalizedSymbol = d.symbol.replace('/', '-');
      const baseCurrency = normalizedSymbol.split('-')[0];
      const currentPrice = indicators[normalizedSymbol]?.currentPrice || 0;

      const managedPos = managedPositions.find(p => p.symbol.startsWith(baseCurrency + '-'));
      const coinManagedBalance = managedPos ? managedPos.qty : 0;

      const coinAvailableReal = Number(
        realAvailableBalances?.availableByCurrency?.[baseCurrency] ??
        getAvailableCoinReal(balanceArray, openOrders, normalizedSymbol)
      );

      const coinSellable = Math.min(coinManagedBalance, coinAvailableReal);

      if (currentPrice > 0) {
        const qtyNeeded = usd / currentPrice;
        if (qtyNeeded > coinSellable + 0.00000001) {
          execResults.push({
            ...d,
            rendimiento,
            status: 'skipped',
            reason: `Insufficient available ${baseCurrency} (${coinSellable.toFixed(8)}) after open SELL limits`
          });
          skippedCount++;
          continue;
        }
      }
    }

    // ── Execute Forced Exit Logic (SL/TP) ─────────────────────
    const forcedResult = await handleForcedExit(d, {
      orders,
      openOrders,
      client,
      indicators,
      balanceArray,
      chatId
    });

    if (forcedResult.shouldSkip) {
      execResults.push({ ...d, rendimiento, status: 'skipped', reason: forcedResult.reason });
      skippedCount++;
      continue;
    }

    const minOrder = config.trading.minOrderUsd;
    usd = d.usdAmount || usd;

    if (isNaN(usd) || usd < minOrder) {
      execResults.push({
        ...d,
        rendimiento,
        status: 'skipped',
        reason: `Amount $${usd} < minimum $${minOrder}`
      });
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
          orderType: orderResult.type,
          usdAmount: usd.toFixed(2),
          price: currentPrice.toFixed(2),
        }, chatId);
      } catch (err) {
        logger.warn(`⚠️  Failed to notify order execution: ${err.message}`);
      }

      // Save order to MongoDB
      if (dbConnected && orderResult) {
        try {
          let orderRendimiento = null;
          let realizedPnlUsd = null;
          let realizedRoiPct = null;
          let fifoMatches = null;

          if (d.action.toLowerCase() === 'sell' && orderResult.qty && currentPrice) {
            const sellResult = await applySellToOpenLots(d.symbol, orderResult.qty, currentPrice, chatId);
            fifoMatches = sellResult.fifoMatches;
            realizedPnlUsd = sellResult.realizedPnlUsd;
            realizedRoiPct = sellResult.realizedRoiPct;
            orderRendimiento = sellResult.realizedRoiPct; // legacy fallback mapping

            logger.info(`📊 Realised FIFO performance for ${d.symbol}: ${orderRendimiento}% (PnL: $${realizedPnlUsd})`);
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
            chatId,
            realizedPnlUsd,
            realizedRoiPct,
            fifoMatches,
            forced: d.forced === true,
            forcedReason: d.forcedReason || null,
            defensive: d.defensive === true,
            defensiveReason: d.defensiveReason || null,
            lifecyclePhase: d.lifecyclePhase || null,
            riskFactors: d.riskFactors || [],
            maxRoiSeen: d.maxRoiSeen,
            currentRoi: d.currentRoi,
            profitRetracementPct: d.profitRetracementPct,
            positionLifecyclePhase: d.positionLifecyclePhase || null,
            fifoMatched: typeof d.fifoMatched === 'boolean' ? d.fifoMatched : null
          });

          if (d.action.toLowerCase() === 'sell') {
            try {
              const cooldownMinutes = Number(config?.trading?.postSellCooldownMinutes ?? 360);
              await markLifecycleAfterSell({
                symbol: d.symbol,
                chatId,
                actionType: d.defensive ? 'DEFENSIVE_SELL' : (d.forcedReason || 'SELL'),
                cooldownMinutes,
                riskFactors: Array.isArray(d.riskFactors) ? d.riskFactors : null,
                phase: d.lifecyclePhase || d.positionLifecyclePhase || null
              });
            } catch (err) {
              logger.warn(`⚠️ Failed to mark lifecycle cooldown for ${d.symbol}: ${err.message}`);
            }
          }
        } catch (err) {
          logger.warn(`⚠️  Failed to save order: ${err.message}`);
        }
      }
    } catch (err) {
      execResults.push({ ...d, rendimiento, status: 'error', error: err.message });
      errorCount++;
      logger.error(`❌ ${d.symbol}: ${err.message}`);
      await notifyError(`Order failed for ${d.symbol}: ${err.message}`, chatId).catch(() => { });
    }
  }

  return { execResults, executedCount, skippedCount, errorCount };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeForAiPositionPct(rawValue) {
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n <= 0) return 0;

  if (n > 0 && n <= 1) {
    return n * 100;
  }

  return n;
}

function normalizeMaxTradeSizePct(rawValue) {
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n <= 0) return 25;

  if (n > 0 && n <= 1) {
    return n * 100;
  }

  return n;
}

