/**
 * agent/executor.js
 * Orchestrates one full agent cycle.
 *
 * Fix vs previous:
 *   - placeOrder now receives usdAmount directly (not qty calculated from price)
 *     because orders.js uses quote_size internally
 */

import { RevolutClient } from '../revolut/client.js';
import { MarketData } from '../revolut/market.js';
import { OrderManager } from '../revolut/orders.js';
import { computeIndicators, closesFromCandles } from './context/indicators.js';
import { notify, notifyError, notifyOrderExecuted } from '../telegram/handles.js';
import { formatDecision } from '../utils/formatter.js';
import { logger } from '../utils/logger.js';
import {
  connectDB,
  saveDecision,
  saveOrder,
  savePortfolioSnapshot,
  disconnectDB,
  getPreviousDecisions
} from '../utils/mongodb.js';
import { callAgentAnalyzer } from './services/clientAgent.js';

export async function runAgentCycle(triggerReason = 'cron', coin) {
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

    // ── 1. Init clients ────────────────────────────────────────────
    const client = new RevolutClient();
    const market = new MarketData(client);
    const orders = new OrderManager(client);

    // ── 2. Fetch market data ───────────────────────────────────────
    if (!coin) throw new Error('No trading pair passed to runAgentCycle');

    logger.info(`📊 Fetching data for: ${coin}`);

    const [balances, openOrders, snapshot] = await Promise.all([
      market.getBalances(),
      market.getOpenOrders([coin]),
      market.getSnapshot(coin),
    ]).catch(err => {
      throw new Error(`Failed to fetch market data: ${err.message}`);
    });
    logger.info('📊 Open orders:', JSON.stringify(openOrders, null, 2));
    logger.info('📊 Balances:', JSON.stringify(balances, null, 2));

    const snapshots = [snapshot];

    // ── 3. Compute indicators ──────────────────────────────────────
    const indicators = {};

    for (const snapshot of snapshots) {
      try {
        const candlesArray = snapshot.candles?.candles || snapshot.candles || [];
        const closes = closesFromCandles(candlesArray);
        const computed = computeIndicators(closes);

        if (computed.error) {
          logger.warn(`⚠️ ${snapshot.symbol}: ${computed.error}`);
        } else {
          indicators[snapshot.symbol] = computed;
          logger.debug(`📈 ${snapshot.symbol}: RSI=${computed.rsi14}, MACD=${computed.macdLine}`);
        }
      } catch (err) {
        logger.error(`Indicators failed for ${snapshot.symbol}: ${err.message}`);
      }
    }

    if (Object.keys(indicators).length === 0) {
      throw new Error('No valid indicators computed — not enough historical data');
    }

    // ── 4. Build optimized context for Claude ─────────────────────
    const previousDecisionsBySymbol = {};
    if (dbConnected) {
      for (const snapshot of snapshots) {
        try {
          const prev = await getPreviousDecisions(snapshot.symbol, 3);
          if (prev.length > 0) {
            previousDecisionsBySymbol[snapshot.symbol] = prev.map(d => ({
              timestamp: d.created_at.toISOString(),
              action: d.action,
              confidence: d.confidence,
              reasoning: d.reasoning?.substring(0, 80),
            }));
          }
        } catch { /* non-critical */ }
      }
    }

    // ── Lean context — no raw snapshots, only processed data ──────
    const compactPairs = snapshots.map(snapshot => ({
      symbol: snapshot.symbol,
      ticker: snapshot.ticker,
      orderBookTop: {
        bestBid: snapshot.orderBook?.bids?.[0] || null,
        bestAsk: snapshot.orderBook?.asks?.[0] || null,
        bidDepth: snapshot.orderBook?.bids?.length || 0,
        askDepth: snapshot.orderBook?.asks?.length || 0,
      },
      recentCloses: (snapshot.candles?.candles || []).slice(-10).map(c => c.close),
      fetchedAt: snapshot.fetchedAt,
    }));

    const relevantBalances = extractRelevantBalances(balances);

    // Extract open orders array (handle both formats)
    const openOrdersArray = Array.isArray(openOrders?.data)
      ? openOrders.data
      : (Array.isArray(openOrders) ? openOrders : []);

    const analyzerContext = {
      balances: relevantBalances,
      openOrders: openOrdersArray,
      pairs: compactPairs,
      indicators,
      previousDecisions: previousDecisionsBySymbol,
    };

    logger.debug('Analyzer context:', JSON.stringify(analyzerContext, null, 2));

    let decision;
    try {
      decision = await callAgentAnalyzer(analyzerContext);

      logger.info('✅ Claude decision received');

      logger.debug('Decision:', JSON.stringify(decision, null, 2));
    } catch (err) {
      throw new Error(`Claude analysis failed: ${err.message}`);
    }

    if (!decision || !Array.isArray(decision.decisions)) {
      throw new Error(`Invalid decision format: ${JSON.stringify(decision)}`);
    }

    // ── 4.5 Save decisions to MongoDB ─────────────────────────────
    if (dbConnected) {
      for (const d of decision.decisions) {
        if (!d.symbol) continue;
        try {
          await saveDecision({
            symbol: d.symbol,
            action: d.action,
            confidence: d.confidence,
            reasoning: d.reasoning || '',
            risks: d.risks || '',
            usdAmount: parseFloat(d.usdAmount) || 0,
            orderType: d.orderType || 'market',
            takeProfit: d.takeProfit || null,
            stopLoss: d.stopLoss || null,
          }, triggerReason);
        } catch (err) {
          logger.warn(`⚠️  Failed to save decision for ${d.symbol}: ${err.message}`);
        }
      }
    }

    // ── 5. Execute decisions ───────────────────────────────────────
    const execResults = [];
    let executedCount = 0, skippedCount = 0, errorCount = 0;

    for (const d of decision.decisions) {
      if (!d.symbol) continue;

      // ── Guards ────────────────────────────────────────────────
      if (d.action === 'HOLD') {
        execResults.push({ ...d, status: 'skipped', reason: 'HOLD decision' });
        skippedCount++;
        continue;
      }

      if (d.confidence < 55) {
        execResults.push({ ...d, status: 'skipped', reason: `Low confidence (${d.confidence}%)` });
        skippedCount++;
        continue;
      }

      const usd = parseFloat(d.usdAmount);
      const minOrder = parseFloat(process.env.MIN_ORDER || '10');
      if (isNaN(usd) || usd < minOrder) {
        execResults.push({ ...d, status: 'skipped', reason: `Amount $${usd} < minimum $${minOrder}` });
        skippedCount++;
        continue;
      }

      // ── Execute ───────────────────────────────────────────────
      try {
        const currentPrice = indicators[d.symbol]?.currentPrice;
        if (!currentPrice) throw new Error('No current price in indicators');

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

        // ✅ Pass usdAmount directly — orders.js uses quote_size internally
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

        execResults.push({ ...d, status: 'executed', usdAmount: usd, orderResult, rrMetrics });
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
            await saveOrder({
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
            });
          } catch (err) {
            logger.warn(`⚠️  Failed to save order: ${err.message}`);
          }
        }
      } catch (err) {
        execResults.push({ ...d, status: 'error', error: err.message });
        errorCount++;
        logger.error(`❌ ${d.symbol}: ${err.message}`);
        await notifyError(`Order failed for ${d.symbol}: ${err.message}`).catch(() => { });
      }
    }

    // ── 6. Notify via Telegram ─────────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    try {
      const message = formatDecision({ decision, execResults, elapsed, triggerReason });
      await notify(message);
      logger.info('📤 Telegram notification sent');
    } catch (err) {
      logger.error('Failed to send Telegram notification:', err.message);
    }

    // ── 7. Save portfolio snapshot ─────────────────────────────────
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

/**
 * Extract only the balances relevant to the current trading pairs.
 * Avoids sending the entire balances object (could be large) to Claude.
 */
function extractRelevantBalances(balances) {
  if (!balances) return {};
  const balancesMap = {};

  // Handle both array and {data: []} formats
  const balanceArray = Array.isArray(balances) ? balances : (balances?.data || []);

  for (const b of balanceArray) {
    const total = Number(b.total || 0);

    // ignorar balances vacíos
    if (total === 0) continue;

    balancesMap[b.currency] = total;
  }

  return balancesMap;
}