/**
 * workflow/portfolio-manager.js
 * Risk supervision layer on top of LLM decisions.
 */

import { logger } from '../../utils/logger.js';

const BEARISH_PATTERNS = new Set(['potential_reversal_down', 'three_consecutive_red']);

const RISK_FACTOR_LABELS = {
  cross_tf_conflict: 'conflicto en confluencia multi-timeframe (Cross-TF gate=false)',
  higher_tf_sell: 'sesgo bajista en timeframe superior',
  price_below_ema12: 'precio por debajo de EMA12',
  price_below_ema26: 'precio por debajo de EMA26',
  macd_weak_or_negative: 'MACD debil o histograma negativo',
  base_tf_sell_signal: 'senal SELL en timeframe base',
  low_volume: 'volumen de baja calidad',
  bearish_volume_divergence: 'divergencia bajista precio-volumen',
  momentum_fading: 'momentum debilitandose',
  bearish_price_pattern: 'patron de precio bajista',
  high_crypto_exposure: 'exposicion crypto alta'
};

export function applyPortfolioManagerDecision({
  decision,
  symbol,
  analyzerContext,
  positionSummary,
  lifecycleState,
  config
}) {
  if (!decision || typeof decision !== 'object') return decision;
  if (decision.forced === true) return decision;

  const normalizedSymbol = normalizeSymbol(symbol || decision.symbol);
  const indicators = analyzerContext?.indicators?.[normalizedSymbol] || {};
  const pairCtx = (analyzerContext?.pairs || []).find((p) => normalizeSymbol(p.symbol) === normalizedSymbol) || null;
  const priceNarrative = pairCtx?.recentClosesContext?.last30?.priceNarrative || null;
  const crossTf = analyzerContext?.crossTfConfluence?.[normalizedSymbol] || null;
  const higherTf = analyzerContext?.higherTimeframe?.confluence || null;
  const regimeSummary = pairCtx?.regimeSummary || null;
  const atrContext = pairCtx?.atr || null;

  const cryptoPercentage = Number(analyzerContext?.balances?.summary?.cryptoPercentage || 0);
  const minOrderUsd = Number(config?.trading?.minOrderUsd || 0);

  const lifecycle = lifecycleState || analyzerContext?.positionLifecycle?.[normalizedSymbol] || {};
  const currentPrice = toNumber(indicators?.currentPrice, toNumber(lifecycle?.current_price, 0));
  const totalQty = toNumber(
    positionSummary?.totalOpenQty,
    toNumber(positionSummary?.totalQty, toNumber(lifecycle?.total_qty, 0))
  );
  const estimatedUsdValue = Number((Math.max(0, totalQty) * Math.max(0, currentPrice)).toFixed(2));
  const hasOpenPosition = totalQty > 0;

  const currentRoi = toNumber(
    lifecycle?.current_roi_pct,
    toNumber(positionSummary?.unrealizedRoiPct, toNumber(decision.currentRoi, 0))
  );
  const maxRoiSeen = toNumber(
    lifecycle?.max_unrealized_roi_pct,
    toNumber(decision.maxRoiSeen, currentRoi)
  );
  const profitRetracementPct = Number((maxRoiSeen - currentRoi).toFixed(4));

  const lifecyclePhase = lifecycle?.phase || (hasOpenPosition ? 'IN_POSITION' : 'NO_POSITION');

  const cooldownUntil = lifecycle?.cooldown_until ? new Date(lifecycle.cooldown_until) : null;
  const cooldownActive = isFutureDate(cooldownUntil);
  const recentDefensiveSell = isRecentDate(lifecycle?.last_defensive_sell_at, 6);
  const recentBuyCooldownActive = hasRecentBuyCooldownFromHistory(
    analyzerContext?.previousDecisions,
    normalizedSymbol,
    6
  );

  const decisionAction = String(decision.action || 'HOLD').toUpperCase();
  const decisionConfidence = toNumber(decision.confidence, 0);
  const decisionPct = normalizePct(decision.positionPct);

  const riskFacts = buildRiskFactors({
    crossTf,
    higherTf,
    indicators,
    priceNarrative,
    cryptoPercentage
  });

  const contextFacts = {
    symbol: normalizedSymbol,
    lifecyclePhase,
    currentRoi,
    maxRoiSeen,
    profitRetracementPct,
    currentPrice,
    estimatedUsdValue,
    minOrderUsd,
    totalQty,
    crossTf,
    indicators,
    regimeSummary,
    atrContext,
    priceNarrative,
    priceChangeSinceLastAnalysisPct: toNumber(analyzerContext?.priceChangeSinceLastAnalysisPct, null),
    riskFactors: riskFacts.list,
    cooldownActive,
    cooldownUntil,
    recentDefensiveSell,
    strongInvalidation: riskFacts.strongInvalidation,
    higherTfSell: riskFacts.higherTfSell
  };

  if (decisionAction === 'BUY' && recentBuyCooldownActive) {
    return annotateDecision(buildHoldOverride(decision, {
      summary: 'HOLD por cooldown tras BUY reciente',
      reasoning: buildHoldCooldownReasoning(contextFacts, 'buy_recent_cooldown')
    }), contextFacts);
  }

  if (!hasOpenPosition) {
    if (decisionAction === 'BUY') {
      if (crossTf?.gate === false) {
        return annotateDecision(buildHoldOverride(decision, {
          summary: 'HOLD: BUY bloqueado por Cross-TF',
          reasoning: buildHoldNoPositionReasoning(contextFacts, 'cross_tf_block')
        }), contextFacts);
      }
      if (cooldownActive) {
        return annotateDecision(buildHoldOverride(decision, {
          summary: 'HOLD por cooldown activo',
          reasoning: buildHoldCooldownReasoning(contextFacts, 'cooldown_active')
        }), contextFacts);
      }
      if (cryptoPercentage > 80 && (decisionConfidence < 80 || crossTf?.gate !== true)) {
        return annotateDecision(buildHoldOverride(decision, {
          summary: 'HOLD por sobreexposicion crypto',
          reasoning: buildHoldNoPositionReasoning(contextFacts, 'high_exposure')
        }), contextFacts);
      }
    }

    return annotateDecision(decision, contextFacts);
  }

  const belowMinOrder = minOrderUsd > 0 && estimatedUsdValue > 0 && estimatedUsdValue < minOrderUsd;
  if (belowMinOrder) {
    return annotateDecision(buildHoldOverride(decision, {
      summary: 'HOLD: posicion residual por debajo del minimo operable',
      reasoning: buildResidualHoldReasoning(contextFacts)
    }), contextFacts);
  }

  const defensiveCandidate = getDefensiveSellCandidate({
    riskFacts,
    currentRoi,
    maxRoiSeen,
    lifecyclePhase
  });

  if ((cooldownActive || recentDefensiveSell) && !isExceptionalSellDuringCooldown(contextFacts, riskFacts)) {
    return annotateDecision(buildHoldOverride(decision, {
      summary: 'HOLD: cooldown defensivo activo',
      reasoning: buildHoldCooldownReasoning(contextFacts, 'defensive_cooldown')
    }), contextFacts);
  }

  if (decisionAction === 'SELL' && defensiveCandidate) {
    if (riskFacts.strongInvalidation && decisionPct < 80) {
      const upgraded = buildDefensiveSell(decision, defensiveCandidate, contextFacts, {
        minPct: 80,
        maxPct: 100
      });
      return annotateDecision(upgraded, contextFacts);
    }

    if (decisionConfidence >= defensiveCandidate.confidenceMin) {
      const normalizedExistingSell = normalizeSellForDust(decision, contextFacts);
      return annotateDecision(normalizedExistingSell, contextFacts);
    }
  }

  if (defensiveCandidate) {
    if (decisionAction === 'HOLD') {
      const overridden = buildDefensiveSell(decision, defensiveCandidate, contextFacts);
      return annotateDecision(overridden, contextFacts);
    }

    if (decisionAction === 'BUY' && riskFacts.list.length >= 3) {
      const overridden = buildDefensiveSell(decision, defensiveCandidate, contextFacts);
      return annotateDecision(overridden, contextFacts);
    }
  }

  if (decisionAction === 'BUY' && riskFacts.list.length >= 3) {
    return annotateDecision(buildHoldOverride(decision, {
      summary: 'HOLD: BUY bloqueado por riesgo elevado',
      reasoning: buildHoldRiskReasoning(contextFacts)
    }), contextFacts);
  }

  if (decisionAction === 'SELL') {
    const normalizedExistingSell = normalizeSellForDust(decision, contextFacts);
    return annotateDecision(normalizedExistingSell, contextFacts);
  }

  return annotateDecision(decision, contextFacts);
}

