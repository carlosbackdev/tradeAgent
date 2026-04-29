/**
 * workflow/risk/risk-policy.js
 * Pure risk policy helpers for sell normalization and blocking rules.
 */

const STRONG_RISK_FACTOR_SET = new Set([
  'cross_tf_conflict',
  'higher_tf_sell',
  'price_below_ema12',
  'price_below_ema26',
  'macd_weak_or_negative',
  'base_tf_sell_signal',
  'bearish_volume_divergence',
  'momentum_fading',
  'bearish_price_pattern'
]);

const BEARISH_PATTERNS = new Set(['potential_reversal_down', 'three_consecutive_red']);

export function buildRiskProfile({
  crossTf,
  higherTf,
  indicators,
  priceNarrative,
  cryptoPercentage
}) {
  const list = [];
  const higherTfBearishCount = toNumber(higherTf?.bearishCount, 0);
  const higherTfBullishCount = toNumber(higherTf?.bullishCount, 0);

  const crossTfConflict = crossTf?.gate === false;
  const higherTfSell = higherTf?.suggestion === 'SELL_SIGNAL' || higherTfBearishCount > higherTfBullishCount;
  const priceBelowEma12 = toNumber(indicators?.currentPrice, 0) > 0 && toNumber(indicators?.ema12, 0) > 0
    ? Number(indicators.currentPrice) < Number(indicators.ema12)
    : false;
  const priceBelowEma26 = toNumber(indicators?.currentPrice, 0) > 0 && toNumber(indicators?.ema26, 0) > 0
    ? Number(indicators.currentPrice) < Number(indicators.ema26)
    : false;
  const macdWeak = resolveMacdHistogram(indicators) < 0;
  const baseTfSellSignal = indicators?.confluence?.suggestion === 'SELL_SIGNAL';
  const lowVolume = indicators?.volumeContext?.volume_quality === 'low';
  const bearishVolumeDivergence = indicators?.volumeContext?.price_vol_divergence === 'bearish_divergence';
  const momentumFading = toNumber(priceNarrative?.momentumShiftPct, 0) < 0;
  const bearishPattern = BEARISH_PATTERNS.has(String(priceNarrative?.detectedPattern || ''));
  const highCryptoExposure = Number(cryptoPercentage || 0) > 70;

  if (crossTfConflict) list.push('cross_tf_conflict');
  if (higherTfSell) list.push('higher_tf_sell');
  if (priceBelowEma12) list.push('price_below_ema12');
  if (priceBelowEma26) list.push('price_below_ema26');
  if (macdWeak) list.push('macd_weak_or_negative');
  if (baseTfSellSignal) list.push('base_tf_sell_signal');
  if (lowVolume) list.push('low_volume');
  if (bearishVolumeDivergence) list.push('bearish_volume_divergence');
  if (momentumFading) list.push('momentum_fading');
  if (bearishPattern) list.push('bearish_price_pattern');
  if (highCryptoExposure) list.push('high_crypto_exposure');

  const strongInvalidation = list.length >= 4 &&
    (higherTfSell || crossTfConflict) &&
    (priceBelowEma12 || macdWeak);

  return {
    list,
    higherTfSell,
    baseTfSell: baseTfSellSignal,
    crossTfConflict,
    priceBelowEma12,
    macdWeak,
    strongInvalidation
  };
}

export function shouldAllowHardStop({ currentRoi, stopLossPct }) {
  const roi = toNumber(currentRoi, null);
  const stopLoss = Math.abs(toNumber(stopLossPct, 0));
  if (roi === null || stopLoss <= 0) return false;
  return roi <= -stopLoss;
}

export function getStrongRiskFactors(riskFactors = []) {
  return (Array.isArray(riskFactors) ? riskFactors : [])
    .filter((factor) => STRONG_RISK_FACTOR_SET.has(String(factor || '').toLowerCase()));
}

export function isExtremeInvalidation({
  currentRoi,
  riskFactors = [],
  higherTfSell = false,
  baseTfSell = false,
  moveSignificance = null
}) {
  const roi = currentRoi === null ? -1.5 : toNumber(currentRoi, 0);
  const strongFactorsCount = getStrongRiskFactors(riskFactors).length;
  const significantMove = moveSignificance === 'large' || moveSignificance === 'strong_move';

  return Boolean(
    roi <= -1.5 &&
    strongFactorsCount >= 5 &&
    higherTfSell === true &&
    baseTfSell === true &&
    significantMove
  );
}

