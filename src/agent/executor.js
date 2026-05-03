/**
 * agent/executor.js
 * Orchestrates one full agent cycle using modular workflow components
 */

import { computeIndicators, closesFromCandles, computeCrossTfConfluence } from './context/indicators.js';
import { notify, notifyError } from '../telegram/handles.js';
import { formatOpenOrdersMessage } from '../utils/formatter.js';
import { logger } from '../utils/logger.js';
import {
  connectDB,
  savePortfolioSnapshot,
  disconnectDB,
  getPreviousDecisions,
  getOpenPositionSummary,
  getRecentOpenBuyFromOtherSymbols,
  getTradingPerformance
} from '../services/mongo/mongo-service.js';
import { config } from '../config/config.js';
import { getCrossSymbolLookbackMinutes } from '../utils/cron-formatter.js';

// Import workflow modules
import { fetchMarketData } from './workflow/market-fetch.js';
import { checkForcedDecisions } from './workflow/decision-engine.js';
import { buildAnalyzerContext } from './workflow/context-builder.js';
import { executeDecisions } from './workflow/order-executor.js';
import { processOpenOrders } from './workflow/open-orders-manager.js';
import { applyPortfolioManagerDecision, logPortfolioOverride } from './workflow/portfolio-manager.js';
import { AnalyzerContextEnricher } from './services/functions/analyzer-context-enricher.js';
import { DecisionPersistenceService } from '../services/mongo/decision-persistence-service.js';
import { analyzeTradingIntent } from './workflow/analyzer.js';
import { buildTradingReport } from './workflow/report/trading-report.js';

