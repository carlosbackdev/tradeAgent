/**
 * agent/indicators.js
 * Computes technical indicators from price arrays.
 * Uses the `technicalindicators` library under the hood.
 */

import {
  RSI,
  SMA,
  EMA,
  MACD,
  BollingerBands,
  ADX,
} from 'technicalindicators';

/**
 * Given an array of candle closes (oldest → newest), compute a full
 * indicator suite and return a flat object Claude can reason about.
 */
export function computeIndicators(closes) {
  if (closes.length < 26) {
    return { error: 'Not enough data (need ≥26 closes)' };
  }

  const rsiValues     = RSI.calculate({ values: closes, period: 14 });
  const sma20         = SMA.calculate({ values: closes, period: 20 });
  const ema12         = EMA.calculate({ values: closes, period: 12 });
  const ema26         = EMA.calculate({ values: closes, period: 26 });
  const macdValues    = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const bbValues      = BollingerBands.calculate({
    values: closes,
    period: 20,
    stdDev: 2,
  });

  // Grab the latest value of each series
  const last = (arr) => arr[arr.length - 1];
  const currentPrice = last(closes);
  const macd = last(macdValues) ?? {};
  const bb   = last(bbValues)   ?? {};

  return {
    currentPrice,
    rsi14:          last(rsiValues)?.toFixed(2),
    sma20:          last(sma20)?.toFixed(2),
    ema12:          last(ema12)?.toFixed(2),
    ema26:          last(ema26)?.toFixed(2),

    // MACD
    macdLine:       macd.MACD?.toFixed(4),
    macdSignal:     macd.signal?.toFixed(4),
    macdHistogram:  macd.histogram?.toFixed(4),

    // Bollinger Bands
    bbUpper:        bb.upper?.toFixed(2),
    bbMiddle:       bb.middle?.toFixed(2),
    bbLower:        bb.lower?.toFixed(2),
    bbWidth:        bb.upper && bb.lower
                      ? ((bb.upper - bb.lower) / bb.middle * 100).toFixed(2) + '%'
                      : null,

    // Price position relative to bands
    bbPosition:     bb.upper && bb.lower
                      ? ((currentPrice - bb.lower) / (bb.upper - bb.lower) * 100).toFixed(1) + '%'
                      : null,

    // Simple signals derived from indicators
    signals: deriveSignals({ currentPrice, rsi: last(rsiValues), macd, bb, ema12: last(ema12), ema26: last(ema26) }),
  };
}

function deriveSignals({ currentPrice, rsi, macd, bb, ema12, ema26 }) {
  const signals = [];

  if (rsi !== undefined) {
    if (rsi < 30) signals.push('RSI_OVERSOLD');
    else if (rsi > 70) signals.push('RSI_OVERBOUGHT');
    else if (rsi < 45) signals.push('RSI_BEARISH_ZONE');
    else if (rsi > 55) signals.push('RSI_BULLISH_ZONE');
  }

  if (macd?.MACD !== undefined && macd?.signal !== undefined) {
    if (macd.MACD > macd.signal) signals.push('MACD_BULLISH_CROSS');
    else signals.push('MACD_BEARISH_CROSS');
    if (macd.histogram > 0 && macd.histogram > (macd.prevHistogram ?? 0)) signals.push('MACD_MOMENTUM_INCREASING');
  }

  if (bb?.upper && bb?.lower) {
    if (currentPrice > bb.upper) signals.push('BB_PRICE_ABOVE_UPPER');
    else if (currentPrice < bb.lower) signals.push('BB_PRICE_BELOW_LOWER');
  }

  if (ema12 && ema26) {
    if (ema12 > ema26) signals.push('EMA_GOLDEN_CROSS');
    else signals.push('EMA_DEATH_CROSS');
  }

  return signals;
}

/**
 * Extract close prices from trade history.
 * Handles CoinGecko format: trades array with price tuples [timestamp, price]
 * Handles Revolut format: trades array with { price: "...", ... }
 */
export function closesFromTrades(trades) {
  if (!trades || !Array.isArray(trades)) return [];
  
  return trades.map(t => {
    // CoinGecko: [timestamp, price] tuple
    if (Array.isArray(t)) return parseFloat(t[1]);
    // Revolut: { price: "...", ... } object
    if (t.price) return parseFloat(t.price);
    // Legacy: { p: "..." } object
    if (t.p) return parseFloat(t.p);
    return null;
  }).filter(p => p !== null);
}
