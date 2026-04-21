/**
 * open-orders-manager.js
 * Manages detection, analysis, and resolution of open orders for a trading symbol
 * Reuses callClaudeWithCustomPrompt for consistent JSON parsing and Claude communication
 */

import { logger } from '../../utils/logger.js';
import { notify } from '../../telegram/handles.js';
import { saveOrder, saveDecision } from '../../utils/mongodb.js';
import { analyzeOpenOrderWithClaude } from '../context/open-order-analyzer.js';

/**
 * Fetch pending (open) orders for a specific symbol from Revolut API
 * @param {string} symbol - Trading symbol (e.g., 'BTC-USD')
 * @param {Object} client - Revolut API client
 * @returns {Array} Array of open orders
 */

/**
 * Process open orders for a symbol using full market context
 * Follows executor pattern: save decision → execute → save result
 * @param {string} symbol - Trading symbol
 * @param {Array} openOrdersThisCoin - Already-filtered open orders for THIS symbol
 * @param {Object} analyzerContext - Full trading context (indicators, balances, history, etc.)
 * @param {Object} client - Revolut API client
 * @param {Object} revolutAPI - Full Revolut API client (for cancellation/orders)
 * @param {boolean} dbConnected - Whether MongoDB is connected
 * @param {string} triggerReason - Why this cycle was triggered (for decision logging)
 * @returns {Promise<Object>} Processing result
 */
