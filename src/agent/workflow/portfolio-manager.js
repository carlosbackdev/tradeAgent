/**
 * workflow/portfolio-manager.js
 * Risk supervision layer on top of LLM decisions.
 */

import { logger } from '../../utils/logger.js';
import {
  buildRiskProfile,
  shouldAllowHardStop,
  shouldBlockRecentSell,
  shouldAllowDefensiveSell,
  capSellPct,
  normalizeSellRisk,
  isExtremeInvalidation
} from './risk/risk-policy.js';
import { evaluateLifecycleState } from './risk/lifecycle-policy.js';

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
  const sellAllResidualUsdThreshold = resolveSellAllResidualUsdThreshold(config);

  const lifecycleFacts = evaluateLifecycleState({
    symbol: normalizedSymbol,
    analyzerContext,
    positionSummary,
    lifecycleState,
    config,
    decision
  });

  const {
    lifecyclePhase,
    currentRoi,
    maxRoiSeen,
    profitRetracementPct,
    currentPrice,
    estimatedUsdValue,
    totalQty,
    hasOpenPosition,
    cooldownActive,
    cooldownUntil,
    recentDefensiveSell,
    recentBuyCooldownActive,
    stopLossPct,
    minHoldMinutes,
    ageMinutes,
    isRecentBuy
  } = lifecycleFacts;

  const decisionAction = String(decision.action || 'HOLD').toUpperCase();
  const decisionConfidence = toNumber(decision.confidence, 0);
  const decisionPct = normalizePct(decision.positionPct);

  const atrMoveSignificance = pairCtx?.atr?.move_significance || priceNarrative?.lastMoveVsATR || null;
  const riskFacts = buildRiskProfile({
    crossTf,
    higherTf,
    indicators,
    priceNarrative,
    cryptoPercentage
  });

  const extremeInvalidation = isExtremeInvalidation({
    currentRoi,
    riskFactors: riskFacts.list,
    higherTfSell: riskFacts.higherTfSell,
    baseTfSell: riskFacts.baseTfSell,
    moveSignificance: atrMoveSignificance
  });
  riskFacts.extremeInvalidation = extremeInvalidation;

  const contextFacts = {
    symbol: normalizedSymbol,
    lifecyclePhase,
    currentRoi,
    maxRoiSeen,
    profitRetracementPct,
    currentPrice,
    estimatedUsdValue,
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
    higherTfSell: riskFacts.higherTfSell,
    stopLossPct,
    minHoldMinutes,
    extremeInvalidation,
    positionMature: !isRecentBuy,
    sellAllResidualUsdThreshold
  };

  contextFacts.isRecentBuy = isRecentBuy;
  contextFacts.ageMinutes = ageMinutes;

  if (decisionAction === 'BUY' && recentBuyCooldownActive) {
    return annotateDecision(buildHoldOverride(decision, {
      summary: 'HOLD por cooldown tras BUY reciente',
      reasoning: buildHoldCooldownReasoning(contextFacts, 'buy_recent_cooldown')
    }), contextFacts);
  }

  if (!hasOpenPosition) {
    if (decisionAction === 'BUY') {
      if (crossTf?.gate === false && crossTf?.entryMode !== 'starter_allowed') {
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

  const defensiveCandidate = shouldAllowDefensiveSell({
    riskFacts,
    currentRoi,
    maxRoiSeen,
    isRecentBuy
  });

  if ((cooldownActive || recentDefensiveSell) && !isExceptionalSellDuringCooldown(contextFacts, riskFacts)) {
    return annotateDecision(buildHoldOverride(decision, {
      summary: 'HOLD: cooldown defensivo activo',
      reasoning: buildHoldCooldownReasoning(contextFacts, 'defensive_cooldown')
    }), contextFacts);
  }

  if (decisionAction === 'SELL') {
    const hardStopAllowed = shouldAllowHardStop({ currentRoi, stopLossPct });
    const blockedByRecentBuy = shouldBlockRecentSell({
      isRecentBuy,
      hardStopAllowed,
      extremeInvalidation,
      forced: decision?.forced === true
    });

    if (blockedByRecentBuy) {
      logger.info(`SELL blocked: recently bought ${Math.round(ageMinutes)}min ago, minHold=${minHoldMinutes}, roi=${currentRoi}, stopLoss=${stopLossPct}`);
      return annotateDecision(buildHoldOverride(decision, {
        summary: 'HOLD: venta bloqueada por maduracion',
        reasoning: `HOLD: se evita una venta impulsiva. Comprado hace ${Math.round(ageMinutes)}min (minHold=${minHoldMinutes}min). ROI: ${currentRoi}%, no alcanza stop loss ni invalidacion extrema.`
      }), contextFacts);
    }

    if (isRecentBuy && extremeInvalidation) {
      logger.info(`SELL allowed: extreme invalidation (age: ${Math.round(ageMinutes)}min)`);
    }

    if (currentRoi <= 0 && currentRoi > -1.8 && !riskFacts.strongInvalidation) {
      if (!defensiveCandidate) {
        logger.info(`SELL blocked: small drawdown ${currentRoi}% without strong deterioration`);
        return annotateDecision(buildHoldOverride(decision, {
          summary: 'HOLD: venta rechazada por drawdown pequeno sin deterioro fuerte',
          reasoning: `HOLD: el ROI es ${currentRoi}%, no hay suficientes factores de riesgo para justificar una venta parcial o total.`
        }), contextFacts);
      } else if (decisionPct > defensiveCandidate.positionPctMax) {
        const cappedPct = capSellPct(decisionPct, {
          minPct: defensiveCandidate.positionPctMin,
          maxPct: defensiveCandidate.positionPctMax,
          defaultPct: defensiveCandidate.positionPctMax
        });
        const capped = buildDefensiveSell(decision, defensiveCandidate, contextFacts, {
          minPct: cappedPct,
          maxPct: cappedPct
        });
        return annotateDecision(enforceSellAllResidualDust(capped, contextFacts), contextFacts);
      }
    }

    if (defensiveCandidate && riskFacts.strongInvalidation && decisionPct < 80) {
      const upgraded = buildDefensiveSell(decision, defensiveCandidate, contextFacts, {
        minPct: 80,
        maxPct: 100
      });
      return annotateDecision(enforceSellAllResidualDust(upgraded, contextFacts), contextFacts);
    }

    const normalizedExistingSell = {
      ...decision,
      positionPct: normalizeSellRisk(decision.positionPct)
    };
    return annotateDecision(enforceSellAllResidualDust(normalizedExistingSell, contextFacts), contextFacts);
  }

  if (defensiveCandidate) {
    if (decisionAction === 'HOLD') {
      const overridden = enforceSellAllResidualDust(
        buildDefensiveSell(decision, defensiveCandidate, contextFacts),
        contextFacts
      );
      return annotateDecision(overridden, contextFacts);
    }

    if (decisionAction === 'BUY' && riskFacts.list.length >= 3) {
      const overridden = enforceSellAllResidualDust(
        buildDefensiveSell(decision, defensiveCandidate, contextFacts),
        contextFacts
      );
      return annotateDecision(overridden, contextFacts);
    }
  }

  if (decisionAction === 'BUY' && riskFacts.list.length >= 3) {
    return annotateDecision(buildHoldOverride(decision, {
      summary: 'HOLD: BUY bloqueado por riesgo elevado',
      reasoning: buildHoldRiskReasoning(contextFacts)
    }), contextFacts);
  }

  return annotateDecision(decision, contextFacts);
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

  return {
    ...next,
    reasoning: buildDefensiveReasoning(next, contextFacts),
    summaryReasoning: buildDefensiveSummary(candidate.defensiveReason, next.positionPct)
  };
}

function buildDefensiveReasoning(decision, contextFacts) {
  const reasonCode = String(decision.defensiveReason || '').toUpperCase();
  const reasonTitle = {
    EXTREME_INVALIDATION: 'invalidacion extrema',
    THESIS_INVALIDATION: 'invalidacion de tesis',
    PROFIT_TO_LOSS_PREVENTION: 'prevencion de paso de ganancia a perdida',
    PROFIT_RETRACEMENT: 'retraccion de beneficios',
    PROFIT_PROTECTION: 'proteccion de beneficios',
    EARLY_DRAWDOWN_REDUCTION: 'reduccion de riesgo temprana',
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
    return 'HOLD: no hay posicion abierta y Cross-TF gate=false (blocked) impide nuevas compras. El timeframe superior no avala una entrada temprana.';
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
    const mode = contextFacts?.crossTf?.entryMode || 'unknown';
    parts.push(`Cross-TF gate=${gate} (mode=${mode})`);
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
  if (estimatedUsd === null || estimatedUsd <= 0) return null;

  const soldUsd = estimatedUsd * (sellPct / 100);
  const remainUsd = Math.max(0, estimatedUsd - soldUsd);

  return `Dimensionamiento: posicion estimada ${formatUsd(estimatedUsd)}, venta prevista ~${formatUsd(soldUsd)}, remanente ~${formatUsd(remainUsd)}.`;
}

function buildDefensiveSummary(defensiveReason, pct) {
  const map = {
    EXTREME_INVALIDATION: 'invalidacion extrema',
    THESIS_INVALIDATION: 'invalidacion de tesis',
    PROFIT_TO_LOSS_PREVENTION: 'evitar paso de ganancia a perdida',
    PROFIT_RETRACEMENT: 'retraccion de beneficios',
    PROFIT_PROTECTION: 'proteccion de beneficio',
    EARLY_DRAWDOWN_REDUCTION: 'reduccion riesgo temprana',
    PRE_STOP_LOSS_RISK_REDUCTION: 'reduccion de riesgo pre stop'
  };
  const label = map[defensiveReason] || 'riesgo elevado';
  return `SELL defensivo ${Math.round(normalizePct(pct))}% por ${label}`;
}

function enforceSellAllResidualDust(decision, contextFacts) {
  if (String(decision?.action || '').toUpperCase() !== 'SELL') return decision;

  const currentPct = normalizeSellRisk(decision?.positionPct);
  if (currentPct <= 0 || currentPct >= 100) {
    return { ...decision, positionPct: currentPct };
  }

  const estimatedUsd = toNumber(contextFacts?.estimatedUsdValue, 0);
  const thresholdUsd = toNumber(contextFacts?.sellAllResidualUsdThreshold, 4);
  if (!(estimatedUsd > 0) || !(thresholdUsd > 0)) {
    return { ...decision, positionPct: currentPct };
  }

  const residualUsd = Math.max(0, estimatedUsd * (1 - (currentPct / 100)));
  if (!(residualUsd > 0) || residualUsd >= thresholdUsd) {
    return { ...decision, positionPct: currentPct };
  }

  const thresholdTxt = formatUsd(thresholdUsd);
  const residualTxt = formatUsd(residualUsd);
  const note = `Ajuste de ejecucion: se eleva a SELL 100% para evitar remanente no operable (${residualTxt} < ${thresholdTxt}).`;
  const nextSummary = decision?.summaryReasoning
    ? `${decision.summaryReasoning} | SELL 100% para evitar residual no operable (< ${thresholdTxt})`
    : `SELL 100% para evitar residual no operable (< ${thresholdTxt})`;

  return {
    ...decision,
    positionPct: 100,
    reasoning: [decision?.reasoning, note].filter(Boolean).join(' '),
    summaryReasoning: nextSummary
  };
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

function resolveSellAllResidualUsdThreshold(config) {
  const n = Number(config?.trading?.sellAllResidualUsdThreshold ?? 4);
  if (!Number.isFinite(n) || n <= 0) return 4;
  return n;
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
