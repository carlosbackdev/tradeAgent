/**
 * agent/executor.js
 * Orchestrates one full agent cycle using modular workflow components
 */

import { computeIndicators, closesFromCandles } from './context/indicators.js';
import { notify, notifyError } from '../telegram/handles.js';
import { formatDecision } from '../utils/formatter.js';
import { logger } from '../utils/logger.js';
import {
  connectDB,
  saveDecision,
  savePortfolioSnapshot,
  disconnectDB,
  getPreviousDecisions,
  getExecutedOrders,
  getDecisionById
} from '../utils/mongodb.js';
import { callAgentAnalyzer } from './services/clientAgent.js';
import { config } from '../config/config.js';

// Import workflow modules
import { fetchMarketData } from './workflow/market-fetch.js';
import { checkForcedDecisions } from './workflow/decision-engine.js';
import { buildAnalyzerContext } from './workflow/context-builder.js';
import { executeDecisions } from './workflow/order-executor.js';
import { processOpenOrders } from './workflow/open-orders-manager.js';

export async function runAgentCycle(triggerReason = 'cron', coin, question = '', userConfig = null) {
  const startTime = Date.now();
  const chatId = userConfig?.chatId || 'single_user';
  const effectiveConfig = userConfig || config;

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
    const { client, market, balances, balanceArray, openOrders, snapshot, priceMap } = await fetchMarketData(coin, effectiveConfig);

    // ── 2. Compute indicators (EARLY - needed for open order analysis) ──
    const indicators = {};
    const snapshots = [snapshot];

    for (const snap of snapshots) {
      try {
        const candlesArray = snap.candles?.candles || snap.candles || [];
        const closes = closesFromCandles(candlesArray);
        const computed = computeIndicators(closes);

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

    // ── 3. Check SL/TP and fetch last order (EARLY) ──────────────────
    let lastOrder = null;
    let rendimiento = null;

    if (dbConnected) {
      try {
        const querySymbol = { $in: [snapshot.symbol, snapshot.symbol.replace('-', '/')] };
        const orders = await getExecutedOrders(1, { symbol: querySymbol, status: 'executed', chat_id: chatId });
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
        logger.warn(`⚠️ Failed to fetch last order context: ${err.message}`);
      }
    }

    // Check for forced decisions (SL/TP)
    const { forcedDecision, rendimiento: calculatedRendimiento } = await checkForcedDecisions(
      lastOrder,
      indicators[snapshot.symbol],
      coin,
      balanceArray,
      effectiveConfig,
      dbConnected
    );
    rendimiento = calculatedRendimiento;

    // ── 4. Build context for Claude (EARLY - needed for open order analysis) ──
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
              reasoning: d.reasoning?.substring(0, 80),
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
      priceMap
    );

    // Merge previous decisions and rendimiento
    analyzerContext.previousDecisions = previousDecisionsBySymbol;
    analyzerContext.lastExecutedOrder = lastOrder;
    analyzerContext.rendimiento = rendimiento;
    analyzerContext.rendimientoAcumulado = analyzerContext.tradingStats?.accumulatedRendimiento ?? null;
    // lastPrice = price at the time of the most recent previous decision for this coin
    const lastPrice = previousDecisionsBySymbol[snapshot.symbol]?.[0]?.price || lastOrder?.price || 0;
    const currentPrice = indicators[snapshot.symbol]?.currentPrice || 0;
    
    analyzerContext.currentPrice = currentPrice;
    analyzerContext.lastPrice = lastPrice;
    analyzerContext.priceChangeSinceLastAnalysisPct = (lastPrice > 0 && currentPrice > 0)
      ? parseFloat(((currentPrice - lastPrice) / lastPrice * 100).toFixed(2))
      : 0;

    // ── 4.2 Check for open orders (with FULL context) ────────────────
    // openOrders already fetched from fetchMarketData
    const normalizedCoin = coin.replace('/', '-');
    const baseCurrency = normalizedCoin.split('-')[0];
    const coinBalance = parseFloat(balanceArray.find(b => b.currency === baseCurrency)?.total || 0);

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

    logger.info(`🔍 Open orders: ${openOrdersThisCoin.length} for ${coin}, ${openOrdersOtherCoins.length} for other coins`);

    // Case 1: Orders for THIS coin (ANY balance) → Procesa with FULL context y RETORNA
    if (openOrdersThisCoin.length > 0) {
      logger.info(`📋 Processing ${openOrdersThisCoin.length} open order(s) for ${coin} with full context...`);
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

      if (processResult.status === 'error') {
        await notify(`❌ *${coin}*: Open orders failed: ${processResult.error}`, chatId).catch(() => { });
        return {
          decision: null,
          execResults: [],
          stats: { executedCount: 0, skippedCount: 1, errorCount: 1, reason: 'open_orders_error' }
        };
      }

      logger.info(`✅ Processed: ${processResult.cancelled} cancelled, ${processResult.buy_more_count || 0} buy_more, ${processResult.kept} kept`);
      await notify(`✅ *${coin}*: Processed open orders (${processResult.cancelled} cancelled, ${processResult.buy_more_count || 0} buy_more, ${processResult.kept} kept).`, chatId).catch(() => { });
      return {
        decision: null,
        execResults: [],
        stats: { executedCount: 0, skippedCount: 1, errorCount: 0, reason: 'open_orders_processed' }
      };
    }

    // If NO open orders → continue normally (skip this section)

    // ── 4.3 Guard: no funds and no position for this coin ───────────
    const minOrderUsd = effectiveConfig.trading.minOrderUsd;
    let availableMoney = parseFloat(balanceArray.find(b => b.currency === 'USD')?.total || 0);
    availableMoney += parseFloat(balanceArray.find(b => b.currency === 'EUR')?.total || 0);
    const hasFundsToBuy = availableMoney >= minOrderUsd;
    
    // Option B: Only consider managed balance, not manual balance
    const managedAmount = analyzerContext.balances.crypto[baseCurrency]?.amount || 0;
    const hasCoinBalance = managedAmount > 0;

    if (!hasFundsToBuy && !hasCoinBalance) {
      const msg = `💤 *${coin}*: Sin fondos suficientes ($${availableMoney.toFixed(2)} < $${minOrderUsd}) y sin balance de ${baseCurrency}. Ciclo pausado.`;
      logger.info(`⏭️  Skipping Claude for ${coin}: no funds and no ${baseCurrency} balance`);
      await notify(msg, chatId).catch(() => { });
      return {
        decision: null,
        execResults: [],
        stats: { executedCount: 0, skippedCount: 1, errorCount: 0, reason: 'no_funds_no_position' }
      };
    }

    logger.info('Analyzer context:', JSON.stringify(analyzerContext, null, 2));
    logger.info('Forced decision:', JSON.stringify(forcedDecision, null, 2));

    // ── 5. Get Claude decision or use forced decision ──────────────
    let decision;
    if (forcedDecision) {
      decision = { decisions: [forcedDecision] };
      logger.info(`⚡ Bypassing Claude. Forced decision: ${forcedDecision.reasoning}`);
    } else {
      try {
        const anthConfig = effectiveConfig.anthropic;
        decision = await callAgentAnalyzer(analyzerContext, question, anthConfig.apiKey, anthConfig.model, effectiveConfig.trading);
        logger.info('✅ Claude decision received');
        logger.debug('Decision:', JSON.stringify(decision, null, 2));
      } catch (err) {
        throw new Error(`Claude analysis failed: ${err.message}`);
      }
    }

    if (!decision || !Array.isArray(decision.decisions)) {
      throw new Error(`Invalid decision format: ${JSON.stringify(decision)}`);
    }

    // ── 6. Save decisions to MongoDB ───────────────────────────────
    if (dbConnected) {
      for (const d of decision.decisions) {
        if (!d.symbol) continue;
        try {
          const saved = await saveDecision({
            symbol: d.symbol,
            action: d.action,
            confidence: d.confidence,
            reasoning: d.reasoning || '',
            risks: d.risks || '',
            positionPct: parseFloat(d.positionPct) || 0,
            currentPrice: indicators[d.symbol.replace('/', '-')]?.currentPrice || null,
            usdAmount: parseFloat(d.usdAmount) || 0,
            orderType: d.orderType || 'market',
            takeProfit: d.takeProfit || null,
            stopLoss: d.stopLoss || null,
            rendimiento: rendimiento !== null ? rendimiento : null,
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
      indicators,
      lastOrder,
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
      logger.info('📤 Telegram notification sent');
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