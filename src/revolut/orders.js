/**
 * revolut/orders.js
 * Place and manage orders on Revolut X.
 */

import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';

export class OrderManager {
  constructor(client) {
    this.client = client;
    this.dryRun = process.env.DRY_RUN === 'true';
  }

  _toDashedSymbol(symbol) {
    return symbol.replace('/', '-');
  }

  async placeOrder({ symbol, side, type, usdAmount, price, currentPrice, takeProfit, stopLoss }) {
    if (!symbol || !side || !type || usdAmount === undefined || usdAmount === null) {
      throw new Error(`Missing order params: symbol=${symbol}, side=${side}, type=${type}, usdAmount=${usdAmount}`);
    }

    const usd = Number(usdAmount);
    if (!Number.isFinite(usd) || usd <= 0) {
      throw new Error(`Invalid usdAmount: ${usdAmount}`);
    }

    const revolutSymbol = this._toDashedSymbol(symbol);

    let order_configuration;
    let estimatedQty = null;

    if (type === 'market') {
      // For market orders, estimate qty using currentPrice if available
      const priceForQty = currentPrice || price;
      if (priceForQty) {
        estimatedQty = (usd / Number(priceForQty)).toFixed(8);
      }
      order_configuration = {
        market: {
          quote_size: usd.toFixed(2),
        },
      };
    } else if (type === 'limit') {
      const parsedPrice = Number(price);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        throw new Error(`Invalid limit price: ${price}`);
      }

      const cryptoQty = (usd / parsedPrice).toFixed(8);
      estimatedQty = cryptoQty;

      order_configuration = {
        limit: {
          base_size: cryptoQty,
          price: parsedPrice.toFixed(2),
          execution_instructions: ['allow_taker'],
        },
      };
    } else {
      throw new Error(`Invalid order type: ${type}`);
    }

    const payload = {
      client_order_id: randomUUID(),
      symbol: revolutSymbol,
      side: side.toLowerCase(),
      order_configuration,
    };

    if (this.dryRun) {
      logger.info(`[DRY RUN] ${side.toUpperCase()} $${usd} ${revolutSymbol} (${type})`);
      return {
        dryRun: true,
        clientOrderId: payload.client_order_id,
        orderId: `dry-${Date.now()}`,
        symbol: revolutSymbol,
        side: payload.side,
        type,
        usdAmount: usd,
        qty: estimatedQty,
        takeProfit: takeProfit || null,
        stopLoss: stopLoss || null,
        payload,
      };
    }

    const result = await this.client.post('/orders', payload);

    return {
      ...(result?.data || {}),
      raw: result,
      clientOrderId: payload.client_order_id,
      symbol: revolutSymbol,
      side: payload.side,
      type,
      usdAmount: usd,
      qty: result?.data?.base_size || estimatedQty || result?.base_size,
      takeProfit: takeProfit || null,
      stopLoss: stopLoss || null,
    };
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

  static calcRiskReward(entryPrice, takeProfit, stopLoss, side = 'buy') {
    const entry = Number(entryPrice);
    const tp = Number(takeProfit);
    const sl = Number(stopLoss);

    const tpDistancePct = side === 'buy'
      ? ((tp - entry) / entry) * 100
      : ((entry - tp) / entry) * 100;

    const slDistancePct = side === 'buy'
      ? ((entry - sl) / entry) * 100
      : ((sl - entry) / entry) * 100;

    const ratio = slDistancePct > 0
      ? (Math.abs(tpDistancePct) / Math.abs(slDistancePct)).toFixed(2)
      : 'N/A';

    return {
      tpDistance: `+${tpDistancePct.toFixed(2)}%`,
      slDistance: `-${slDistancePct.toFixed(2)}%`,
      riskRewardRatio: ratio,
      tpDistanceNum: tpDistancePct,
      slDistanceNum: slDistancePct,
    };
  }
}