function hasRecentBuyCooldownFromHistory(previousDecisionsBySymbol, symbol, hoursWindow) {
  const history = previousDecisionsBySymbol?.[symbol] || [];
  if (!Array.isArray(history) || history.length === 0) return false;

  const lastBuy = history.find((d) => String(d.action || '').toUpperCase() === 'BUY');
  if (!lastBuy?.timestamp) return false;

  const createdAt = new Date(lastBuy.timestamp);
  if (!Number.isFinite(createdAt.getTime())) return false;

  const ageMs = Date.now() - createdAt.getTime();
  return ageMs >= 0 && ageMs < (Number(hoursWindow) || 6) * 60 * 60 * 1000;
}

function buildRiskFactors({ crossTf, higherTf, indicators, priceNarrative, cryptoPercentage }) {
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
  const highCryptoExposure = cryptoPercentage > 70;

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

  return {
    list,
    higherTfSell,
    crossTfConflict,
    priceBelowEma12,
    macdWeak,
    strongInvalidation:
      list.length >= 4 &&
      (higherTfSell || crossTfConflict) &&
      (priceBelowEma12 || macdWeak)
  };
}

function getDefensiveSellCandidate({ riskFacts, currentRoi, maxRoiSeen, lifecyclePhase }) {
  if (riskFacts.strongInvalidation) {
    return {
      positionPctMin: 80,
      positionPctMax: 100,
      confidenceMin: 78,
      confidenceMax: 88,
      defensiveReason: 'THESIS_INVALIDATION',
      lifecyclePhase: 'THESIS_INVALIDATION'
    };
  }

  if (maxRoiSeen >= 2.0 && currentRoi <= 0) {
    return {
      positionPctMin: 70,
      positionPctMax: 100,
      confidenceMin: 78,
      confidenceMax: 88,
      defensiveReason: 'PROFIT_TO_LOSS_PREVENTION',
      lifecyclePhase: 'PROFIT_RETRACEMENT'
    };
  }

  if (maxRoiSeen >= 2.0 && currentRoi <= 0.7) {
    return {
      positionPctMin: 50,
      positionPctMax: 70,
      confidenceMin: 72,
      confidenceMax: 82,
      defensiveReason: 'PROFIT_RETRACEMENT',
      lifecyclePhase: 'PROFIT_RETRACEMENT'
    };
  }

  if (currentRoi >= 1.2 && riskFacts.list.length >= 2) {
    return {
      positionPctMin: 25,
      positionPctMax: 35,
      confidenceMin: 62,
      confidenceMax: 70,
      defensiveReason: 'PROFIT_PROTECTION',
      lifecyclePhase: 'PROTECTING_PROFIT'
    };
  }

  if (currentRoi > -1.8 && currentRoi < 0.5 && riskFacts.list.length >= 3) {
    return {
      positionPctMin: 30,
      positionPctMax: 50,
      confidenceMin: 62,
      confidenceMax: 72,
      defensiveReason: 'PRE_STOP_LOSS_RISK_REDUCTION',
      lifecyclePhase: lifecyclePhase || 'IN_DRAWDOWN'
    };
  }

  return null;
}

