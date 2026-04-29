/**
 * workflow/order-executor.js
 * Executes validated decisions and sends prepared orders to Revolut.
 */

import { OrderManager } from '../../revolut/orders.js';
import { notifyOrderExecuted, notifyError } from '../../telegram/handles.js';
import {
  saveOrder,
  applySellToOpenLots,
  markLifecycleAfterSell,
  getOpenPositionSummary,
  updatePositionLifecycleState
} from '../../services/mongo/mongo-service.js';
import { logger } from '../../utils/logger.js';
import { getHoldConfidenceThreshold } from '../context/prompts/confidence-threshold.js';
import { handleForcedExit } from './forced-exit.js';
import { buildExecutableOrderSize } from './sizing/order-sizing.js';
import { buildExecutionNotificationPayload } from './report/trading-report.js';
import {
  isBlockedHoldDecision,
  isExchangeRejectionError,
  notifyDefensiveSell,
  notifyExchangeRejection,
  notifyHoldBlocked
} from './report/risk-alerts.js';

export async function executeDecisions(
  decisions,
  _coin,
  balanceArray,
  openOrders,
  realAvailableBalances,
  indicators,
  config,
  historicalRendimiento = null,
  dbConnected = false,
  chatId = null,
  managedPositions = []
) {
  const execResults = [];
  let executedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  const holdThreshold = getHoldConfidenceThreshold(config.trading?.personalityAgent);
  const maxTradeSizePct = normalizeMaxTradeSizePct(config.trading?.maxTradeSize);

  const { RevolutClient } = await import('../../revolut/client.js');
  const client = new RevolutClient(config);
  const orders = new OrderManager(client);

  for (const d of decisions) {
    if (!d?.symbol) continue;

    if (String(d.action).toUpperCase() === 'HOLD') {
      execResults.push({ ...d, rendimiento: historicalRendimiento, status: 'skipped', reason: 'HOLD decision' });
      if (isBlockedHoldDecision(d)) {
        await notifyHoldBlocked(d, chatId).catch(() => { });
      }
      skippedCount++;
      continue;
    }

    if (Number(d.confidence || 0) < holdThreshold) {
      execResults.push({ ...d, rendimiento: historicalRendimiento, status: 'skipped', reason: `Low confidence (${d.confidence}%)` });
      skippedCount++;
      continue;
    }

    let sizingPlan;
    try {
      sizingPlan = buildExecutableOrderSize({
        decision: d,
        balanceArray,
        openOrders,
        realAvailableBalances,
        indicators,
        managedPositions,
        maxTradeSizePct
      });
    } catch (err) {
      execResults.push({ ...d, rendimiento: historicalRendimiento, status: 'error', error: err.message });
      errorCount++;
      logger.error(`Order sizing failed for ${d.symbol}: ${err.message}`);
      continue;
    }

    d.positionPct = Number(sizingPlan.positionPctDecimal || 0);
    d.baseAmount = Number.isFinite(Number(sizingPlan.baseAmount)) && Number(sizingPlan.baseAmount) > 0
      ? Number(sizingPlan.baseAmount)
      : null;
    d.usdAmount = Number(sizingPlan.usdAmount || 0);

    if (String(d.action).toUpperCase() === 'BUY' && d.positionPct > 0) {
      logger.info(
        `BUY sizing ${d.symbol}: pct=${Number(sizingPlan.effectivePositionPct || 0).toFixed(0)}% ` +
        `of $${Number(sizingPlan.usdAvailable || 0).toFixed(2)} -> $${Number(d.usdAmount).toFixed(2)}`
      );
    }

    if (String(d.action).toUpperCase() === 'SELL' && d.positionPct > 0) {
      logger.info(
        `SELL sizing ${d.symbol}: pct=${Number(sizingPlan.effectivePositionPct || 0).toFixed(0)}% ` +
        `sellable=${Number(sizingPlan.sellableCrypto || 0).toFixed(8)} ${sizingPlan.baseCurrency || ''} ` +
        `-> base=${Number(d.baseAmount || 0).toFixed(8)} (~$${Number(d.usdAmount).toFixed(2)})`
      );
    }

    if (d.positionPct <= 0) {
      logger.info(`Legacy usdAmount mode: $${Number(d.usdAmount || 0).toFixed(2)} for ${d.symbol}`);
    }

    if (String(d.action).toUpperCase() === 'BUY') {
      const usdAvailable = Number(sizingPlan?.usdAvailable || 0);
      if (d.usdAmount > usdAvailable + 0.01) {
        execResults.push({
          ...d,
          rendimiento: historicalRendimiento,
          status: 'skipped',
          reason: `Insufficient available USD ($${usdAvailable.toFixed(2)}) after open BUY limits`
        });
        skippedCount++;
        continue;
      }
    }

    if (String(d.action).toUpperCase() === 'SELL') {
      const sellableCrypto = Number(sizingPlan?.sellableCrypto || 0);
      const baseNeeded = Number(d.baseAmount || 0);
      const baseCurrency = sizingPlan?.baseCurrency || d.symbol.replace('/', '-').split('-')[0];

      if (baseNeeded > 0 && baseNeeded > sellableCrypto + 0.00000001) {
        execResults.push({
          ...d,
          rendimiento: historicalRendimiento,
          status: 'skipped',
          reason: `Insufficient available ${baseCurrency} (${sellableCrypto.toFixed(8)}) after open SELL limits`
        });
        skippedCount++;
        continue;
      }
    }

    const forcedResult = await handleForcedExit(d, {
      orders,
      openOrders,
      client,
      indicators,
      balanceArray,
      chatId,
      config
    });

    if (forcedResult.shouldSkip) {
      execResults.push({ ...d, rendimiento: historicalRendimiento, status: 'skipped', reason: forcedResult.reason });
      skippedCount++;
      continue;
    }

    const minOrder = Number(config.trading.minOrderUsd || 0);
    const usd = Number(d.usdAmount || 0);

    if (String(d.action).toUpperCase() === 'BUY' && (!Number.isFinite(usd) || usd < minOrder)) {
      execResults.push({
        ...d,
        rendimiento: historicalRendimiento,
        status: 'skipped',
        reason: `Amount $${usd} < minimum $${minOrder}`
      });
      skippedCount++;
      continue;
    }

    try {
      const normalizedSymbol = d.symbol.replace('/', '-');
      const currentPrice = Number(indicators[normalizedSymbol]?.currentPrice || 0);
      if (!currentPrice) throw new Error(`No current price in indicators for ${d.symbol}`);

      let rrMetrics = null;
      if (d.takeProfit && d.stopLoss) {
        rrMetrics = OrderManager.calcRiskReward(
          currentPrice,
          parseFloat(d.takeProfit),
          parseFloat(d.stopLoss),
          String(d.action).toLowerCase()
        );
      }

      logger.info(
        `EXEC ${d.action} ${d.symbol}: usd=$${usd.toFixed(2)} base=${Number(d.baseAmount || 0).toFixed(8)}` +
        (rrMetrics ? ` | R/R: ${rrMetrics.riskRewardRatio}` : '')
      );

      const orderResult = await orders.placeOrder({
        symbol: d.symbol,
        side: String(d.action).toLowerCase(),
        type: d.orderType ?? 'market',
        usdAmount: usd,
        baseAmount: d.baseAmount,
        price: d.limitPrice,
        currentPrice,
        takeProfit: d.takeProfit,
        stopLoss: d.stopLoss
      });

      execResults.push({ ...d, rendimiento: historicalRendimiento, status: 'executed', usdAmount: usd, orderResult, rrMetrics });
      executedCount++;

      if (d.defensive === true && String(d.action).toUpperCase() === 'SELL') {
        await notifyDefensiveSell(d, usd, chatId).catch(() => { });
      }

      try {
        const messagePayload = buildExecutionNotificationPayload({
          decision: d,
          orderResult,
          usdAmount: usd,
          currentPrice
        });
        await notifyOrderExecuted(messagePayload, chatId);
      } catch (err) {
        logger.warn(`Failed to notify order execution: ${err.message}`);
      }

      if (dbConnected && orderResult) {
        try {
          let orderRendimiento = Number.isFinite(Number(historicalRendimiento)) ? Number(historicalRendimiento) : null;
          let realizedPnlUsd = null;
          let realizedRoiPct = null;
          let fifoMatches = null;

          if (String(d.action).toLowerCase() === 'sell' && orderResult.qty && currentPrice) {
            const normalizedPositionPct = Number(d.positionPct || 0);
            const isSellAllIntent = normalizedPositionPct >= 0.999 ||
              String(d.summaryReasoning || '').toLowerCase().includes('sell 100% para evitar residual no operable');
            const residualCloseBelowUsd = isSellAllIntent
              ? Number(config?.trading?.sellAllResidualUsdThreshold ?? 4)
              : 0;

            const sellResult = await applySellToOpenLots(
              d.symbol,
              orderResult.qty,
              currentPrice,
              chatId,
              { residualCloseBelowUsd }
            );
            fifoMatches = sellResult.fifoMatches;
            realizedPnlUsd = sellResult.realizedPnlUsd;
            realizedRoiPct = sellResult.realizedRoiPct;
            logger.info(`Realized FIFO performance for ${d.symbol}: ${sellResult.realizedRoiPct}% (PnL: $${realizedPnlUsd})`);

            if (Number(sellResult.autoClosedResidualLots || 0) > 0) {
              logger.warn(
                `Residual cleanup applied for ${d.symbol}: lots=${sellResult.autoClosedResidualLots}, ` +
                `usd~$${Number(sellResult.autoClosedResidualUsd || 0).toFixed(2)}`
              );
            }
          }

          await saveOrder({
            decisionId: d.mongoDecisionId,
            symbol: d.symbol,
            side: String(d.action).toLowerCase(),
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

          if (String(d.action).toLowerCase() === 'sell') {
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
              logger.warn(`Failed to mark lifecycle cooldown for ${d.symbol}: ${err.message}`);
            }

            try {
              const latestSummary = await getOpenPositionSummary(d.symbol, currentPrice, chatId);
              await updatePositionLifecycleState({
                symbol: d.symbol,
                chatId,
                positionSummary: latestSummary,
                currentPrice,
                minOrderUsd: Number(config?.trading?.minOrderUsd || 0)
              });
            } catch (err) {
              logger.warn(`Failed to sync lifecycle state after SELL for ${d.symbol}: ${err.message}`);
            }
          }
        } catch (err) {
          logger.warn(`Failed to save order: ${err.message}`);
        }
      }
    } catch (err) {
      execResults.push({ ...d, rendimiento: historicalRendimiento, status: 'error', error: err.message });
      errorCount++;
      logger.error(`${d.symbol}: ${err.message}`);
      if (isExchangeRejectionError(err.message)) {
        await notifyExchangeRejection(d, err.message, chatId).catch(() => { });
      }
      await notifyError(`Order failed for ${d.symbol}: ${err.message}`, chatId).catch(() => {});
    }
  }

  return { execResults, executedCount, skippedCount, errorCount };
}

function normalizeMaxTradeSizePct(rawValue) {
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n <= 0) return 25;
  if (n > 0 && n <= 1) return n * 100;
  return n;
}
