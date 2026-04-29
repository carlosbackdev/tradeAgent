import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';

export class OrderManager {
  constructor(client) {
    this.client = client;
    this.dryRun = this.client.config?.debug?.dryRun ?? config.debug.dryRun;
  }

  _toDashedSymbol(symbol) {
    return symbol.replace('/', '-');
  }

  _formatPrice(price) {
    const num = Number(price);
    if (!Number.isFinite(num) || num <= 0) return null;
    let originalDecimals = 0;
    if (price.toString().includes('.')) {
      originalDecimals = price.toString().split('.')[1].length;
    }
    if (num >= 1000) return num.toFixed(2);
    if (num >= 1) return num.toFixed(Math.max(4, Math.min(originalDecimals, 8)));
    return num.toFixed(Math.max(6, Math.min(originalDecimals, 8)));
  }

  async placeOrder({ symbol, side, type, usdAmount, baseAmount, price, currentPrice, takeProfit, stopLoss }) {
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
      const priceForQty = currentPrice || price;
      if (priceForQty) {
        estimatedQty = (usd / Number(priceForQty)).toFixed(8);
      }
      
      if (side.toLowerCase() === 'sell' && baseAmount && Number(baseAmount) > 0) {
        order_configuration = {
          market: {
            base_size: Number(baseAmount).toFixed(8)
          }
        };
        estimatedQty = Number(baseAmount).toFixed(8);
      } else {
        order_configuration = {
          market: {
            quote_size: usd.toFixed(2),
          },
        };
      }
    } else if (type === 'limit') {
      const formattedPrice = this._formatPrice(price);
      if (!formattedPrice) {
        throw new Error(`Invalid limit price: ${price}`);
      }

      let cryptoQty;
      if (side.toLowerCase() === 'sell' && baseAmount && Number(baseAmount) > 0) {
        cryptoQty = Number(baseAmount).toFixed(8);
      } else {
        cryptoQty = (usd / Number(formattedPrice)).toFixed(8);
      }
      
      estimatedQty = cryptoQty;

      order_configuration = {
        limit: {
          base_size: cryptoQty,
          price: formattedPrice,
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