function buildDefensiveSell(originalDecision, candidate, contextFacts, forceRange = null) {
  const minPct = forceRange?.minPct ?? candidate.positionPctMin;
  const maxPct = forceRange?.maxPct ?? candidate.positionPctMax;
  const targetPct = Math.round((minPct + maxPct) / 2);
  const targetConfidence = Math.round((candidate.confidenceMin + candidate.confidenceMax) / 2);

  let next = {
    ...originalDecision,
    action: 'SELL',
    orderType: originalDecision.orderType || 'market',
    limitPrice: originalDecision.limitPrice || null,
    positionPct: targetPct,
    confidence: Math.max(toNumber(originalDecision.confidence, 0), targetConfidence),
    defensive: true,
    defensiveReason: candidate.defensiveReason,
    lifecyclePhase: candidate.lifecyclePhase,
  };

  next = normalizeSellForDust(next, contextFacts);

  return {
    ...next,
    reasoning: buildDefensiveReasoning(next, contextFacts),
    summaryReasoning: buildDefensiveSummary(candidate.defensiveReason, next.positionPct)
  };
}

function normalizeSellForDust(decision, contextFacts) {
  const minOrderUsd = toNumber(contextFacts?.minOrderUsd, 0);
  const estimatedUsdValue = toNumber(contextFacts?.estimatedUsdValue, 0);

  if (String(decision?.action || '').toUpperCase() !== 'SELL') return decision;
  if (minOrderUsd <= 0 || estimatedUsdValue <= 0) return decision;

  const pct = normalizePct(decision.positionPct);
  if (pct <= 0) return decision;

  const remainingUsd = estimatedUsdValue * (1 - (pct / 100));
  if (remainingUsd > 0 && remainingUsd < minOrderUsd) {
    return {
      ...decision,
      positionPct: 100,
      summaryReasoning: 'SELL completo para evitar remanente no operable'
    };
  }

  return decision;
}