export async function runAgentCycle(triggerReason = 'cron', coin, question = '', userConfig = null) {
  const startTime = Date.now();
  const chatId = userConfig?.chatId || 'single_user';
  const effectiveConfig = userConfig || config;
  const lookbackMinutes = getCrossSymbolLookbackMinutes(effectiveConfig.cron.schedule);

  logger.info(`🤖 Agent cycle started (trigger: ${triggerReason}, coin: ${coin}, user: ${chatId})`);

  let dbConnected = false;

  try {
    // ── 0. Connect to MongoDB ──────────────────────────────────────
    try {
      await connectDB();
      dbConnected = true;
      logger.debug('✅ MongoDB connected');
    } catch (err) {
      logger.warn(`⚠️  MongoDB unavailable: ${err.message}. Continuing without persistence...`);
    }

    // ── 1. Fetch market data ───────────────────────────────────────
    const { client, market, balances, balanceArray, openOrders, snapshot, higherTfCandles, higherTfInterval, priceMap, realAvailableBalances } = await fetchMarketData(coin, effectiveConfig);

    // ── 2. Compute indicators (EARLY - needed for open order analysis) ──
    const indicators = {};
    const snapshots = [snapshot];

    for (const snap of snapshots) {
      try {
        const candlesArray = snap.candles?.candles || snap.candles || [];
        const closes = closesFromCandles(candlesArray);
        const computed = computeIndicators(closes, candlesArray);

        if (computed.error) {
          logger.warn(`⚠️ ${snap.symbol}: ${computed.error}`);
        } else {
          indicators[snap.symbol] = computed;
          logger.debug(`📈 ${snap.symbol}: RSI=${computed.rsi14}, MACD=${computed.macdLine}`);
        }
      } catch (err) {
        logger.error(`Indicators failed for ${snap.symbol}: ${err.message}`);
      }
    }

    if (Object.keys(indicators).length === 0) {
      throw new Error('No valid indicators computed — not enough historical data');
    }

    let higherTfIndicators = null;
    if (higherTfCandles?.candles?.length >= 26) {
      const htfCloses = closesFromCandles(higherTfCandles.candles);
      const htfComputed = computeIndicators(htfCloses, higherTfCandles.candles);
      if (!htfComputed.error) {
        higherTfIndicators = {
          interval: higherTfInterval,
          rsi14: htfComputed.rsi14,
          macdHistogram: htfComputed.macdHistogram,
          bbPosition: htfComputed.bbPosition,
          ema12: htfComputed.ema12,
          ema26: htfComputed.ema26,
          confluence: htfComputed.confluence,
        };
        logger.debug(`📈 Higher TF (${higherTfInterval}m) indicators computed for ${coin}`);
      }
    }

    // ── 2.1 Compute Cross-TF Confluence ──
    const crossTfConfluence = {};
    if (higherTfIndicators && indicators[snapshot.symbol]) {
      const confluence = computeCrossTfConfluence(
        indicators[snapshot.symbol],
        higherTfIndicators
      );
      crossTfConfluence[snapshot.symbol] = confluence;

      logger.info(
        `🔀 Cross-TF gate ${snapshot.symbol}: ${confluence.gate} | score=${confluence.score} | ${confluence.reason}`
      );
    }

    // ── 3. Fetch open lots and check SL/TP (EARLY) ──────────────────
    let openPositionSummary = null;
    let positionRendimiento = null;
    let historicalRendimiento = null;
    let lifecycleState = null;

    if (dbConnected) {
      try {
        const currentPrice = indicators[snapshot.symbol]?.currentPrice || 0;
        openPositionSummary = await getOpenPositionSummary(coin, currentPrice, chatId);
      } catch (err) {
        logger.warn(`⚠️ Failed to fetch position summary context: ${err.message}`);
      }
    }

    // Check for forced decisions (SL/TP)
    const { forcedDecision, rendimiento: calculatedRendimiento } = await checkForcedDecisions(
      indicators[snapshot.symbol],
      coin,
      balanceArray,
      realAvailableBalances,
      effectiveConfig,
      dbConnected,
      chatId
    );
    const fifoRendimiento = Number(openPositionSummary?.unrealizedRoiPct);
    positionRendimiento = Number.isFinite(fifoRendimiento) ? fifoRendimiento : calculatedRendimiento;

    // ── 4. Build context for Model AI (EARLY - needed for open order analysis) ──
    const previousDecisionsBySymbol = {};
    if (dbConnected) {
      for (const snap of snapshots) {
        try {
          const prev = await getPreviousDecisions(snap.symbol, chatId, 3);
          if (prev.length > 0) {
            previousDecisionsBySymbol[snap.symbol] = prev.map(d => ({
              timestamp: d.created_at.toISOString(),
              action: d.action,
              confidence: d.confidence,
              price: d.currentPrice || null,
              summaryReasoning: d.summaryReasoning || null,
              reasoning: d.reasoning || '',
              marketSummary: d.marketSummary?.substring(0, 210) || null,
              rendimiento: d.rendimiento !== undefined ? d.rendimiento : null,
            }));
          }
        } catch { /* non-critical */ }
      }
    }

    const analyzerContext = await buildAnalyzerContext(
      balances,
      openOrders,
      indicators,
      coin,
      snapshots,
      dbConnected,
      chatId,
      priceMap,
      realAvailableBalances
    );

    const contextHistoricalRend = Number(analyzerContext?.tradingStats?.accumulatedRendimiento);
    if (Number.isFinite(contextHistoricalRend)) {
      historicalRendimiento = contextHistoricalRend;
    } else if (dbConnected) {
      try {
        const perf = await getTradingPerformance(chatId, balances);
        const hist = Number(perf?.accumulatedRendimiento);
        historicalRendimiento = Number.isFinite(hist) ? hist : 0;
      } catch {
        historicalRendimiento = 0;
      }
    } else {
      historicalRendimiento = 0;
    }

    // Fetch cross symbol open buy context
    let crossSymbolRecentOpenBuy = null;
    if (dbConnected) {
      try {
        const otherOpenBuy = await getRecentOpenBuyFromOtherSymbols(coin, lookbackMinutes, chatId);
        if (otherOpenBuy) {
          const ageMinutes = Math.max(
            0,
            Math.round((Date.now() - new Date(otherOpenBuy.openedAt).getTime()) / 60000)
          );

          let roiPct = null;
          const symbolIndicators = indicators[otherOpenBuy.symbol];
          const currentOtherPrice = symbolIndicators?.currentPrice || 0;

          if (currentOtherPrice > 0 && otherOpenBuy.entryPrice > 0) {
            roiPct = Number((((currentOtherPrice - otherOpenBuy.entryPrice) / otherOpenBuy.entryPrice) * 100).toFixed(2));
          }

          crossSymbolRecentOpenBuy = {
            symbol: otherOpenBuy.symbol,
            ageMinutes,
            costUsd: Number((otherOpenBuy.costUsd || 0).toFixed(2)),
            roiPct,
          };
        }
      } catch (err) {
        logger.warn(`⚠️ Failed to build cross-symbol recent open buy context: ${err.message}`);
      }
    }
    const { lifecycleState: enrichedLifecycleState } = await AnalyzerContextEnricher.enrich({
      analyzerContext,
      previousDecisionsBySymbol,
      openPositionSummary,
      rendimiento: positionRendimiento,
      crossSymbolRecentOpenBuy,
      lookbackMinutes,
      snapshotSymbol: snapshot.symbol,
      indicators,
      higherTfIndicators,
      crossTfConfluence,
      dbConnected,
      chatId,
      minOrderUsd: effectiveConfig?.trading?.minOrderUsd || 0
    });
    lifecycleState = enrichedLifecycleState;

    // ── 4.2 Check for open orders (with FULL context) ────────────────
    // openOrders already fetched from fetchMarketData
    const normalizedCoin = coin.replace('/', '-');
    const baseCurrency = normalizedCoin.split('-')[0];

    // Ensure openOrders is an array
    const ordersArray = Array.isArray(openOrders) ? openOrders : [];
    if (!Array.isArray(openOrders)) {
      logger.warn(`⚠️ openOrders is not an array: ${typeof openOrders}. Treating as empty.`);
    }

    // Filter open orders for this coin
    const openOrdersThisCoin = ordersArray.filter(order => {
      const orderSymbol = (order.symbol || '').replace('/', '-').toUpperCase();
      const normalizedCoin = coin.replace('/', '-').toUpperCase();
      return orderSymbol === normalizedCoin;
    });

    // Case 1: Orders for THIS coin (ANY balance) → Procesa with FULL context y CONTINUA
    if (openOrdersThisCoin.length > 0) {
      const processResult = await processOpenOrders(
        coin,
        openOrdersThisCoin,
        analyzerContext,
        client,
        market,
        dbConnected,
        triggerReason,
        chatId,
        effectiveConfig
      );

      if (processResult.kept > 0) {

        try {
          const openOrdersMessage = formatOpenOrdersMessage({ symbol: coin, results: processResult });
          await notify(openOrdersMessage, chatId);

        } catch (err) {
          logger.warn(`⚠️ Failed to send open orders notification: ${err.message}`);
        }

        return {
          decision: null,
          execResults: [],
          stats: {
            executedCount: 0,
            skippedCount: 1,
            errorCount: 0,
            reason: 'open_orders_changed_state'
          }
        };
      }
      if (processResult.status === 'error') {
        await notify(`❌ *${coin}*: Open orders failed: ${processResult.error}`, chatId).catch(() => { });
        logger.warn(`⚠️ Open orders processing failed for ${coin}. Continuing with main flow.`);
      } else {
        try {
          const openOrdersMessage = formatOpenOrdersMessage({ symbol: coin, results: processResult });
          await notify(openOrdersMessage, chatId);
        } catch (err) {
          logger.warn(`⚠️ Failed to send open orders notification: ${err.message}`);
        }
      }
    }

    // If NO open orders → continue normally (skip this section)

    // ── 4.3 Guard: no funds and no position for this coin ───────────
    const minOrderUsd = effectiveConfig.trading.minOrderUsd;
    let availableMoney = parseFloat(realAvailableBalances?.availableByCurrency?.USD || 0);
    availableMoney += parseFloat(balanceArray.find(b => b.currency === 'EUR')?.total || 0);
    const hasFundsToBuy = availableMoney >= minOrderUsd;

    // Option B: Only consider managed balance, not manual balance
    const managedAmount = analyzerContext.balances.crypto[baseCurrency]?.amount || 0;
    const hasCoinBalance = managedAmount > 0;

    if (!hasFundsToBuy && !hasCoinBalance) {
      const msg = `💤 *${coin}*: Sin fondos suficientes ($${availableMoney.toFixed(2)} < $${minOrderUsd}) y sin balance de ${baseCurrency}. Ciclo pausado.`;
      await notify(msg, chatId).catch(() => { });
      return {
        decision: null,
        execResults: [],
        stats: { executedCount: 0, skippedCount: 1, errorCount: 0, reason: 'no_funds_no_position' }
      };
    }

    // ── 4.4 Analyze trading intent (LLM layer) ───────────────────
    let decision;
    try {
      decision = await analyzeTradingIntent({
        forcedDecision,
        analyzerContext,
        openPositionSummary,
        openOrdersThisCoin,
        question,
        effectiveConfig,
        coin
      });
      logger.info(`Decision received for ${coin}`);
      logger.debug('Decision:', JSON.stringify(decision, null, 2));
    } catch (err) {
      throw new Error(`LLM analysis failed: ${err.message}`);
    }

    if (!forcedDecision && decision && Array.isArray(decision.decisions)) {
      decision.decisions = decision.decisions.map((d) => {
        const original = { ...d };
        const nextDecision = applyPortfolioManagerDecision({
          decision: d,
          symbol: snapshot.symbol,
          analyzerContext,
          positionSummary: openPositionSummary,
          lifecycleState,
          config: effectiveConfig
        });
        logPortfolioOverride(snapshot.symbol, original, nextDecision);
        return nextDecision;
      });
    }

    if (!decision || !Array.isArray(decision.decisions)) {
      throw new Error(`Invalid decision format: ${JSON.stringify(decision)}`);
    }

    // ── 6. Save decisions to MongoDB ───────────────────────────────
    await DecisionPersistenceService.saveCycleDecisions({
      dbConnected,
      decisions: decision.decisions,
      indicators,
      effectiveConfig,
      rendimiento: historicalRendimiento,
      usedModel: decision.usedModel || null,
      marketSummary: decision.marketSummary || '',
      triggerReason,
      chatId
    });
    logger.info('Decision:', JSON.stringify(decision, null, 2));

    // ── 7. Execute decisions ───────────────────────────────────────
    const { execResults, executedCount, skippedCount, errorCount } = await executeDecisions(
      decision.decisions,
      coin,
      balanceArray,
      openOrders,
      realAvailableBalances,
      indicators,
      effectiveConfig,
      positionRendimiento,
      dbConnected,
      chatId,
      analyzerContext.tradingStats?.openPositions || []
    );

    // ── 8. Notify via Telegram ─────────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    try {
      const message = buildTradingReport({ decision, execResults, elapsed, triggerReason });
      await notify(message, chatId);
    } catch (err) {
      logger.error('Failed to send Telegram notification:', err.message);
    }

    // ── 9. Save portfolio snapshot ─────────────────────────────────
    if (dbConnected && balances) {
      try {
        await savePortfolioSnapshot(balances, chatId);
      } catch (err) {
        logger.warn(`⚠️  Failed to save portfolio snapshot: ${err.message}`);
      }
    }

    logger.info(`✅ Cycle complete: ${executedCount} executed, ${skippedCount} skipped, ${errorCount} errors (${elapsed}s)`);
    return { decision, execResults, stats: { executedCount, skippedCount, errorCount } };

  } catch (err) {
    const msg = `❌ Agent cycle failed: ${err.message || err}`;
    logger.error(msg);
    await notifyError(msg, chatId).catch(() => { });
    throw err;
  } finally {
    if (dbConnected) {
      try { await disconnectDB(); } catch { /* ignore */ }
    }
  }
}


