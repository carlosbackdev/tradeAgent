/**
 * revolut/market.js
 * Real market data from Revolut X.
 */

import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';

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
   * Get ticker data.
   * Ticker symbols are documented like BTC/USD. :contentReference[oaicite:2]{index=2}
   */
  async getTicker(symbol) {
    const dashed = this._toDashedSymbol(symbol);

    const res = await this.client.get('/tickers', {
      symbols: dashed,
    });

    const item =
      res?.data?.find?.(t => t.symbol === dashed || t.symbol === symbol) ||
      res?.data?.[0];

    logger.debug(`Ticker ${symbol}: ${JSON.stringify(item)}`);

    if (!item) {
      throw new Error(`No ticker returned for ${symbol}`);
    }

    return {
      symbol,
      bid: this._safeNum(item.bid),
      ask: this._safeNum(item.ask),
      mid: this._safeNum(item.mid),
      last: this._safeNum(item.last_price),
      timestamp: res?.metadata?.timestamp || Date.now(),
    };
  }

  /**
   * Authenticated order book snapshot.
   * Your docs show /order-book/{symbol}
   */
  async getOrderBook(symbol, depth = 10) {
    const dashed = this._toDashedSymbol(symbol);
    const limit = Math.min(Math.max(depth, 1), 20);

    const res = await this.client.get(`/order-book/${dashed}`, { limit });
    const data = res?.data;

    if (!data) {
      throw new Error(`No order book returned for ${symbol}`);
    }

    const normalizeLevel = (level) => ({
      price: this._safeNum(level.p ?? level.price),
      size: this._safeNum(level.q ?? level.size),
      side: level.s ?? null,
      assetId: level.aid ?? null,
      assetName: level.anm ?? null,
      venue: level.ve ?? null,
      orders: this._safeNum(level.no ?? 0),
      timestamp: level.pdt ?? null,
    });

    return {
      symbol,
      bids: Array.isArray(data.bids) ? data.bids.map(normalizeLevel) : [],
      asks: Array.isArray(data.asks) ? data.asks.map(normalizeLevel) : [],
      timestamp: res?.metadata?.timestamp || Date.now(),
    };
  }

  /**
   * Historical OHLCV candles.
   * Your docs show /candles/{symbol} with params: interval, from, to
   */
  async getCandles(symbol, {
    interval = 5,
    fromMs,
    toMs,
  } = {}) {
    const dashed = this._toDashedSymbol(symbol);
    logger.info(`Fetching candles for ${symbol} | interval=${interval}`);

    const to = toMs ?? Date.now();
    const from = fromMs ?? (to - (500 * interval * 60 * 1000));

    const res = await this.client.get(`/candles/${dashed}`, {
      interval,
      since: from,
      until: to,
    });

    const candles = Array.isArray(res?.data) ? res.data : [];

    return {
      symbol,
      interval,
      candles: candles.map(c => ({
        timestamp: c.start,
        open: this._safeNum(c.open),
        high: this._safeNum(c.high),
        low: this._safeNum(c.low),
        close: this._safeNum(c.close),
        volume: this._safeNum(c.volume),
      })),
    };
  }

  /**
   * Public last trades.
   * Your docs show /public/last-trades without symbol in path.
   * Filter locally by pair if needed.
   */
  async getPublicTrades(symbol = null) {
    const res = await this.client.get('/public/last-trades');
    const trades = Array.isArray(res?.data) ? res.data : [];

    const filtered = symbol
      ? trades.filter(t => {
        const pair = `${t.aid}/${t.pc}`;
        return pair === symbol;
      })
      : trades;

    return {
      symbol,
      trades: filtered.map((t, i) => ({
        id: t.tid ?? `trade-${i}`,
        price: this._safeNum(t.p),
        size: this._safeNum(t.q),
        base: t.aid ?? null,
        quote: t.pc ?? null,
        side: null,
        timestamp: t.tdt ?? t.pdt ?? null,
      })),
      timestamp: res?.metadata?.timestamp || null,
    };
  }

  async getSnapshot(symbol) {
    const [ticker, orderBook, candles] = await Promise.all([
      this.getTicker(symbol),
      this.getOrderBook(symbol, 10),
      this.getCandles(symbol, { interval: this.client.config?.indicators?.candlesInterval || 5 }),
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
    const params = {};
    if (symbols && symbols.length > 0) {
      const dashedSymbols = symbols.map(symbol => this._toDashedSymbol(symbol));
      params.symbols = dashedSymbols.join(',');
    }
    return this.client.get('/orders/active', params);
  }

  async getTradeHistory(symbol, { fromMs, toMs, limit = 100 } = {}) {
    const dashed = this._toDashedSymbol(symbol);
    const to = toMs ?? Date.now();
    const from = fromMs ?? (to - 7 * 24 * 60 * 60 * 1000);

    return this.client.get(`/trades/${dashed}`, {
      from,
      to,
      limit,
    });
  }
}