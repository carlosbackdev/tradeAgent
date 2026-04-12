/**
 * revolut/orders.js - Place and manage orders on Revolut X
 */

import { logger } from '../utils/logger.js';

export class OrderManager {
  constructor(client) {
    this.client = client;
    this.dryRun = process.env.DRY_RUN === 'true';
  }

  async placeOrder({ symbol, side, type, qty, price, takeProfit, stopLoss }) {
    const revolutSymbol = symbol.replace('/', '-');
    
    if (!symbol || !side || !type || !qty) {
      throw new Error(`Invalid order params: symbol=${symbol}, side=${side}, type=${type}, qty=${qty}`);
    }

    const orderConfig = {};
    if (type === 'market') {
      orderConfig.market = { base_size: qty.toString() };
    } else if (type === 'limit') {
      if (!price) throw new Error('Price required for limit orders');
      orderConfig.limit = { base_size: qty.toString(), price: price.toString() };
    } else {
      throw new Error(`Invalid order type: ${type}`);
    }

    const payload = {
      client_order_id: this.generateClientOrderId(),
      symbol: revolutSymbol,
      side: side.toLowerCase(),
      order_configuration: orderConfig
    };

    if (this.dryRun) {
      logger.info(`[DRY RUN] Order: ${side.toUpperCase()} ${qty} ${revolutSymbol} @ ${price || 'market'}`);
      return {
        dryRun: true,
        clientOrderId: payload.client_order_id,
        orderId: `dry-${Date.now()}`,
        symbol: revolutSymbol,
        side: side.toLowerCase(),
        type,
        qty: qty.toString(),
        takeProfit: takeProfit || null,
        stopLoss: stopLoss || null
      };
    }

    try {
      logger.info(`📤 Sending order: ${side.toUpperCase()} ${qty} ${revolutSymbol}`);
      const result = await this.client.post('/orders', payload);
      logger.info(`✅ Order placed: ${result?.id || 'N/A'}`);
      
      return {
        ...result,
        clientOrderId: payload.client_order_id,
        symbol: revolutSymbol,
        side: side.toLowerCase(),
        type,
        qty: qty.toString(),
        takeProfit: takeProfit || null,
        stopLoss: stopLoss || null
      };
    } catch (err) {
      logger.error(`❌ Order failed: ${err.message}`);
      throw new Error(`Failed to place order: ${err.message}`);
    }
  }

  generateClientOrderId() {
    return `order-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  async cancelOrder(orderId) {
    if (this.dryRun) {
      logger.info(`[DRY RUN] Cancel order: ${orderId}`);
      return { dryRun: true, orderId };
    }
    return this.client.delete(`/orders/${orderId}`);
  }

  async getOrder(orderId) {
    return this.client.get(`/orders/${orderId}`);
  }

  static calcQty(usdAmount, currentPrice, decimals = 6) {
    return (usdAmount / currentPrice).toFixed(decimals);
  }

  static calcRiskReward(entryPrice, takeProfit, stopLoss, side = 'buy') {
    let tpDistance, slDistance, ratio;
    
    if (side === 'buy') {
      tpDistance = ((takeProfit - entryPrice) / entryPrice * 100).toFixed(2);
      slDistance = ((entryPrice - stopLoss) / entryPrice * 100).toFixed(2);
    } else {
      tpDistance = ((entryPrice - takeProfit) / entryPrice * 100).toFixed(2);
      slDistance = ((stopLoss - entryPrice) / entryPrice * 100).toFixed(2);
    }
    
    ratio = (Math.abs(parseFloat(tpDistance)) / Math.abs(parseFloat(slDistance))).toFixed(2);
    
    return {
      tpDistance: `+${tpDistance}%`,
      slDistance: `-${slDistance}%`,
      riskRewardRatio: ratio,
      tpDistanceNum: parseFloat(tpDistance),
      slDistanceNum: parseFloat(slDistance)
    };
  }
}
