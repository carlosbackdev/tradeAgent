/**
 * revolut/market.js
 * Real market data from Revolut X only.
 */

import { logger } from '../utils/logger.js';

export class MarketData {
  constructor(client) {
    this.client = client;
  }

  _toDashedSymbol(symbol) {
    return symbol.replace('/', '-');
  }

  _toSlashedSymbol(symbol) {
    return symbol.replace('-', '/');
  }

  _safeNum(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * Get ticker from Revolut X.
   * Docs show ticker response entries with symbol like BTC/USD.
   */
  async getTicker(symbol) {
    const res = await this.client.get('/market-data/ticker', {
      symbols: symbol,
    });

    const item = res?.data?.find?.(t => t.symbol === symbol) || res?.data?.[0];
    if (!item) {
      throw new Error(`No ticker returned for ${symbol}`);
    }

    return {
      symbol: item.symbol,
      bid: this._safeNum(item.bid),
      ask: this._safeNum(item.ask),
      mid: this._safeNum(item.mid),
      last: this._safeNum(item.last_price),
      timestamp: item?.metadata?.timestamp || Date.now(),
    };
  }

  /**
   * Real order book snapshot.
   * Docs use path param symbol like BTC-USD and limit 1..20.
   */
  async getOrderBook(symbol, depth = 10) {
    const dashed = this._toDashedSymbol(symbol);
    const limit = Math.min(Math.max(depth, 1), 20);

    const res = await this.client.get(`/market-data/order-book/${dashed}`, { limit });
    const data = res?.data;

    if (!data) {
      throw new Error(`No order book returned for ${symbol}`);
    }

    const normalizeLevel = (level) => ({
      price: this._safeNum(level.p ?? level.price),
      size: this._safeNum(level.a ?? level.amount ?? level.size),
      side: level.s ?? null,
      assetId: level.aid ?? null,
      assetName: level.anm ?? null,
    });

    return {
      symbol,
      bids: Array.isArray(data.bids) ? data.bids.map(normalizeLevel) : [],
      asks: Array.isArray(data.asks) ? data.asks.map(normalizeLevel) : [],
      timestamp: data?.metadata?.timestamp || Date.now(),
    };
  }

  /**
   * Real historical candles from Revolut X.
   * Use these closes for RSI/MACD/Bollinger/EMA.
   */
  async getCandles(symbol, {
    interval = '1h',
    limit = 120,
    endDateMs,
    startDateMs,
  } = {}) {
    const dashed = this._toDashedSymbol(symbol);

    const end = endDateMs ?? Date.now();

    // Fallback simple range if caller doesn't provide one.
    // 120 candles of 1h ~= 5 days.
    const start = startDateMs ?? (end - (limit * 60 * 60 * 1000));

    const res = await this.client.get(`/market-data/candles/${dashed}`, {
      interval,
      start_date: start,
      end_date: end,
      limit,
    });

    const candles = Array.isArray(res?.data) ? res.data : [];

    return {
      symbol,
      interval,
      candles: candles.map(c => ({
        timestamp: c.tdt ?? c.timestamp,
        open: this._safeNum(c.o ?? c.open),
        high: this._safeNum(c.h ?? c.high),
        low: this._safeNum(c.l ?? c.low),
        close: this._safeNum(c.c ?? c.close),
        volume: this._safeNum(c.v ?? c.volume),
      })),
    };
  }

  /**
   * Optional: public market trades.
   * Useful for inspection, but indicators should use candles.
   */
  async getPublicTrades(symbol, {
    limit = 200,
    endDateMs,
    startDateMs,
  } = {}) {
    const dashed = this._toDashedSymbol(symbol);
    const end = endDateMs ?? Date.now();
    const start = startDateMs ?? (end - 24 * 60 * 60 * 1000);

    const res = await this.client.get(`/trades/${dashed}`, {
      start_date: start,
      end_date: end,
      limit,
    });

    return {
      symbol,
      trades: Array.isArray(res?.data) ? res.data.map((t, i) => ({
        id: t.id ?? `trade-${i}`,
        price: this._safeNum(t.p ?? t.price),
        size: this._safeNum(t.a ?? t.amount ?? t.size),
        side: t.s ?? null,
        timestamp: t.tdt ?? t.timestamp,
      })) : [],
    };
  }

  async getSnapshot(symbol) {
    const [ticker, orderBook, candles] = await Promise.all([
      this.getTicker(symbol),
      this.getOrderBook(symbol, 10),
      this.getCandles(symbol, { interval: '1h', limit: 120 }),
    ]);

    logger.info(`📊 Snapshot loaded: ${symbol} | candles=${candles.candles.length}`);

    return {
      symbol,
      ticker,
      orderBook,
      candles,
      fetchedAt: new Date().toISOString(),
    };
  }

  async getBalances() {
    return this.client.get('/balances');
  }

  async getOpenOrders(symbols = []) {
    return this.client.get('/orders/active', {
      symbols: symbols.length ? symbols.join(',') : undefined,
    });
  }

  async getTradeHistory(symbol, {
    startDateMs,
    endDateMs,
    limit = 100,
  } = {}) {
    const dashed = this._toDashedSymbol(symbol);
    const end = endDateMs ?? Date.now();
    const start = startDateMs ?? (end - 7 * 24 * 60 * 60 * 1000);

    return this.client.get(`/trades/private/${dashed}`, {
      start_date: start,
      end_date: end,
      limit,
    });
  }
}