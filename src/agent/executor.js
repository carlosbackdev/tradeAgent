/**
 * agent/executor.js
 * Orchestrates one full agent cycle:
 *   1. Fetch market data + portfolio
 *   2. Compute indicators
 *   3. Ask Claude for decisions
 *   4. Execute orders (unless DRY_RUN)
 *   5. Notify via Telegram
 */

import { RevolutClient }    from '../revolut/client.js';
import { MarketData }       from '../revolut/market.js';
import { OrderManager }     from '../revolut/orders.js';
import { computeIndicators, closesFromTrades } from './indicators.js';
import { analyzeMarket }    from './analyzer.js';
import { notify, notifyError } from '../notifications/telegram.js';
import { formatDecision }   from '../utils/formatter.js';
import { logger } from '../utils/logger.js';
import { 
  connectDB, 
  saveDecision, 
  saveOrder, 
  savePortfolioSnapshot, 
  disconnectDB,
  getPreviousDecisions
} from '../utils/mongodb.js';

export async function runAgentCycle(triggerReason = 'cron') {
  const startTime = Date.now();
  const cycleId = `${triggerReason}-${Date.now()}`;
  
  logger.info(`🤖 Agent cycle started (trigger: ${triggerReason})`);

  let dbConnected = false;
  
  try {
    // ── 0. Connect to MongoDB ──────────────────────────────────────
    try {
      await connectDB();
      dbConnected = true;
      logger.debug('✅ MongoDB connected');
    } catch (err) {
      logger.warn(`⚠️  MongoDB connection failed: ${err.message}. Continuing without persistence...`);
    }
    // ── 1. Init clients ────────────────────────────────────────────
    logger.debug('Initializing clients...');
    
    let client, market, orders;
    try {
      client = new RevolutClient();
      market = new MarketData(client);
      orders = new OrderManager(client);
    } catch (err) {
      throw new Error(`Client initialization failed: ${err.message}`);
    }

    // ── 2. Fetch market data in parallel ──────────────────────────
    const pairs = process.env.TRADING_PAIRS.split(',').map(s => s.trim()).filter(p => p);
    
    if (pairs.length === 0) {
      throw new Error('No trading pairs configured');
    }

    logger.info(`📊 Fetching data for ${pairs.length} pair(s): ${pairs.join(', ')}`);

    let balances, openOrders, snapshots;
    try {
      const results = await Promise.all([
        market.getBalances(),
        market.getOpenOrders(),
        ...pairs.map(symbol => market.getSnapshot(symbol)),
      ]);

      balances = results[0];
      openOrders = results[1];
      snapshots = results.slice(2);
      
      logger.info(`✅ Market data fetched`);
    } catch (err) {
      throw new Error(`Failed to fetch market data: ${err.message}`);
    }

    // ── 3. Compute technical indicators for each pair ─────────────
    logger.debug('Computing technical indicators...');
    
    const indicators = {};
    const indicatorErrors = [];
    
    for (const snapshot of snapshots) {
      try {
        // snapshot.trades is returned by getRecentTrades() as { symbol, trades: [...] }
        const tradesArray = snapshot.trades?.trades || snapshot.trades || [];
        const closes = closesFromTrades(tradesArray);
        const computed = computeIndicators(closes);
        
        if (computed.error) {
          indicatorErrors.push(`${snapshot.symbol}: ${computed.error}`);
          logger.warn(`⚠️  ${snapshot.symbol}: Not enough historical data`);
        } else {
          indicators[snapshot.symbol] = computed;
          logger.debug(`📈 ${snapshot.symbol}: RSI=${computed.rsi14}, MACD=${computed.macdLine}`);
        }
      } catch (err) {
        indicatorErrors.push(`${snapshot.symbol}: ${err.message}`);
        logger.error(`Failed to compute indicators for ${snapshot.symbol}`, err.message);
      }
    }

    if (Object.keys(indicators).length === 0) {
      throw new Error(`No valid indicators computed. Errors: ${indicatorErrors.join('; ')}`);
    }

    // ── 4. Ask Claude ─────────────────────────────────────────────
    logger.info('🧠 Sending context to Claude...');
    
    let decision;
    try {
      // Retrieve previous decisions for each symbol to provide historical context
      const previousDecisionsBySymbol = {};
      if (dbConnected) {
        for (const snapshot of snapshots) {
          try {
            const previous = await getPreviousDecisions(snapshot.symbol, 3);
            if (previous.length > 0) {
              previousDecisionsBySymbol[snapshot.symbol] = previous.map(d => ({
                timestamp: d.created_at.toISOString(),
                action: d.action,
                confidence: d.confidence,
                reasoning: d.reasoning
              }));
            }
          } catch (err) {
            logger.debug(`Could not retrieve previous decisions for ${snapshot.symbol}`);
          }
        }
      }
      
      const context = { balances, openOrders, snapshots, indicators, previousDecisionsBySymbol };
      decision = await analyzeMarket(context);
      logger.info(`✅ Claude response received`);
      logger.debug('Decision:', JSON.stringify(decision, null, 2));
    } catch (err) {
      throw new Error(`Claude analysis failed: ${err.message}`);
    }

    // Validate Claude's response
    if (!decision || !Array.isArray(decision.decisions)) {
      throw new Error(`Invalid decision format from Claude: ${JSON.stringify(decision)}`);
    }

    // ── 4.5. Save decisions to MongoDB ─────────────────────────────
    if (dbConnected) {
      try {
        logger.debug(`Attempting to save ${decision.decisions.length} decisions to MongoDB...`);
        for (const d of decision.decisions) {
          if (d.symbol) {
            await saveDecision({
              symbol: d.symbol,
              action: d.action,
              confidence: d.confidence,
              reasoning: d.reasoning || '',
              risks: d.risks || '',
              usdAmount: parseFloat(d.usdAmount) || 0,
              orderType: d.orderType || 'market',
              takeProfit: d.takeProfit || null,
              stopLoss: d.stopLoss || null
            }, triggerReason);
            logger.debug(`✅ Saved decision for ${d.symbol}`);
          }
        }
        logger.info(`✅ Saved ${decision.decisions.length} decision(s) to MongoDB`);
      } catch (err) {
        logger.warn(`⚠️  Failed to save decisions to MongoDB: ${err.message}`);
        logger.debug(`Stack: ${err.stack}`);
      }
    } else {
      logger.warn(`⚠️  MongoDB not connected - skipping decision save`);
    }

    // ── 5. Execute decisions ──────────────────────────────────────
    const execResults = [];
    let executedCount = 0, skippedCount = 0, errorCount = 0;

    for (const d of decision.decisions) {
      if (!d.symbol) {
        logger.warn('⚠️  Skipping decision with no symbol');
        continue;
      }

      if (d.action === 'HOLD') {
        execResults.push({ ...d, status: 'skipped', reason: 'HOLD decision' });
        skippedCount++;
        logger.info(`⏭️  ${d.symbol}: HOLD (confidence: ${d.confidence}%)`);
        continue;
      }

      if (d.confidence < 55) {
        execResults.push({ ...d, status: 'skipped', reason: `Confidence too low (${d.confidence})` });
        skippedCount++;
        logger.debug(`⏭️  ${d.symbol}: Confidence ${d.confidence}% < 55% threshold`);
        continue;
      }

      const usd = parseFloat(d.usdAmount);
      if (isNaN(usd) || usd < parseFloat(process.env.MIN_ORDER || '50')) {
        const minOrder = process.env.MIN_ORDER || '50';
        execResults.push({ ...d, status: 'skipped', reason: `Order too small ($${usd} < $${minOrder})` });
        skippedCount++;
        logger.debug(`⏭️  ${d.symbol}: Order size $${usd} < minimum $${minOrder}`);
        continue;
      }

      try {
        // Calculate quantity from USD amount and current price
        const currentPrice = indicators[d.symbol]?.currentPrice;
        if (!currentPrice) {
          throw new Error('No current price available');
        }

        const qty = OrderManager.calcQty(usd, currentPrice);
        
        // Calculate risk/reward metrics if TP/SL provided
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
          `💼 Executing ${d.action} ${d.symbol}: $${usd} → ${qty} units` +
          (rrMetrics ? ` | R/R: ${rrMetrics.riskRewardRatio} | TP: ${rrMetrics.tpDistance} SL: ${rrMetrics.slDistance}` : '')
        );

        const orderResult = await orders.placeOrder({
          symbol:      d.symbol,
          side:        d.action.toLowerCase(),
          type:        d.orderType ?? 'market',
          qty,
          price:       d.limitPrice,
          takeProfit:  d.takeProfit,  // TP price (stored but needs separate handling)
          stopLoss:    d.stopLoss     // SL price (stored but needs separate handling)
        });

        execResults.push({ ...d, status: 'executed', qty, orderResult, rrMetrics });
        executedCount++;
        
        // Log TP/SL info - noting that these need additional configuration
        if (d.takeProfit || d.stopLoss) {
          logger.info(
            `⚠️  TP/SL Configuration Needed:\n` +
            `   Entry: ${orderResult.payload?.order_configuration?.market?.base_size ? `≈$${parseFloat(d.usdAmount) / parseFloat(orderResult.payload.order_configuration.market.base_size)}` : 'Market'}\n` +
            `   Take Profit: $${d.takeProfit} (${rrMetrics?.tpDistance})\n` +
            `   Stop Loss: $${d.stopLoss} (${rrMetrics?.slDistance})\n` +
            `   Action: Place OCO order OR set manually in Revolut X`
          );
        } else {
          logger.info(`✅ ${d.symbol}: Order executed`);
        }

        // ─ Save order to MongoDB ──────────────────────────────────
        if (dbConnected && orderResult) {
          try {
            await saveOrder({
              symbol: d.symbol,
              side: d.action.toLowerCase(),
              orderType: d.orderType || 'market',
              qty: qty.toString(),
              price: orderResult.price || 0,
              usdAmount: parseFloat(d.usdAmount) || 0,
              revolutOrderId: orderResult.orderId || '',
              takeProfit: d.takeProfit || null,
              stopLoss: d.stopLoss || null,
              riskRewardRatio: rrMetrics?.riskRewardRatio || null,
              status: 'executed'
            });
            logger.debug(`💾 Saved order for ${d.symbol} to MongoDB with TP/SL`);
          } catch (err) {
            logger.warn(`⚠️  Failed to save order to MongoDB: ${err.message}`);
          }
        }
      } catch (err) {
        execResults.push({ ...d, status: 'error', error: err.message });
        errorCount++;
        logger.error(`❌ ${d.symbol}: Order failed`, err.message);
        await notifyError(`Order failed for ${d.symbol}: ${err.message}`).catch(() => {});
      }
    }

    // ── 6. Notify via Telegram ────────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    logger.debug(`DEBUG: About to format decision. execResults: ${execResults.length} items`);
    logger.debug(`DEBUG: decision keys: ${Object.keys(decision).join(', ')}`);
    
    try {
      const message = formatDecision({ decision, execResults, elapsed, triggerReason });
      logger.debug(`DEBUG: Formatted message length: ${message.length} chars`);
      logger.debug(`DEBUG: First 100 chars: ${message.substring(0, 100)}`);
      
      await notify(message);
      logger.info(`📤 Telegram notification sent`);
    } catch (err) {
      logger.error('Failed to send Telegram notification', err.message);
      logger.debug(`Stack: ${err.stack}`);
    }

    // ── 7. Save portfolio snapshot to MongoDB ──────────────────────
    if (dbConnected && balances) {
      try {
        await savePortfolioSnapshot(balances);
        logger.debug('💾 Saved portfolio snapshot to MongoDB');
      } catch (err) {
        logger.warn(`⚠️  Failed to save portfolio snapshot: ${err.message}`);
      }
    }

    // ── Summary ────────────────────────────────────────────────────
    logger.info(
      `✅ Cycle complete: ${executedCount} executed, ${skippedCount} skipped, ${errorCount} errors (${elapsed}s)`
    );

    return { decision, execResults, stats: { executedCount, skippedCount, errorCount, elapsedMs: Date.now() - startTime } };

  } catch (err) {
    const msg = `❌ Agent cycle failed: ${err.message}`;
    logger.error(msg, err);
    
    await notifyError(msg).catch(() => {
      logger.error('Failed to send error notification to Telegram', '');
    });
    
    throw err;
  } finally {
    // Disconnect MongoDB
    if (dbConnected) {
      try {
        await disconnectDB();
        logger.debug('✅ MongoDB disconnected');
      } catch (err) {
        logger.warn(`⚠️  Failed to disconnect MongoDB: ${err.message}`);
      }
    }
  }
}