export async function processOpenOrders(
  symbol,
  openOrdersThisCoin,
  analyzerContext,
  client,
  revolutAPI,
  dbConnected = false,
  triggerReason = 'open_order_analysis',
  chatId = null,
  effectiveConfig = null
) {
  try {
    const anthConfig = effectiveConfig?.anthropic;
    const tradingConfig = effectiveConfig?.trading;

    if (!anthConfig || !tradingConfig) {
      throw new Error('Missing effectiveConfig for open order analysis');
    }

    logger.info(`⏳ Processing ${openOrdersThisCoin.length} open order(s) for ${symbol} with user ${chatId || 'single_user'}...`);

    const results = {
      status: 'ok',
      symbol,
      found: openOrdersThisCoin.length,
      cancelled: 0,
      kept: 0,
      buy_more_count: 0,
      cancelledOrders: [],
      executedOrders: [],
      errors: [],
    };

    // Analyze each order using full context
    for (const order of openOrdersThisCoin) {
      try {
        // Step 1: Get Claude decision
        const analysis = await analyzeOpenOrderWithClaude(
          order, 
          analyzerContext, 
          symbol, 
          anthConfig.apiKey, 
          anthConfig.model, 
          tradingConfig
        );
        const orderId = order.id || order.order_id;

        // Step 2: Save decision to MongoDB (like executor step 6)
        let decisionId = null;
        if (dbConnected) {
          try {
            const decisionPayload = {
              symbol,
              action: analysis.action === 'buy_more' ? 'BUY' : analysis.action === 'cancel' ? 'CANCEL' : 'HOLD',
              confidence: analysis.confidence,
              reasoning: `Open order ${analysis.action}: ${analysis.reasoning}`,
              risks: `Open order management for ${orderId}`,
              usdAmount: 0, // Open order decisions don't have USD amount
              orderType: 'market',
              takeProfit: null,
              stopLoss: null,
              open_order_id: orderId,
              open_order_action: analysis.action,
            };

            const saved = await saveDecision(decisionPayload, triggerReason, chatId);
            decisionId = saved?._id;
            logger.debug(`💾 Saved decision for open order ${orderId}`);
          } catch (err) {
            logger.warn(`⚠️ Failed to save decision for open order ${orderId}: ${err.message}`);
          }
        }

        // Step 3: Execute decision (like executor step 7)
        if (analysis.action === 'cancel') {
          // Cancel the order
          try {
            await revolutAPI?.cancelOrder?.(orderId);
            logger.info(`✅ Cancelled order ${orderId} for ${symbol}`);
            
            results.cancelled++;
            results.cancelledOrders.push({
              id: orderId,
              reason: analysis.reasoning,
              confidence: analysis.confidence,
              decision_id: decisionId,
            });
          } catch (cancelErr) {
            logger.error(`❌ Failed to cancel order ${orderId}: ${cancelErr.message}`);
            results.errors.push({
              order_id: orderId,
              action: 'cancel',
              error: cancelErr.message,
            });
          }
        } else if (analysis.action === 'buy_more') {
          // Place additional BUY order
          logger.info(`📈 Placing BUY_MORE for ${symbol} (Claude confidence: ${analysis.confidence}%)`);
          const buyQuantity = analysis.buy_more_quantity || (order.quantity || 0);
          
          try {
            const newOrder = await revolutAPI?.placeOrder?.({
              symbol,
              side: 'buy',
              quantity: buyQuantity,
              type: 'market',
            });
            
            if (newOrder) {
              logger.info(`✅ Placed BUY order for ${symbol}: ${buyQuantity} units`);
              results.buy_more_count++;
              
              // Save executed order (like executor does after executeDecisions)
              if (dbConnected && newOrder.id) {
                try {
                  const execPrice = newOrder.price || analyzerContext.lastPrice || null;
                  const usdAmount = execPrice ? Number(buyQuantity) * Number(execPrice) : null;
                  await saveOrder({
                    decisionId,
                    symbol,
                    side: 'buy',
                    orderType: 'market',
                    qty: buyQuantity,
                    price: execPrice,
                    positionPct: null,
                    usdAmount,
                    revolutOrderId: newOrder.id,
                    takeProfit: null,
                    stopLoss: null,
                    riskRewardRatio: null,
                    status: 'executed',
                    error: null,
                    rendimiento: null,
                    chatId,
                  });
                } catch (err) {
                  logger.warn(`⚠️ Failed to save executed BUY order: ${err.message}`);
                }
              }
              
              results.executedOrders.push({
                id: newOrder.id,
                type: 'buy_more',
                quantity: buyQuantity,
                decision_id: decisionId,
              });
            }
          } catch (buyErr) {
            logger.error(`❌ Failed to place BUY order: ${buyErr.message}`);
            results.errors.push({
              action: 'buy_more',
              error: buyErr.message,
            });
          }
        } else {
          // KEEP order as-is
          logger.info(`⏳ Keeping order ${orderId} (confidence: ${analysis.confidence}%)`);
          results.kept++;
        }
      } catch (err) {
        logger.error(`❌ Error processing order: ${err.message}`);
        results.errors.push({ error: err.message });
      }
    }

    // ── Send Telegram Notification ─────────────────────────────────
    const summaryMessage = `📋 *Open Orders Processing*\n${symbol}:\n✅ ${results.cancelled} cancelled\n📈 ${results.buy_more_count} buy_more\n⏳ ${results.kept} kept`;
    
    try {
      await notify(summaryMessage);
      logger.info('📤 Open orders Telegram notification sent');
    } catch (notifyErr) {
      logger.warn(`⚠️ Failed to send Telegram notification: ${notifyErr.message}`);
    }

    logger.info(`📊 Summary: ${results.cancelled} cancelled, ${results.kept} kept, ${results.buy_more_count} buy_more`);
    return results;
  } catch (err) {
    logger.error(`❌ Open orders processing failed: ${err.message}`);
    
    try {
      await notify(`❌ *Open Orders Error* (${symbol}): ${err.message}`);
    } catch (notifyErr) {
      logger.warn(`⚠️ Failed to send error notification: ${notifyErr.message}`);
    }
    
    return {
      symbol,
      status: 'error',
      error: err.message,
      found: openOrdersThisCoin.length,
      cancelled: 0,
      kept: 0,
      buy_more_count: 0,
    };
  }
}
