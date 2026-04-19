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

export async function runAgentCycle(triggerReason = 'cron', coin, question = '') {
  const startTime = Date.now();
  logger.info(`🤖 Agent cycle started (trigger: ${triggerReason}, coin: ${coin})`);

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
    const { client, market, balances, balanceArray, openOrders, snapshot } = await fetchMarketData(coin, config);

    // ── 2. Compute indicators ──────────────────────────────────────
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

    // ── 3. Check SL/TP and fetch last order ────────────────────────
    let lastOrder = null;
    let rendimiento = null;

    if (dbConnected) {
      try {
        const querySymbol = { $in: [snapshot.symbol, snapshot.symbol.replace('-', '/')] };
        const orders = await getExecutedOrders(1, { symbol: querySymbol, status: 'executed' });
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
      config,
      dbConnected
    );
    rendimiento = calculatedRendimiento;

    // ── 4. Build context for Claude ────────────────────────────────
    const previousDecisionsBySymbol = {};
    if (dbConnected) {
      for (const snap of snapshots) {
        try {
          const prev = await getPreviousDecisions(snap.symbol, 3);
          if (prev.length > 0) {
            previousDecisionsBySymbol[snap.symbol] = prev.map(d => ({
              timestamp: d.created_at.toISOString(),
              action: d.action,
              confidence: d.confidence,
              reasoning: d.reasoning?.substring(0, 80),
              currentPnlPct: d.currentPnlPct !== undefined ? d.currentPnlPct : null,
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
      dbConnected
    );

    // Merge previous decisions and rendimiento
    analyzerContext.previousDecisions = previousDecisionsBySymbol;
    analyzerContext.lastExecutedOrder = lastOrder;
    analyzerContext.rendimiento = rendimiento;

    logger.info('Analyzer context:', JSON.stringify(analyzerContext, null, 2));
    logger.info('Forced decision:', JSON.stringify(forcedDecision, null, 2));

    // ── 5. Get Claude decision or use forced decision ──────────────
    let decision;
    if (forcedDecision) {
      decision = { decisions: [forcedDecision] };
      logger.info(`⚡ Bypassing Claude. Forced decision: ${forcedDecision.reasoning}`);
    } else {
      try {
        decision = await callAgentAnalyzer(analyzerContext, question);
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
            usdAmount: parseFloat(d.usdAmount) || 0,
            orderType: d.orderType || 'market',
            takeProfit: d.takeProfit || null,
            stopLoss: d.stopLoss || null,
            rendimiento: rendimiento !== null ? rendimiento : null,
          }, triggerReason);

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
      config,
      rendimiento,
      dbConnected
    );

    // ── 8. Notify via Telegram ─────────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    try {
      const message = formatDecision({ decision, execResults, elapsed, triggerReason });
      await notify(message);
      logger.info('📤 Telegram notification sent');
    } catch (err) {
      logger.error('Failed to send Telegram notification:', err.message);
    }

    // ── 9. Save portfolio snapshot ─────────────────────────────────
    if (dbConnected && balances) {
      try {
        await savePortfolioSnapshot(balances);
      } catch (err) {
        logger.warn(`⚠️  Failed to save portfolio snapshot: ${err.message}`);
      }
    }

    logger.info(`✅ Cycle complete: ${executedCount} executed, ${skippedCount} skipped, ${errorCount} errors (${elapsed}s)`);
    return { decision, execResults, stats: { executedCount, skippedCount, errorCount } };

  } catch (err) {
    const msg = `❌ Agent cycle failed: ${err.message}`;
    logger.error(msg);
    await notifyError(msg).catch(() => { });
    throw err;
  } finally {
    if (dbConnected) {
      try { await disconnectDB(); } catch { /* ignore */ }
    }
  }
}