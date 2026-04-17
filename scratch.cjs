const fs = require('fs');
let code = fs.readFileSync('src/agent/executor.js', 'utf8');

// Buscamos el inicio: "    logger.info(`📊 Fetching data for: ${pairs.join(', ')}`);"
const startIdx = code.indexOf('\n    logger.info(`📊 Fetching data for: ${pairs.join(\', \')}`);');
// Y buscamos el fin: "\n  } catch (err) {"
const endIdx = code.indexOf('\n  } catch (err) {', startIdx);

if (startIdx === -1 || endIdx === -1) {
    console.error('No se encontraron los índices', startIdx, endIdx);
    process.exit(1);
}

const chunk = `
    const balances = await market.getBalances().catch(err => {
      throw new Error(\`Failed to fetch balances: \${err.message}\`);
    });
    const relevantBalances = extractRelevantBalances(balances);

    const aggregatedDecision = { decisions: [] };
    const execResults = [];
    let executedCount = 0, skippedCount = 0, errorCount = 0;

    for (const symbol of pairs) {
      logger.info(\`\\n🔸 Procesando \${symbol}...\`);
      try {
        const [openOrders, snapshot] = await Promise.all([
          market.getOpenOrders([symbol]),
          market.getSnapshot(symbol)
        ]);

        const candlesArray = snapshot.candles?.candles || snapshot.candles || [];
        const closes = closesFromCandles(candlesArray);
        const computed = computeIndicators(closes);

        const indicators = {};
        if (computed.error) {
          logger.warn(\`⚠️ \${symbol}: \${computed.error}\`);
          continue;
        }
        indicators[symbol] = computed;
        logger.debug(\`📈 \${symbol}: RSI=\${computed.rsi14}, MACD=\${computed.macdLine}\`);

        const previousDecisionsBySymbol = {};
        if (dbConnected) {
          try {
            const prev = await getPreviousDecisions(symbol, 3);
            if (prev.length > 0) {
              previousDecisionsBySymbol[symbol] = prev.map(d => ({
                timestamp:  d.created_at.toISOString(),
                action:     d.action,
                confidence: d.confidence,
                reasoning:  d.reasoning?.substring(0, 80), 
              }));
            }
          } catch { /* ignore */ }
        }

        const compactPairs = [{
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
        }];

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

        const decision = await callAgentAnalyzer(analyzerContext);
        logger.info(\`✅ Claude decision received for \${symbol}\`);
        
        if (!decision || !Array.isArray(decision.decisions)) {
          throw new Error(\`Invalid decision format for \${symbol}: \${JSON.stringify(decision)}\`);
        }

        for (const d of decision.decisions) {
          if (!d.symbol) continue;
          aggregatedDecision.decisions.push(d);

          if (dbConnected) {
            try {
              await saveDecision({
                symbol:     d.symbol,
                action:     d.action,
                confidence: d.confidence,
                reasoning:  d.reasoning || '',
                risks:      d.risks     || '',
                usdAmount:  parseFloat(d.usdAmount) || 0,
                orderType:  d.orderType || 'market',
                takeProfit: d.takeProfit || null,
                stopLoss:   d.stopLoss  || null,
              }, triggerReason);
            } catch (err) {
              logger.warn(\`⚠️  Failed to save decision for \${d.symbol}: \${err.message}\`);
            }
          }

          if (d.action === 'HOLD') {
            execResults.push({ ...d, status: 'skipped', reason: 'HOLD decision' });
            skippedCount++;
            continue;
          }

          if (d.confidence < 55) {
            execResults.push({ ...d, status: 'skipped', reason: \`Low confidence (\${d.confidence}%)\` });
            skippedCount++;
            continue;
          }

          const usd = parseFloat(d.usdAmount);
          const minOrder = parseFloat(process.env.MIN_ORDER || '10');
          if (isNaN(usd) || usd < minOrder) {
            execResults.push({ ...d, status: 'skipped', reason: \`Amount $\${usd} < minimum $\${minOrder}\` });
            skippedCount++;
            continue;
          }

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
              \`💼 \${d.action} \${d.symbol}: $\${usd}\` +
              (rrMetrics ? \` | R/R: \${rrMetrics.riskRewardRatio}\` : '')
            );

            const orderResult = await orders.placeOrder({
              symbol:       d.symbol,
              side:         d.action.toLowerCase(),
              type:         d.orderType ?? 'market',
              usdAmount:    usd,
              price:        d.limitPrice,
              currentPrice: currentPrice,
              takeProfit:   d.takeProfit,
              stopLoss:     d.stopLoss,
            });

            execResults.push({ ...d, status: 'executed', usdAmount: usd, orderResult, rrMetrics });
            executedCount++;

            try {
              await notifyOrderExecuted({
                symbol: d.symbol,
                side: d.action.toLowerCase(),
                qty: orderResult.qty || 'pte.',
                usdAmount: usd.toFixed(2),
                price: currentPrice.toFixed(2),
              });
            } catch (err) {
              logger.warn(\`⚠️  Failed to notify order execution: \${err.message}\`);
            }

            if (dbConnected && orderResult) {
              try {
                await saveOrder({
                  symbol:          d.symbol,
                  side:            d.action.toLowerCase(),
                  orderType:       d.orderType || 'market',
                  qty:             orderResult.qty || '',
                  price:           currentPrice,
                  usdAmount:       usd,
                  revolutOrderId:  orderResult.venue_order_id || orderResult.orderId || '',
                  takeProfit:      d.takeProfit || null,
                  stopLoss:        d.stopLoss   || null,
                  riskRewardRatio: rrMetrics?.riskRewardRatio || null,
                  status:          'executed',
                });
              } catch (err) {
                logger.warn(\`⚠️  Failed to save order: \${err.message}\`);
              }
            }
          } catch (err) {
            execResults.push({ ...d, status: 'error', error: err.message });
            errorCount++;
            logger.error(\`❌ \${d.symbol}: \${err.message}\`);
            await notifyError(\`Order failed for \${d.symbol}: \${err.message}\`).catch(() => {});
          }
        }
      } catch (err) {
        logger.error(\`❌ Cycle failed for pair \${symbol}: \${err.message}\`);
      }
    }

    const decision = aggregatedDecision;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    try {
      const message = formatDecision({ decision, execResults, elapsed, triggerReason });
      await notify(message);
      logger.info('📤 Telegram notification sent');
    } catch (err) {
      logger.error('Failed to send Telegram notification:', err.message);
    }

    if (dbConnected && balances) {
      try {
        await savePortfolioSnapshot(balances);
      } catch (err) {
        logger.warn(\`⚠️  Failed to save portfolio snapshot: \${err.message}\`);
      }
    }

    logger.info(\`✅ Cycle complete: \${executedCount} executed, \${skippedCount} skipped, \${errorCount} errors (\${elapsed}s)\`);
    return { decision, execResults, stats: { executedCount, skippedCount, errorCount } };`;

const newCode = code.substring(0, startIdx) + chunk + code.substring(endIdx);
fs.writeFileSync('src/agent/executor.js', newCode, 'utf8');
console.log('Replaced successfully');