function buildDefensiveReasoning(decision, contextFacts) {
  const reasonCode = String(decision.defensiveReason || '').toUpperCase();
  const reasonTitle = {
    THESIS_INVALIDATION: 'invalidacion de tesis',
    PROFIT_TO_LOSS_PREVENTION: 'prevencion de paso de ganancia a perdida',
    PROFIT_RETRACEMENT: 'retraccion de beneficios',
    PROFIT_PROTECTION: 'proteccion de beneficios',
    PRE_STOP_LOSS_RISK_REDUCTION: 'reduccion de riesgo previa a stop'
  }[reasonCode] || 'gestion defensiva de riesgo';

  const intro = `Se aplica SELL defensivo (${Math.round(normalizePct(decision.positionPct))}%) por ${reasonTitle}.`;

  const lifecyclePart = [
    formatPctFact('ROI actual', contextFacts.currentRoi),
    formatPctFact('max ROI visto', contextFacts.maxRoiSeen),
    formatPctFact('retraccion', contextFacts.profitRetracementPct),
    contextFacts.lifecyclePhase ? `fase=${contextFacts.lifecyclePhase}` : null
  ].filter(Boolean).join(', ');

  const indicatorsPart = buildIndicatorsDetail(contextFacts);
  const riskPart = buildRiskFactorsSentence(contextFacts.riskFactors);
  const sizingPart = buildSizingSentence(contextFacts, normalizePct(decision.positionPct));

  return [intro, lifecyclePart ? `Contexto de posicion: ${lifecyclePart}.` : null, indicatorsPart, riskPart, sizingPart]
    .filter(Boolean)
    .join(' ');
}

function buildHoldOverride(originalDecision, { summary, reasoning }) {
  return {
    ...originalDecision,
    action: 'HOLD',
    orderType: null,
    limitPrice: null,
    positionPct: 0,
    confidence: clamp(toNumber(originalDecision.confidence, 50), 40, 70),
    reasoning,
    summaryReasoning: summary || 'HOLD por gestion de riesgo'
  };
}

function buildResidualHoldReasoning(contextFacts) {
  const valueTxt = formatUsd(contextFacts.estimatedUsdValue);
  const minTxt = formatUsd(contextFacts.minOrderUsd);
  const riskPart = buildRiskFactorsSentence(contextFacts.riskFactors);

  return [
    `HOLD: la posicion residual (${valueTxt}) esta por debajo del minimo operable (${minTxt}).`,
    'Se evita lanzar ventas defensivas repetidas sobre una cantidad no ejecutable, salvo salidas forzadas (STOP_LOSS/TAKE_PROFIT).',
    riskPart
  ].filter(Boolean).join(' ');
}