export function shouldBlockRecentSell({
  isRecentBuy = false,
  hardStopAllowed = false,
  extremeInvalidation = false,
  forced = false
}) {
  if (forced) return false;
  if (!isRecentBuy) return false;
  return !(hardStopAllowed || extremeInvalidation);
}

export function shouldAllowDefensiveSell({
  riskFacts,
  currentRoi,
  maxRoiSeen,
  isRecentBuy
}) {
  const roi = toNumber(currentRoi, 0);
  const maxRoi = toNumber(maxRoiSeen, roi);
  const riskList = Array.isArray(riskFacts?.list) ? riskFacts.list : [];
  const strongInvalidation = riskFacts?.strongInvalidation === true;
  const extremeInvalidation = riskFacts?.extremeInvalidation === true;
  const higherTfSell = riskFacts?.higherTfSell === true;
  const baseTfSell = riskFacts?.baseTfSell === true;

  if (isRecentBuy) {
    if (extremeInvalidation) {
      return buildSellCandidate({
        minPct: 80,
        maxPct: 100,
        confidenceMin: 78,
        confidenceMax: 88,
        reason: 'EXTREME_INVALIDATION',
        phase: 'THESIS_INVALIDATION'
      });
    }
    return null;
  }

  if (strongInvalidation) {
    return buildSellCandidate({
      minPct: 80,
      maxPct: 100,
      confidenceMin: 78,
      confidenceMax: 88,
      reason: 'THESIS_INVALIDATION',
      phase: 'THESIS_INVALIDATION'
    });
  }

  if (maxRoi >= 2.0 && roi <= 0) {
    return buildSellCandidate({
      minPct: 70,
      maxPct: 100,
      confidenceMin: 78,
      confidenceMax: 88,
      reason: 'PROFIT_TO_LOSS_PREVENTION',
      phase: 'PROFIT_RETRACEMENT'
    });
  }

  if (maxRoi >= 2.0 && roi <= 0.7) {
    return buildSellCandidate({
      minPct: 50,
      maxPct: 70,
      confidenceMin: 72,
      confidenceMax: 82,
      reason: 'PROFIT_RETRACEMENT',
      phase: 'PROFIT_RETRACEMENT'
    });
  }

  if (roi >= 1.2 && riskList.length >= 2) {
    return buildSellCandidate({
      minPct: 25,
      maxPct: 35,
      confidenceMin: 62,
      confidenceMax: 70,
      reason: 'PROFIT_PROTECTION',
      phase: 'PROTECTING_PROFIT'
    });
  }

  if (roi <= 0 && roi > -1.0 && riskList.length >= 4 && baseTfSell) {
    return buildSellCandidate({
      minPct: 20,
      maxPct: 35,
      confidenceMin: 68,
      confidenceMax: 78,
      reason: 'EARLY_DRAWDOWN_REDUCTION',
      phase: 'IN_DRAWDOWN'
    });
  }

  if (roi <= -1.0 && roi > -1.8 && riskList.length >= 3 && (higherTfSell || baseTfSell)) {
    return buildSellCandidate({
      minPct: 25,
      maxPct: 50,
      confidenceMin: 65,
      confidenceMax: 75,
      reason: 'PRE_STOP_LOSS_RISK_REDUCTION',
      phase: 'IN_DRAWDOWN'
    });
  }

  return null;
}

export function capSellPct(positionPct, { minPct = 0, maxPct = 100, defaultPct = null } = {}) {
  const pct = normalizeSellRisk(positionPct);
  if (pct <= 0) {
    return defaultPct === null ? pct : normalizeSellRisk(defaultPct);
  }
  return clamp(pct, normalizeSellRisk(minPct), normalizeSellRisk(maxPct));
}

export function normalizeSellRisk(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= 1) return n * 100;
  return n;
}

function buildSellCandidate({
  minPct,
  maxPct,
  confidenceMin,
  confidenceMax,
  reason,
  phase
}) {
  return {
    positionPctMin: minPct,
    positionPctMax: maxPct,
    confidenceMin,
    confidenceMax,
    defensiveReason: reason,
    lifecyclePhase: phase
  };
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function resolveMacdHistogram(indicators) {
  const n1 = Number(indicators?.macdHistogram);
  if (Number.isFinite(n1)) return n1;
  const n2 = Number(indicators?.macd?.histogram);
  return Number.isFinite(n2) ? n2 : null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
