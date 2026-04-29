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
  OBV,
} from 'technicalindicators';

/**
 * Given an array of candle closes (oldest → newest), compute a full
 * indicator suite and return a flat object Model AI can reason about.
 */
export function computeIndicators(closes, candles = null) {
  if (closes.length < 26) {
    return { error: 'Not enough data (need ≥26 closes)' };
  }

  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const sma20 = SMA.calculate({ values: closes, period: 20 });
  const ema12 = EMA.calculate({ values: closes, period: 12 });
  const ema26 = EMA.calculate({ values: closes, period: 26 });
  const macdValues = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const bbValues = BollingerBands.calculate({
    values: closes,
    period: 20,
    stdDev: 2,
  });

  // Helpers to grab latest values
  const last = (arr) => arr[arr.length - 1];
  const secondLast = (arr) => arr[arr.length - 2];

  const currentPrice = last(closes);
  const macd = last(macdValues) ?? {};
  const prevMacd = secondLast(macdValues) ?? {};
  const bb = last(bbValues) ?? {};

  const result = {
    currentPrice,
    rsi14: last(rsiValues)?.toFixed(2),
    sma20: last(sma20)?.toFixed(2),
    ema12: last(ema12)?.toFixed(2),
    ema26: last(ema26)?.toFixed(2),

    // MACD
    macdLine: macd.MACD?.toFixed(4),
    macdSignal: macd.signal?.toFixed(4),
    macdHistogram: macd.histogram?.toFixed(4),

    // Bollinger Bands
    bbUpper: bb.upper?.toFixed(2),
    bbMiddle: bb.middle?.toFixed(2),
    bbLower: bb.lower?.toFixed(2),
    bbWidth: bb.upper && bb.lower
      ? ((bb.upper - bb.lower) / bb.middle * 100).toFixed(2) + '%'
      : null,

    // Price position relative to bands
    bbPosition: bb.upper && bb.lower
      ? ((currentPrice - bb.lower) / (bb.upper - bb.lower) * 100).toFixed(1) + '%'
      : null,

    // Simple signals derived from indicators
    signals: deriveSignals({
      currentPrice,
      rsi: last(rsiValues),
      macd,
      prevMacd,
      bb,
      ema12: last(ema12),
      ema26: last(ema26)
    }),
  };

  // ── Volume context ──
  let volumeContext = null;

  if (Array.isArray(candles) && candles.length >= 20) {
    const volumes = candles.map((c) => Number(c.volume || 0));
    const candleCloses = candles.map((c) => Number(c.close));

    const hasValidVolumes = volumes.some((v) => v > 0);
    const hasValidCloses = candleCloses.every((v) => Number.isFinite(v));

    if (hasValidVolumes && hasValidCloses) {
      const obvValues = OBV.calculate({
        close: candleCloses,
        volume: volumes,
      });

      if (obvValues.length >= 6) {
        const lastObv = obvValues[obvValues.length - 1];
        const prevObv = obvValues[obvValues.length - 6];

        const obvDelta = lastObv - prevObv;
        const obvChangePct = Math.abs(prevObv) > 0
          ? (obvDelta / Math.abs(prevObv)) * 100
          : 0;

        let obvTrend = 'flat';

        if (obvChangePct > 0.5) {
          obvTrend = 'accumulation';
        } else if (obvChangePct < -0.5) {
          obvTrend = 'distribution';
        }

        const recentVols = volumes.slice(-20);
        const avgVol20 = recentVols.reduce((sum, v) => sum + v, 0) / recentVols.length;
        const lastVol = volumes[volumes.length - 1];
        const volRatio = avgVol20 > 0 ? lastVol / avgVol20 : 1;

        const priceTrendUp = candleCloses[candleCloses.length - 1] > candleCloses[candleCloses.length - 6];

        let divergence = 'none';

        if (priceTrendUp && obvTrend === 'distribution') {
          divergence = 'bearish_divergence';
        }

        if (!priceTrendUp && obvTrend === 'accumulation') {
          divergence = 'bullish_divergence';
        }

        volumeContext = {
          obv_trend: obvTrend,
          obv_change_pct: Number(obvChangePct.toFixed(2)),
          volume_ratio: Number(volRatio.toFixed(4)),
          volume_quality: volRatio > 1.5 ? 'high' : volRatio < 0.5 ? 'low' : 'normal',
          price_vol_divergence: divergence,
        };
      }
    }
  }

  result.volumeContext = volumeContext;

  // Compute confluence after signals are derived
  result.confluence = computeConfluence({
    rsi: last(rsiValues),
    macdHistogram: macd.histogram,
    bbPosition: result.bbPosition,
    signals: result.signals
  });

  return result;
}

