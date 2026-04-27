/**
 * agent/executor.js
 * Orchestrates one full agent cycle using modular workflow components
 */

import { computeIndicators, closesFromCandles, computeCrossTfConfluence } from './context/indicators.js';
import { notify, notifyError } from '../telegram/handles.js';
import { formatDecision, formatOpenOrdersMessage } from '../utils/formatter.js';
import { logger } from '../utils/logger.js';
import {
  connectDB,
  saveDecision,
  savePortfolioSnapshot,
  disconnectDB,
  getPreviousDecisions,
  getExecutedOrders,
  getDecisionById,
  getOpenPositionSummary,
  getRecentOpenBuyFromOtherSymbols
} from '../services/mongo/mongo-service.js';
import { clientAgentInstance } from './job/client-agent-main.js';
import { callAgentWithFallback, isFallbackChainEnabled } from './services/fallback-chain.js';
import { buildAnalyzerMessage } from './context/analyzer-market.js';
import { config } from '../config/config.js';
import { getCrossSymbolLookbackMinutes } from '../utils/cron-formatter.js';

// Import workflow modules
import { fetchMarketData } from './workflow/market-fetch.js';
import { checkForcedDecisions } from './workflow/decision-engine.js';
import { buildAnalyzerContext } from './workflow/context-builder.js';
import { executeDecisions } from './workflow/order-executor.js';
import { processOpenOrders } from './workflow/open-orders-manager.js';
import { buildFinalContext } from './context/formatters/context-summary.js';

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
    let recentSells = [];
    let lastOrder = null;
    let rendimiento = null;

    if (dbConnected) {
      try {
        const currentPrice = indicators[snapshot.symbol]?.currentPrice || 0;
        openPositionSummary = await getOpenPositionSummary(coin, currentPrice, chatId);

        if (openPositionSummary && openPositionSummary.openLots.length > 0) {
          const oldestLot = openPositionSummary.oldestOpenLot;
          const querySymbol = { $in: [snapshot.symbol, snapshot.symbol.replace('-', '/')] };
          recentSells = await getExecutedOrders(10, {
            symbol: querySymbol,
            side: 'sell',
            status: 'executed',
            chat_id: String(chatId),
            created_at: { $gte: oldestLot.created_at }
          });
        }

        // Keep last order fetch for legacy UI/fallback formatting
        const querySymbol = { $in: [snapshot.symbol, snapshot.symbol.replace('-', '/')] };
        const orders = await getExecutedOrders(1, { symbol: querySymbol, status: 'executed', chat_id: String(chatId) });
        if (orders.length > 0) {
          lastOrder = orders[0];
          if (lastOrder.decision_id) {
            const decisionContext = await getDecisionById(lastOrder.decision_id);
            if (decisionContext) {
              lastOrder.decisionContext = {
                reasoning: decisionContext.reasoning,
                risks: decisionContext.risks,
                action: decisionContext.action,
                stopLoss: decisionContext.stopLoss,
                takeProfit: decisionContext.takeProfit,
                confidence: decisionContext.confidence,
                created_at: decisionContext.created_at
              };
            }
          }
        }
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
    rendimiento = Number.isFinite(fifoRendimiento) ? fifoRendimiento : calculatedRendimiento;

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
              marketSummary: d.marketSummary?.substring(0, 210) || d.reasoning?.substring(0, 150),
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

    // Merge previous decisions and open position context
    analyzerContext.previousDecisions = previousDecisionsBySymbol;
    analyzerContext.openLots = openPositionSummary?.openLots || [];
    analyzerContext.recentSells = recentSells;
    analyzerContext.lastExecutedOrder = lastOrder;
    analyzerContext.rendimiento = rendimiento;
    analyzerContext.rendimientoAcumulado = analyzerContext.tradingStats?.accumulatedRendimiento ?? null;
    analyzerContext.crossSymbolRecentOpenBuy = crossSymbolRecentOpenBuy;
    analyzerContext.NextAnalysis = lookbackMinutes;
    // lastPrice = price at the time of the most recent previous decision for this coin
    const lastPrice = previousDecisionsBySymbol[snapshot.symbol]?.[0]?.price || lastOrder?.price || 0;
    const currentPrice = indicators[snapshot.symbol]?.currentPrice || 0;

    analyzerContext.currentPrice = currentPrice;
    analyzerContext.lastPrice = lastPrice;
    analyzerContext.priceChangeSinceLastAnalysisPct = (lastPrice > 0 && currentPrice > 0)
      ? parseFloat(((currentPrice - lastPrice) / lastPrice * 100).toFixed(2))
      : 0;

    if (higherTfIndicators) {
      analyzerContext.higherTimeframe = {
        interval: `${higherTfIndicators.interval}min`,
        confluence: higherTfIndicators.confluence,
        rsi14: higherTfIndicators.rsi14,
        bbPosition: higherTfIndicators.bbPosition,
        note: "Macro trend context — entry decisions should align with this"
      };
    }

    analyzerContext.crossTfConfluence = crossTfConfluence;

    // ── 4.2 Check for open orders (with FULL context) ────────────────
    // openOrders already fetched from fetchMarketData
    const normalizedCoin = coin.replace('/', '-');
    const baseCurrency = normalizedCoin.split('-')[0];

    // Ensure openOrders is an array
    const ordersArray = Array.isArray(openOrders) ? openOrders : [];
    if (!Array.isArray(openOrders)) {
      logger.warn(`⚠️ openOrders is not an array: ${typeof openOrders}. Treating as empty.`);
    }

    // Filter open orders: THIS coin vs OTHER coins
    const openOrdersThisCoin = ordersArray.filter(order => {
      const orderSymbol = (order.symbol || '').replace('/', '-').toUpperCase();
      const normalizedCoin = coin.replace('/', '-').toUpperCase();
      return orderSymbol === normalizedCoin;
    });

    const openOrdersOtherCoins = ordersArray.filter(order => {
      const orderSymbol = (order.symbol || '').replace('/', '-').toUpperCase();
      const normalizedCoinUpper = normalizedCoin.toUpperCase();
      return orderSymbol !== normalizedCoinUpper;
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

    // ── 4.4 Build final cleaned context for LLM ───────────────────
    const AiPayload = buildAnalyzerMessage(
      buildFinalContext(analyzerContext, {
        openLots: openPositionSummary?.openLots,
        recentSells,
        lastOrder,
        openOrdersThisCoin
      }),
      question,
      effectiveConfig.trading,
      coin
    );

    // ── 5. Get AI decision or use forced decision ──────────────
    let decision;
    if (forcedDecision) {
      decision = { decisions: [forcedDecision] };
      logger.info(`⚡ Bypassing AI. Forced decision: ${forcedDecision.reasoning}`);
    } else {
      try {
        const llmCfg = effectiveConfig.llm;
        // is active three call first call with free model if fail try with paid model
        if (isFallbackChainEnabled(effectiveConfig)) {
          logger.info('🔗 Usando fallback chain para LLM analysis');
          decision = await callAgentWithFallback(AiPayload, effectiveConfig, effectiveConfig.trading);
        } else {
          decision = await clientAgentInstance.callAgentAnalyzer(AiPayload, llmCfg.apiKey, llmCfg.model, effectiveConfig.trading, llmCfg);
        }

        logger.info(`✅ ${llmCfg.provider} decision received`);
        logger.debug('Decision:', JSON.stringify(decision, null, 2));
      } catch (err) {
        throw new Error(`LLM analysis failed: ${err.message}`);
      }
    }

    if (!decision || !Array.isArray(decision.decisions)) {
      throw new Error(`Invalid decision format: ${JSON.stringify(decision)}`);
    }

    // ── 6. Save decisions to MongoDB ───────────────────────────────
    if (dbConnected) {
      for (const d of decision.decisions) {
        if (!d.symbol) continue;

        // ── Auto-calculate TP/SL if not present (logic moved from LLM to Code) ──
        const symbolForPrice = d.symbol.replace('/', '-');
        const currentPrice = indicators[symbolForPrice]?.currentPrice;

        if (currentPrice && d.action !== 'HOLD') {
          const tpPct = effectiveConfig.trading.takeProfitPct || 0;
          const slPct = effectiveConfig.trading.stopLossPct || 0;

          if (d.action === 'BUY') {
            if (tpPct > 0) d.takeProfit = (currentPrice * (1 + tpPct / 100)).toFixed(2);
            if (slPct > 0) d.stopLoss = (currentPrice * (1 - slPct / 100)).toFixed(2);
          } else if (d.action === 'SELL') {
            // On Revolut X SELL is closing. We'll leave it null unless explicitly needed.
          }
        }

        try {
          const saved = await saveDecision({
            symbol: d.symbol,
            action: d.action,
            confidence: d.confidence,
            reasoning: d.reasoning || '',
            marketSummary: decision.marketSummary || '',
            risks: d.risks || '',
            positionPct: parseFloat(d.positionPct) || 0,
            currentPrice: currentPrice || null,
            usdAmount: parseFloat(d.usdAmount) || 0,
            orderType: d.orderType || 'market',
            takeProfit: d.takeProfit || null,
            stopLoss: d.stopLoss || null,
            rendimiento: rendimiento !== null ? rendimiento : null,
            model: decision.usedModel || null,
          }, triggerReason, chatId);

          d.mongoDecisionId = saved?._id;
        } catch (err) {
          logger.warn(`⚠️  Failed to save decision for ${d.symbol}: ${err.message}`);
        }
      }
    }
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
      rendimiento,
      dbConnected,
      chatId,
      analyzerContext.tradingStats?.openPositions || []
    );

    // ── 8. Notify via Telegram ─────────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    try {
      const message = formatDecision({ decision, execResults, elapsed, triggerReason });
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