function buildHoldCooldownReasoning(contextFacts, mode) {
  const untilTxt = contextFacts.cooldownUntil instanceof Date
    ? contextFacts.cooldownUntil.toISOString()
    : 'no disponible';

  if (mode === 'buy_recent_cooldown') {
    return 'HOLD: hubo una compra reciente de este simbolo en menos de 6 horas y no hay confirmacion nueva suficiente para aumentar exposicion.';
  }

  if (mode === 'defensive_cooldown') {
    const residualTxt = contextFacts.estimatedUsdValue > 0
      ? ` Valor residual estimado: ${formatUsd(contextFacts.estimatedUsdValue)}.`
      : '';
    return `HOLD: cooldown defensivo activo tras una venta reciente (hasta ${untilTxt}); se evita sobreoperar la posicion residual mientras no exista una senal forzada.${residualTxt}`;
  }

  return `HOLD: cooldown activo hasta ${untilTxt}; se evita abrir o ampliar posicion sin nueva confirmacion excepcional.`;
}

function buildHoldNoPositionReasoning(contextFacts, reason) {
  if (reason === 'cross_tf_block') {
    return 'HOLD: no hay posicion abierta y Cross-TF gate=false bloquea nuevas compras hasta que reaparezca confirmacion alcista multi-timeframe.';
  }

  if (reason === 'high_exposure') {
    return 'HOLD: no se abre nueva posicion porque la exposicion crypto ya es alta y la confirmacion no alcanza el umbral para asumir mas riesgo.';
  }

  return 'HOLD por gestion de riesgo en ausencia de posicion abierta y confirmacion suficiente.';
}

function buildHoldRiskReasoning(contextFacts) {
  const riskPart = buildRiskFactorsSentence(contextFacts.riskFactors);
  return [
    'HOLD: se bloquea BUY porque la posicion ya abierta presenta multiples factores de riesgo y no conviene aumentar exposicion.',
    riskPart
  ].filter(Boolean).join(' ');
}

function buildIndicatorsDetail(contextFacts) {
  const indicators = contextFacts?.indicators || {};
  const currentPrice = toNumber(contextFacts?.currentPrice, null);
  const ema12 = toNumber(indicators?.ema12, null);
  const ema26 = toNumber(indicators?.ema26, null);
  const macdHist = resolveMacdHistogram(indicators);
  const volumeQuality = indicators?.volumeContext?.volume_quality || null;
  const volumeDivergence = indicators?.volumeContext?.price_vol_divergence || null;
  const gate = contextFacts?.crossTf?.gate;
  const regime = contextFacts?.regimeSummary?.regime || contextFacts?.regimeSummary?.summary || null;
  const momentumShift = toNumber(contextFacts?.priceNarrative?.momentumShiftPct, null);
  const pattern = contextFacts?.priceNarrative?.detectedPattern || null;
  const atrPct = toNumber(contextFacts?.atrContext?.atrPct, null);

  const parts = [];

  if (currentPrice !== null && ema12 !== null && ema26 !== null) {
    const rel12 = currentPrice < ema12 ? 'por debajo' : 'por encima';
    const rel26 = currentPrice < ema26 ? 'por debajo' : 'por encima';
    parts.push(`precio ${formatPrice(currentPrice)} (${rel12} EMA12 ${formatPrice(ema12)} y ${rel26} EMA26 ${formatPrice(ema26)})`);
  }

  if (macdHist !== null) {
    parts.push(`MACD histogram=${macdHist.toFixed(4)}`);
  }

  if (volumeQuality || volumeDivergence) {
    const volumeTxt = [
      volumeQuality ? `volumen=${volumeQuality}` : null,
      volumeDivergence ? `divergencia=${volumeDivergence}` : null
    ].filter(Boolean).join(', ');
    parts.push(volumeTxt);
  }

  if (typeof gate === 'boolean') {
    parts.push(`Cross-TF gate=${gate}`);
  }

  if (regime) {
    parts.push(`regimen=${String(regime)}`);
  }

  if (momentumShift !== null) {
    parts.push(`momentumShift=${momentumShift.toFixed(2)}%`);
  }

  if (pattern) {
    parts.push(`patron=${pattern}`);
  }

  if (atrPct !== null) {
    parts.push(`ATR=${atrPct.toFixed(3)}%`);
  }

  if (parts.length === 0) return null;
  return `Senales tecnicas: ${parts.join('; ')}.`;
}

function buildRiskFactorsSentence(riskFactors) {
  const list = Array.isArray(riskFactors) ? riskFactors : [];
  if (list.length === 0) return null;
  const translated = list.map((f) => RISK_FACTOR_LABELS[f] || f);
  return `Factores de riesgo detectados (${translated.length}): ${translated.join(', ')}.`;
}