function deriveSignals({ currentPrice, rsi, macd, prevMacd, bb, ema12, ema26 }) {
  const signals = [];

  if (rsi !== undefined) {
    if (rsi < 30) signals.push('RSI_OVERSOLD');
    else if (rsi > 70) signals.push('RSI_OVERBOUGHT');
    else if (rsi < 45) signals.push('RSI_BEARISH_ZONE');
    else if (rsi > 55) signals.push('RSI_BULLISH_ZONE');
  }

  if (
    Number.isFinite(macd?.MACD) &&
    Number.isFinite(macd?.signal) &&
    Number.isFinite(prevMacd?.MACD) &&
    Number.isFinite(prevMacd?.signal)
  ) {
    if (prevMacd.MACD <= prevMacd.signal && macd.MACD > macd.signal) {
      signals.push('MACD_BULLISH_CROSS');
    } else if (prevMacd.MACD >= prevMacd.signal && macd.MACD < macd.signal) {
      signals.push('MACD_BEARISH_CROSS');
    } else if (macd.MACD > macd.signal) {
      signals.push('MACD_BULLISH_BIAS');
    } else {
      signals.push('MACD_BEARISH_BIAS');
    }

    if (Number.isFinite(macd.histogram) && Number.isFinite(prevMacd.histogram)) {
      if (macd.histogram > prevMacd.histogram) {
        signals.push('MACD_MOMENTUM_INCREASING');
      } else {
        signals.push('MACD_MOMENTUM_DECREASING');
      }
    }
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
 * Compute an objective confluence signal from the raw indicators.
 * Returns bullish/bearish counts and a concrete suggestion for Model AI.
 */
function computeConfluence({ rsi, macdHistogram, bbPosition, signals }) {
  const bullish = [];
  const bearish = [];

  // RSI
  if (rsi !== undefined) {
    if (rsi < 35) bullish.push('RSI_oversold');
    else if (rsi > 65) bearish.push('RSI_overbought');
  }

  // MACD histogram direction
  if (macdHistogram !== undefined) {
    if (macdHistogram > 0) bullish.push('MACD_bullish_histogram');
    else bearish.push('MACD_bearish_histogram');
  }

  // EMA cross
  if (signals.includes('EMA_GOLDEN_CROSS')) bullish.push('EMA_golden_cross');
  if (signals.includes('EMA_DEATH_CROSS')) bearish.push('EMA_death_cross');

  // MACD cross & bias
  if (signals.includes('MACD_BULLISH_CROSS')) bullish.push('MACD_bullish_cross');
  if (signals.includes('MACD_BEARISH_CROSS')) bearish.push('MACD_bearish_cross');
  if (signals.includes('MACD_BULLISH_BIAS')) bullish.push('MACD_bullish_bias');
  if (signals.includes('MACD_BEARISH_BIAS')) bearish.push('MACD_bearish_bias');

  // Bollinger Band position (numeric, strip '%')
  const bbPct = parseFloat(bbPosition);
  if (!isNaN(bbPct)) {
    if (bbPct < 20) bullish.push('BB_oversold_zone');
    else if (bbPct > 80) bearish.push('BB_overbought_zone');
  }

  // BB price breakout signals
  if (signals.includes('BB_PRICE_BELOW_LOWER')) bullish.push('BB_price_below_lower');
  if (signals.includes('BB_PRICE_ABOVE_UPPER')) bearish.push('BB_price_above_upper');

  const suggestion =
    bullish.length >= 2 && bullish.length > bearish.length ? 'BUY_SIGNAL'
      : bearish.length >= 2 && bearish.length > bullish.length ? 'SELL_SIGNAL'
        : 'NEUTRAL';

  return {
    bullishCount: bullish.length,
    bearishCount: bearish.length,
    bullishSignals: bullish,
    bearishSignals: bearish,
    suggestion,
  };
}

/**
 * Extract close prices from trade history.
 */
export function closesFromTrades(trades) {
  if (!trades || !Array.isArray(trades)) return [];

  return trades.map(t => {
    if (Array.isArray(t)) return parseFloat(t[1]);
    if (t.price) return parseFloat(t.price);
    if (t.p) return parseFloat(t.p);
    return null;
  }).filter(p => p !== null);
}

export function closesFromCandles(candlesArray = []) {
  return candlesArray
    .map(c => Number(c.close))
    .filter(n => Number.isFinite(n));
}

/**
 * Computa un score de confluencia cruzada entre TF base y TF superior.
 * Retorna { score, gate, signals, conflicts, reason }
 *
 * gate = true  → señal tiene alineación TF → vale la pena considerar
 * gate = false → TFs contradictorios → preferir HOLD
 */
export function computeCrossTfConfluence(baseTfIndicators, higherTfIndicators) {
  if (!baseTfIndicators || !higherTfIndicators) {
    return {
      score: 0,
      gate: false,
      signals: [],
      conflicts: ['Missing TF data'],
      reason: 'Missing TF data',
    };
  }

  const signals = [];
  const conflicts = [];

  const toNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  const getMacdHistogram = (tf) => {
    return toNumber(
      tf?.macdHistogram ??
      tf?.macd?.histogram ??
      tf?.aliases?.macdHistogram
    );
  };

  const getRsi = (tf) => {
    return toNumber(
      tf?.rsi14 ??
      tf?.rsi ??
      tf?.aliases?.rsi14
    );
  };

  const getSignalList = (tf) => {
    return [
      ...(tf?.signals || []),
      ...(tf?.confluence?.bullishSignals || []),
      ...(tf?.confluence?.bearishSignals || []),
    ];
  };

  const getEmaDirection = (tf) => {
    const ema12 = toNumber(tf?.ema12 ?? tf?.aliases?.ema12);
    const ema26 = toNumber(tf?.ema26 ?? tf?.aliases?.ema26);
    if (ema12 !== null && ema26 !== null) {
      return ema12 > ema26 ? 'bullish' : 'bearish';
    }
    const signalList = getSignalList(tf);
    if (
      signalList.includes('EMA_golden_cross') ||
      signalList.includes('EMA_GOLDEN_CROSS')
    ) {
      return 'bullish';
    }
    if (
      signalList.includes('EMA_death_cross') ||
      signalList.includes('EMA_DEATH_CROSS')
    ) {
      return 'bearish';
    }
    return null;
  };

  const getMacdDirection = (tf) => {
    const histogram = getMacdHistogram(tf);
    if (histogram !== null) {
      return histogram > 0 ? 'bullish' : 'bearish';
    }
    const signalList = getSignalList(tf);
    if (
      signalList.includes('MACD_bearish_histogram') ||
      signalList.includes('MACD_BEARISH_CROSS') ||
      signalList.includes('MACD_bearish_cross') ||
      signalList.includes('MACD_BEARISH_BIAS') ||
      signalList.includes('MACD_bearish_bias')
    ) {
      return 'bearish';
    }
    if (
      signalList.includes('MACD_bullish_histogram') ||
      signalList.includes('MACD_BULLISH_CROSS') ||
      signalList.includes('MACD_bullish_cross') ||
      signalList.includes('MACD_BULLISH_BIAS') ||
      signalList.includes('MACD_bullish_bias')
    ) {
      return 'bullish';
    }
    return null;
  };

  const baseEmaDirection = getEmaDirection(baseTfIndicators);
  const higherEmaDirection = getEmaDirection(higherTfIndicators);

  if (baseEmaDirection && higherEmaDirection) {
    if (baseEmaDirection === higherEmaDirection) {
      signals.push(`EMA_aligned_${baseEmaDirection}`);
    } else {
      conflicts.push('EMA_direction_conflict');
    }
  }

  const baseMacdDirection = getMacdDirection(baseTfIndicators);
  const higherMacdDirection = getMacdDirection(higherTfIndicators);

  if (baseMacdDirection && higherMacdDirection) {
    if (baseMacdDirection === higherMacdDirection) {
      signals.push(`MACD_aligned_${baseMacdDirection}`);
    } else {
      conflicts.push('MACD_direction_conflict');
    }
  }

  const baseRsi = getRsi(baseTfIndicators);
  const higherRsi = getRsi(higherTfIndicators);

  if (baseRsi !== null && higherRsi !== null) {
    if ((baseRsi < 35 && higherRsi > 65) || (baseRsi > 65 && higherRsi < 35)) {
      conflicts.push('RSI_extreme_divergence');
    } else {
      signals.push('RSI_zones_compatible');
    }
  }

  const baseSuggestion = baseTfIndicators?.confluence?.suggestion;
  const higherSuggestion = higherTfIndicators?.confluence?.suggestion;

  if (baseSuggestion && higherSuggestion && baseSuggestion === higherSuggestion) {
    signals.push(`confluence_aligned_${baseSuggestion}`);
  } else if (
    baseSuggestion &&
    higherSuggestion &&
    baseSuggestion !== 'NEUTRAL' &&
    higherSuggestion !== 'NEUTRAL' &&
    baseSuggestion !== higherSuggestion
  ) {
    conflicts.push('confluence_suggestion_conflict');
  }

  const score = signals.length - conflicts.length;
  const hardConflict = conflicts.some((c) =>
    c.includes('EMA') || c.includes('MACD')
  );
  const gate = score >= 1 && !hardConflict;

  let entryMode = "blocked";
  let reason = gate
    ? `${signals.length} señales alineadas entre TFs`
    : `Conflicto multi-TF: ${conflicts.length ? conflicts.join(', ') : 'insufficient alignment'}`;

  if (gate) {
    entryMode = "normal_allowed";
  } else {
    const baseSuggestion = baseTfIndicators?.confluence?.suggestion;
    const baseMacdImproving = baseTfIndicators?.signals?.includes('MACD_MOMENTUM_INCREASING') || baseMacdDirection === 'bullish';
    const baseRsiVal = getRsi(baseTfIndicators);
    const baseVolDiv = baseTfIndicators?.volumeContext?.price_vol_divergence;

    const higherTfBearishCount = higherTfIndicators?.confluence?.bearishCount || 0;
    const higherTfBullishCount = higherTfIndicators?.confluence?.bullishCount || 0;
    const higherSuggestion = higherTfIndicators?.confluence?.suggestion;

    let htfRegime = "mixed_htf";
    if (higherTfBearishCount >= higherTfBullishCount + 2 || (higherSuggestion === 'SELL_SIGNAL' && higherMacdDirection === 'bearish' && higherEmaDirection === 'bearish')) {
      htfRegime = "strong_bearish_htf";
    } else if (higherMacdDirection === 'bullish' && higherEmaDirection === 'bearish') {
      htfRegime = "improving_htf";
    } else if (higherSuggestion === 'BUY_SIGNAL' || higherTfBullishCount >= higherTfBearishCount + 2) {
      htfRegime = "strong_bullish_htf";
    }

    if (
      baseSuggestion === 'BUY_SIGNAL' &&
      baseEmaDirection === 'bullish' &&
      baseMacdImproving &&
      htfRegime !== 'strong_bearish_htf' &&
      baseRsiVal !== null && baseRsiVal < 70 &&
      baseVolDiv !== 'bearish_divergence'
    ) {
      entryMode = "starter_allowed";
      reason = `Base TF bullish but HTF lagging (${htfRegime}); starter BUY allowed with reduced size`;
    }
  }

  return {
    score,
    gate,
    entryMode,
    entryMode,
    signals,
    conflicts,
    reason,
    reason,
  };
}