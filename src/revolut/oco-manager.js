/**
 * revolut/oco-manager.js
 * OCO (One-Cancels-Other) order management for Revolut X
 * Manages entry + TP + SL orders with automatic cancellation of losing branch
 */

import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';

export class OCOManager {
  constructor(client) {
    this.client = client;
    this.dryRun = config.debug.dryRun;
    this.activeOCOs = new Map(); // Map<entryOrderId, { entry, tp, sl, createdAt, status }>
  }

  /**
   * Place an OCO order: entry + take profit + stop loss
   * @param {string} symbol - Trading pair (e.g., 'BTC-USD')
   * @param {number} qty - Quantity to trade
   * @param {number} entryPrice - Entry price
   * @param {number} tpPrice - Take profit price
   * @param {number} slPrice - Stop loss price
   * @returns {Promise<{entry, takeProfit, stopLoss, status}>}
   */
  async placeOCOEntry(symbol, qty, entryPrice, tpPrice, slPrice) {
    try {
      // Validate inputs
      if (!symbol || typeof symbol !== 'string' || symbol.trim().length === 0) {
        throw new Error('Invalid symbol: must be non-empty string');
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error('Invalid qty: must be positive number');
      }
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        throw new Error('Invalid entryPrice: must be positive number');
      }
      if (!Number.isFinite(tpPrice) || tpPrice <= 0) {
        throw new Error('Invalid tpPrice: must be positive number');
      }
      if (!Number.isFinite(slPrice) || slPrice <= 0) {
        throw new Error('Invalid slPrice: must be positive number');
      }

      // Validate price logic
      if (tpPrice <= entryPrice) {
        throw new Error('Take profit price must be above entry price');
      }
      if (slPrice >= entryPrice) {
        throw new Error('Stop loss price must be below entry price');
      }

      const normalizedSymbol = this._toDashedSymbol(symbol);

      if (this.dryRun) {
        logger.info(`[DRY RUN] OCO Entry: ${qty} ${normalizedSymbol} @ $${entryPrice} | TP: $${tpPrice} | SL: $${slPrice}`);
        const dryEntryId = `dry-entry-${Date.now()}`;
        const dryTPId = `dry-tp-${Date.now() + 1}`;
        const drySLId = `dry-sl-${Date.now() + 2}`;

        const ocoData = {
          entry: { orderId: dryEntryId, price: entryPrice, qty, status: 'pending', createdAt: new Date() },
          takeProfit: { orderId: dryTPId, price: tpPrice, qty, status: 'pending', createdAt: new Date() },
          stopLoss: { orderId: drySLId, price: slPrice, qty, status: 'pending', createdAt: new Date() },
          status: 'active'
        };

        this.activeOCOs.set(dryEntryId, ocoData);
        logger.info(`✅ OCO created (dry-run): ${dryEntryId}`);

        return ocoData;
      }

      // Real execution: Place entry order first
      const entryOrder = await this._placeOrder(normalizedSymbol, 'buy', 'limit', qty, entryPrice);
      if (!entryOrder || !entryOrder.orderId) {
        throw new Error('Failed to place entry order');
      }

      // Place TP and SL orders
      let tpOrder, slOrder;
      try {
        tpOrder = await this._placeOrder(normalizedSymbol, 'sell', 'limit', qty, tpPrice);
        slOrder = await this._placeOrder(normalizedSymbol, 'sell', 'limit', qty, slPrice);
      } catch (err) {
        // If TP/SL placement fails, cancel entry order to avoid orphaned order
        logger.warn(`Failed to place TP/SL orders, cancelling entry order: ${err.message}`);
        try {
          await this._cancelOrder(entryOrder.orderId);
        } catch (cancelErr) {
          logger.error(`Failed to cancel entry order during rollback: ${cancelErr.message}`);
        }
        throw err;
      }

      const ocoData = {
        entry: { orderId: entryOrder.orderId, price: entryPrice, qty, status: 'pending', createdAt: new Date() },
        takeProfit: { orderId: tpOrder.orderId, price: tpPrice, qty, status: 'pending', createdAt: new Date() },
        stopLoss: { orderId: slOrder.orderId, price: slPrice, qty, status: 'pending', createdAt: new Date() },
        status: 'active'
      };

      this.activeOCOs.set(entryOrder.orderId, ocoData);
      logger.info(`✅ OCO placed: entry=${entryOrder.orderId}, tp=${tpOrder.orderId}, sl=${slOrder.orderId}`);

      return ocoData;
    } catch (err) {
      logger.error(`OCO placement failed: ${err.message}`, err);
      throw err;
    }
  }

  /**
   * Monitor an OCO and cancel the losing branch when the winning branch executes
   * @param {string} entryOrderId - Entry order ID to monitor
   * @param {number} timeoutMs - Timeout in milliseconds (default 24 hours)
   * @returns {Promise<{executed, profit, executedBranch, filledQty, avgPrice}>}
   */
  async monitorOCO(entryOrderId, timeoutMs = 24 * 60 * 60 * 1000) {
    try {
      const ocoData = this.activeOCOs.get(entryOrderId);
      if (!ocoData) {
        throw new Error(`OCO not found: ${entryOrderId}`);
      }

      if (this.dryRun) {
        logger.info(`[DRY RUN] Monitoring OCO: ${entryOrderId}`);
        // In dry-run, simulate execution after a short delay
        await new Promise(r => setTimeout(r, 1000));
        const simProfit = Math.random() > 0.5 ? 10 : -5; // Random profit/loss
        logger.info(`[DRY RUN] OCO executed with ${simProfit}% profit`);
        return { 
          executed: true, 
          profit: simProfit, 
          executedBranch: simProfit > 0 ? 'takeProfit' : 'stopLoss',
          filledQty: ocoData.entry.qty,
          avgPrice: ocoData.entry.price
        };
      }

      const startTime = Date.now();
      let retryCount = 0;
      const maxRetries = 5;

      // Poll until entry fills or timeout
      while (Date.now() - startTime < timeoutMs) {
        try {
          const entryStatus = await this._checkOrderStatus(entryOrderId);
          if (!entryStatus.executed) {
            logger.debug(`OCO still pending: ${entryOrderId}`);
            await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds before retry
            continue;
          }

          // Entry executed, check TP and SL status
          const tpStatus = await this._checkOrderStatus(ocoData.takeProfit.orderId);
          const slStatus = await this._checkOrderStatus(ocoData.stopLoss.orderId);

          let executedBranch = null;
          let profit = null;

          if (tpStatus.executed) {
            executedBranch = 'takeProfit';
            profit = ((ocoData.takeProfit.price - ocoData.entry.price) / ocoData.entry.price) * 100;
            // Cancel SL
            try {
              await this._cancelOrder(ocoData.stopLoss.orderId);
            } catch (cancelErr) {
              logger.warn(`Could not cancel SL order: ${cancelErr.message}`);
            }
            logger.info(`✅ OCO PROFIT: TP executed at $${ocoData.takeProfit.price} (+${profit.toFixed(2)}%)`);
          } else if (slStatus.executed) {
            executedBranch = 'stopLoss';
            profit = ((ocoData.stopLoss.price - ocoData.entry.price) / ocoData.entry.price) * 100;
            // Cancel TP
            try {
              await this._cancelOrder(ocoData.takeProfit.orderId);
            } catch (cancelErr) {
              logger.warn(`Could not cancel TP order: ${cancelErr.message}`);
            }
            logger.warn(`⚠️ OCO LOSS: SL executed at $${ocoData.stopLoss.price} (${profit.toFixed(2)}%)`);
          } else {
            logger.info(`OCO: Entry executed but TP/SL pending`);
            return { 
              executed: true, 
              profit: null, 
              executedBranch: null,
              filledQty: entryStatus.filledQty,
              avgPrice: entryStatus.avgPrice
            };
          }

          // Mark OCO as closed
          ocoData.status = 'closed';
          this.activeOCOs.delete(entryOrderId);

          return { 
            executed: true, 
            profit, 
            executedBranch,
            filledQty: tpStatus.filledQty || slStatus.filledQty,
            avgPrice: tpStatus.avgPrice || slStatus.avgPrice
          };
        } catch (statusErr) {
          retryCount++;
          if (retryCount > maxRetries) {
            logger.error(`Max retries exceeded for OCO ${entryOrderId}: ${statusErr.message}`);
            throw statusErr;
          }
          logger.warn(`Retry ${retryCount}/${maxRetries} for OCO ${entryOrderId}: ${statusErr.message}`);
          await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds before retry
        }
      }

      // Timeout reached
      logger.warn(`OCO monitoring timeout: ${entryOrderId} (${timeoutMs}ms)`);
      return { executed: false, timedOut: true };
    } catch (err) {
      logger.error(`OCO monitoring failed: ${err.message}`, err);
      throw err;
    }
  }

  /**
   * Get list of active OCOs
   * @returns {Array}
   */
  getActiveOCOs() {
    const active = [];
    this.activeOCOs.forEach((ocoData, entryOrderId) => {
      if (ocoData.status === 'active') {
        active.push({
          entryOrderId,
          entry: ocoData.entry,
          takeProfit: ocoData.takeProfit,
          stopLoss: ocoData.stopLoss,
          createdAt: ocoData.entry.createdAt
        });
      }
    });
    return active;
  }

  /**
   * Clean up stale OCOs (older than maxAgeHours)
   * @param {number} maxAgeHours - Age threshold in hours
   * @returns {Promise<number>} - Number of cleaned OCOs
   */
  async cleanupStaleOCOs(maxAgeHours = 24) {
    let cleaned = 0;
    const now = new Date();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

    for (const [entryOrderId, ocoData] of this.activeOCOs.entries()) {
      const age = now - ocoData.entry.createdAt;
      if (age > maxAgeMs) {
        try {
          if (!this.dryRun) {
            // Cancel all orders in the OCO
            await this._cancelOrder(ocoData.entry.orderId);
            await this._cancelOrder(ocoData.takeProfit.orderId);
            await this._cancelOrder(ocoData.stopLoss.orderId);
          }
          this.activeOCOs.delete(entryOrderId);
          cleaned++;
          logger.info(`🧹 Cleaned stale OCO: ${entryOrderId}`);
        } catch (err) {
          logger.warn(`Failed to clean OCO ${entryOrderId}: ${err.message}`);
        }
      }
    }

    logger.info(`✅ Stale OCO cleanup completed: ${cleaned} removed`);
    return cleaned;
  }

  // ── Private helpers ──────────────────────────────────────────

  _toDashedSymbol(symbol) {
    return symbol.replace('/', '-');
  }

  /**
   * Place a single order via the API
   * @private
   */
  async _placeOrder(symbol, side, type, qty, price) {
    try {
      logger.debug(`Placing order: ${side} ${qty} ${symbol} @ $${price}`);
      
      // Use actual Revolut client to place order
      const order = await this.client.placeOrder({
        symbol,
        side,
        type,
        quantity: qty,
        price,
        timeInForce: 'GTC' // Good-Till-Cancelled
      });
      
      if (!order || !order.orderId) {
        throw new Error('Invalid order response from API');
      }
      
      logger.debug(`Order placed successfully: ${order.orderId}`);
      return order;
    } catch (err) {
      logger.error(`Failed to place order: ${err.message}`, err);
      throw err;
    }
  }

  /**
   * Check order status via API
   * @private
   */
  async _checkOrderStatus(orderId) {
    try {
      logger.debug(`Checking order status: ${orderId}`);
      
      // Query actual Revolut API for order status
      const orderStatus = await this.client.getOrderStatus(orderId);
      
      if (!orderStatus) {
        throw new Error(`Order ${orderId} not found`);
      }
      
      return {
        orderId,
        executed: orderStatus.status === 'filled' || orderStatus.status === 'partially_filled',
        filledQty: orderStatus.filledQty || 0,
        status: orderStatus.status,
        avgPrice: orderStatus.avgPrice
      };
    } catch (err) {
      logger.error(`Failed to check order status: ${err.message}`, err);
      throw err;
    }
  }

  /**
   * Cancel an order via API
   * @private
   */
  async _cancelOrder(orderId) {
    try {
      if (this.dryRun) {
        logger.info(`[DRY RUN] Cancelling order: ${orderId}`);
        return true;
      }
      
      logger.debug(`Cancelling order: ${orderId}`);
      
      // Use actual Revolut client to cancel order
      const result = await this.client.cancelOrder(orderId);
      
      if (result && result.success) {
        logger.debug(`Order cancelled successfully: ${orderId}`);
        return true;
      }
      
      logger.warn(`Failed to cancel order ${orderId}`);
      return false;
    } catch (err) {
      logger.error(`Failed to cancel order: ${err.message}`, err);
      throw err;
    }
  }
}