function buildSizingSentence(contextFacts, sellPct) {
  const estimatedUsd = toNumber(contextFacts.estimatedUsdValue, null);
  const minOrderUsd = toNumber(contextFacts.minOrderUsd, null);
  if (estimatedUsd === null || estimatedUsd <= 0) return null;

  const soldUsd = estimatedUsd * (sellPct / 100);
  const remainUsd = Math.max(0, estimatedUsd - soldUsd);

  const dustNote = (minOrderUsd !== null && minOrderUsd > 0 && remainUsd > 0 && remainUsd < minOrderUsd)
    ? ' Se ajusta salida completa para no dejar remanente no operable.'
    : '';

  return `Dimensionamiento: posicion estimada ${formatUsd(estimatedUsd)}, venta prevista ~${formatUsd(soldUsd)}, remanente ~${formatUsd(remainUsd)}.${dustNote}`;
}

function buildDefensiveSummary(defensiveReason, pct) {
  const map = {
    THESIS_INVALIDATION: 'invalidacion de tesis',
    PROFIT_TO_LOSS_PREVENTION: 'evitar paso de ganancia a perdida',
    PROFIT_RETRACEMENT: 'retraccion de beneficios',
    PROFIT_PROTECTION: 'proteccion de beneficio',
    PRE_STOP_LOSS_RISK_REDUCTION: 'reduccion de riesgo pre stop'
  };
  const label = map[defensiveReason] || 'riesgo elevado';
  return `SELL defensivo ${Math.round(normalizePct(pct))}% por ${label}`;
}

function annotateDecision(decision, contextFacts) {
  const riskFactors = Array.isArray(contextFacts?.riskFactors) ? contextFacts.riskFactors : [];

  return {
    ...decision,
    lifecyclePhase: decision.lifecyclePhase || contextFacts?.lifecyclePhase || null,
    positionLifecyclePhase: contextFacts?.lifecyclePhase || null,
    riskFactors,
    currentRoi: toNumber(contextFacts?.currentRoi, null),
    maxRoiSeen: toNumber(contextFacts?.maxRoiSeen, null),
    profitRetracementPct: toNumber(contextFacts?.profitRetracementPct, null),
  };
}

function isExceptionalSellDuringCooldown(contextFacts, riskFacts) {
  return Boolean(
    riskFacts?.strongInvalidation &&
    ((toNumber(contextFacts?.currentRoi, 0) <= -1.5) || (Array.isArray(riskFacts?.list) && riskFacts.list.length >= 6))
  );
}

function isFutureDate(dateObj) {
  if (!(dateObj instanceof Date)) return false;
  return Number.isFinite(dateObj.getTime()) && dateObj.getTime() > Date.now();
}

function isRecentDate(value, hoursWindow = 6) {
  if (!value) return false;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return false;
  const delta = Date.now() - d.getTime();
  return delta >= 0 && delta < (Number(hoursWindow) || 6) * 60 * 60 * 1000;
}

function resolveMacdHistogram(indicators) {
  const n1 = Number(indicators?.macdHistogram);
  if (Number.isFinite(n1)) return n1;
  const n2 = Number(indicators?.macd?.histogram);
  return Number.isFinite(n2) ? n2 : null;
}

function formatPctFact(label, val) {
  if (!Number.isFinite(Number(val))) return null;
  return `${label}=${Number(val).toFixed(2)}%`;
}

function formatUsd(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toFixed(2)}`;
}

function formatPrice(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 'n/d';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function normalizeSymbol(symbol) {
  return String(symbol || '').replace('/', '-').toUpperCase();
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePct(rawValue) {
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= 1) return n * 100;
  return n;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function logPortfolioOverride(symbol, previousDecision, nextDecision) {
  const prevAction = String(previousDecision?.action || 'UNKNOWN').toUpperCase();
  const nextAction = String(nextDecision?.action || 'UNKNOWN').toUpperCase();

  if (
    prevAction !== nextAction ||
    normalizePct(previousDecision?.positionPct) !== normalizePct(nextDecision?.positionPct)
  ) {
    logger.warn(
      `Portfolio manager override ${symbol}: ${prevAction} -> ${nextAction} | ${nextDecision?.defensiveReason || 'RISK_GUARDRAIL'}`
    );
  }
}
