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
import { getTradingStats } from '../utils/mongodb.js';
import {
  connectDB,
  saveDecision,
  saveOrder,
  savePortfolioSnapshot,
  disconnectDB,
  getPreviousDecisions,
  getExecutedOrders
} from '../utils/mongodb.js';
import { callAgentAnalyzer } from './services/clientAgent.js';
import { config } from '../config/config.js';

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

    const balanceArray = Array.isArray(balances) ? balances : (balances?.data || []);
    const eurBalance = parseFloat(balanceArray.find(b => b.currency === 'EUR')?.total || 0);
    const usdBalance = parseFloat(balanceArray.find(b => b.currency === 'USD')?.total || 0);
    const totalFiat = eurBalance + usdBalance;

    if (totalFiat < config.trading.minOrderUsd) {
      await notify(`⚠️ Fondos insuficientes de EUR/USD ($${totalFiat.toFixed(2)}) para MIN_ORDER ($${config.trading.minOrderUsd}). Operaciones de BUY serán ignoradas, pero la gestión de ventas prosigue.`).catch(() => { });
    }

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

    // ── 3.5 Check SL/TP and Last Order ─────────────────────────────
    let lastOrder = null;
    let forcedDecision = null;
    let rendimiento = null;

    if (dbConnected) {
      try {
        const querySymbol = { $in: [snapshot.symbol, snapshot.symbol.replace('-', '/')] };
        const orders = await getExecutedOrders(1, { symbol: querySymbol, status: 'executed' });
        if (orders.length > 0) {
          lastOrder = orders[0];
        }
      } catch (err) {
        logger.warn(`⚠️ Failed to fetch last order: ${err.message}`);
      }
    }

    if (lastOrder && lastOrder.side === 'buy') {
      const baseCurrency = coin.split('-')[0];
      const baseBalance = parseFloat(balanceArray.find(b => b.currency === baseCurrency)?.total || 0);

      // Only consider the lastOrder valid if we actually hold the asset.
      // If baseBalance === 0 the position is already closed — ignore it.
      if (baseBalance > 0) {
        const currentPrice = indicators[snapshot.symbol]?.currentPrice || snapshot.ticker.last;
        if (currentPrice && lastOrder.price) {
          const pnlPct = ((currentPrice - lastOrder.price) / lastOrder.price) * 100;
          rendimiento = parseFloat(pnlPct.toFixed(2));

          const tpPct = config.trading.takeProfitPct || 0;
          const slPct = config.trading.stopLossPct || 0;
          const usdWorth = baseBalance * currentPrice * 0.999;

          if (tpPct > 0 && pnlPct >= tpPct) {
            forcedDecision = {
              symbol: snapshot.symbol,
              action: 'SELL',
              confidence: 100,
              reasoning: `Forced Take Profit met at +${pnlPct.toFixed(2)}% (Entry: $${lastOrder.price}, Current: $${currentPrice})`,
              orderType: 'market',
              usdAmount: parseFloat(usdWorth.toFixed(2))
            };
          } else if (slPct > 0 && pnlPct <= -slPct) {
            forcedDecision = {
              symbol: snapshot.symbol,
              action: 'SELL',
              confidence: 100,
              reasoning: `Forced Stop Loss met at ${pnlPct.toFixed(2)}% (Entry: $${lastOrder.price}, Current: $${currentPrice})`,
              orderType: 'market',
              usdAmount: parseFloat(usdWorth.toFixed(2))
            };
          }
        }
      } else {
        // No balance — treat lastOrder as stale, don't mislead Claude
        logger.info(`ℹ️  No ${coin.split('-')[0]} balance — lastOrder from ${lastOrder.created_at?.toISOString?.() || '?'} treated as closed`);
        lastOrder = null;
      }
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
              currentPnlPct: d.currentPnlPct !== undefined ? d.currentPnlPct : null,
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

    const relevantBalances = extractRelevantBalances(balances, indicators);

    // Extract open orders array (handle both formats)
    const openOrdersArray = Array.isArray(openOrders?.data)
      ? openOrders.data
      : (Array.isArray(openOrders) ? openOrders : []);

    const tradingStats = await getTradingStats();

    const analyzerContext = {
      balances: relevantBalances,
      openOrders: openOrdersArray,
      pairs: compactPairs,
      indicators,
      previousDecisions: previousDecisionsBySymbol,
      lastExecutedOrder: lastOrder,
      rendimiento: rendimiento,
      tradingStats: tradingStats
    };

    logger.info('Analyzer context:', JSON.stringify(analyzerContext, null, 2));
    logger.info('Forced decision:', JSON.stringify(forcedDecision, null, 2));


    let decision;
    if (forcedDecision) {
      decision = { decisions: [forcedDecision] };
      logger.info(`⚡ Bypassing Claude. Forced decision: ${forcedDecision.reasoning}`);
    } else {
      try {
        decision = await callAgentAnalyzer(analyzerContext);

        logger.info('✅ Claude decision received');

        logger.debug('Decision:', JSON.stringify(decision, null, 2));
      } catch (err) {
        throw new Error(`Claude analysis failed: ${err.message}`);
      }
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
            rendimiento: rendimiento !== null ? rendimiento : null,
          }, triggerReason);
        } catch (err) {
          logger.warn(`⚠️  Failed to save decision for ${d.symbol}: ${err.message}`);
        }
      }
    }
    logger.info('Decision:', JSON.stringify(decision, null, 2));

    // ── 5. Execute decisions ───────────────────────────────────────
    const execResults = [];
    let executedCount = 0, skippedCount = 0, errorCount = 0;

    for (const d of decision.decisions) {
      if (!d.symbol) continue;

      const pnlPctInfo = rendimiento !== null ? rendimiento : undefined;

      // ── Guards ────────────────────────────────────────────────
      if (d.action === 'HOLD') {
        execResults.push({ ...d, rendimiento: pnlPctInfo, status: 'skipped', reason: 'HOLD decision' });
        skippedCount++;
        continue;
      }

      if (d.confidence < 55) {
        execResults.push({ ...d, rendimiento: pnlPctInfo, status: 'skipped', reason: `Low confidence (${d.confidence}%)` });
        skippedCount++;
        continue;
      }

      let usd = parseFloat(d.usdAmount);

      // Auto-fill SELL orders with 100% balance if LLM forgets to specify it or sets 0
      if (d.action === 'SELL' && (isNaN(usd) || usd === 0)) {
        const baseCurrency = d.symbol.split('-')[0];
        const baseBalance = parseFloat(balanceArray.find(b => b.currency === baseCurrency)?.total || 0);
        const currentPrice = indicators[d.symbol]?.currentPrice || 0;
        // Apply 99.5% buffer to avoid Revolut rounding/fee precision errors
        usd = baseBalance * currentPrice * 0.999;
        d.usdAmount = parseFloat(usd.toFixed(2));
        logger.info(`💱 SELL auto-fill: ${baseBalance} ${baseCurrency} @ $${currentPrice} = $${d.usdAmount} (with 0.5% buffer)`);
      }

      // For any SELL, cap the amount to 99.5% of what we actually hold
      // to avoid Revolut rejecting the order for precision/fee reasons
      if (d.action === 'SELL') {
        const baseCurrency = d.symbol.split('-')[0];
        const baseBalance = parseFloat(balanceArray.find(b => b.currency === baseCurrency)?.total || 0);
        const currentPrice = indicators[d.symbol]?.currentPrice || 0;
        if (currentPrice > 0 && baseBalance > 0) {
          const maxSellUsd = parseFloat((baseBalance * currentPrice * 0.999).toFixed(2));
          if (usd > maxSellUsd) {
            logger.info(`🛡️ SELL amount capped: $${usd} → $${maxSellUsd} (99.5% of ${baseBalance} ${baseCurrency})`);
            usd = maxSellUsd;
            d.usdAmount = usd;
          }
        }
      }

      const minOrder = config.trading.minOrderUsd;
      if (isNaN(usd) || usd < minOrder) {
        execResults.push({ ...d, rendimiento: pnlPctInfo, status: 'skipped', reason: `Amount $${usd} < minimum $${minOrder}` });
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

        execResults.push({ ...d, rendimiento: pnlPctInfo, status: 'executed', usdAmount: usd, orderResult, rrMetrics });
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
        execResults.push({ ...d, rendimiento: pnlPctInfo, status: 'error', error: err.message });
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
function extractRelevantBalances(balances, indicators = {}) {
  if (!balances) return {};

  const structured = {
    crypto: {},
    fiat: {}
  };

  const fiatCurrencies = ['USD', 'EUR', 'GBP'];

  // Handle both array and {data: []} formats
  const balanceArray = Array.isArray(balances) ? balances : (balances?.data || []);

  for (const b of balanceArray) {
    const total = Number(b.total || 0);

    // ignorar balances vacíos
    if (total === 0) continue;

    if (fiatCurrencies.includes(b.currency)) {
      structured.fiat[b.currency] = total;
    } else {
      // Encontrar el precio actual si la moneda está en el ciclo actual
      const pairKey = Object.keys(indicators).find(k => k.startsWith(b.currency + '-'));
      const currentPrice = pairKey ? indicators[pairKey].currentPrice : 0;

      structured.crypto[b.currency] = {
        amount: total,
        estimatedUsdValue: currentPrice ? parseFloat((total * currentPrice).toFixed(2)) : null
      };
    }
  }

  return structured;
}