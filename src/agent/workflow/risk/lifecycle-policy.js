/**
 * workflow/risk/lifecycle-policy.js
 * Centralized lifecycle and maturity helpers used by the portfolio manager.
 */

export function evaluateLifecycleState({
  symbol,
  analyzerContext,
  positionSummary,
  lifecycleState,
  config,
  decision
}) {
  const normalizedSymbol = normalizeSymbol(symbol || decision?.symbol);
  const indicators = analyzerContext?.indicators?.[normalizedSymbol] || {};
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
    toNumber(positionSummary?.unrealizedRoiPct, toNumber(decision?.currentRoi, 0))
  );
  const maxRoiSeen = toNumber(
    lifecycle?.max_unrealized_roi_pct,
    toNumber(decision?.maxRoiSeen, currentRoi)
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

  const stopLossPct = Number(config?.trading?.stopLossPct || 2.5);
  const minHoldMinutes = Number(config?.trading?.minHoldMinutesAfterBuy || 240);
  const ageMinutes = getLastBuyAgeMinutes(positionSummary, analyzerContext?.previousDecisions, normalizedSymbol);
  const isRecentBuy = ageMinutes !== null && ageMinutes < minHoldMinutes;

  return {
    normalizedSymbol,
    lifecycle,
    lifecyclePhase,
    currentPrice,
    totalQty,
    estimatedUsdValue,
    hasOpenPosition,
    currentRoi,
    maxRoiSeen,
    profitRetracementPct,
    cooldownUntil,
    cooldownActive,
    recentDefensiveSell,
    recentBuyCooldownActive,
    stopLossPct,
    minHoldMinutes,
    ageMinutes,
    isRecentBuy,
    isPositionMature: !isRecentBuy
  };
}

export function getLastBuyAgeMinutes(positionSummary, previousDecisionsBySymbol, symbol) {
  if (positionSummary?.openLots?.length > 0) {
    const sortedLots = [...positionSummary.openLots].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const lastLot = sortedLots[0];
    if (lastLot?.created_at) {
      return (Date.now() - new Date(lastLot.created_at).getTime()) / 60000;
    }
  }

  const history = previousDecisionsBySymbol?.[symbol] || [];
  const lastBuy = history.find((d) => String(d.action || '').toUpperCase() === 'BUY');
  if (lastBuy?.timestamp) {
    return (Date.now() - new Date(lastBuy.timestamp).getTime()) / 60000;
  }

  return null;
}

export function hasRecentBuyCooldownFromHistory(previousDecisionsBySymbol, symbol, hoursWindow = 6) {
  const history = previousDecisionsBySymbol?.[symbol] || [];
  if (!Array.isArray(history) || history.length === 0) return false;

  const lastBuy = history.find((d) => String(d.action || '').toUpperCase() === 'BUY');
  if (!lastBuy?.timestamp) return false;

  const createdAt = new Date(lastBuy.timestamp);
  if (!Number.isFinite(createdAt.getTime())) return false;

  const ageMs = Date.now() - createdAt.getTime();
  return ageMs >= 0 && ageMs < Number(hoursWindow) * 60 * 60 * 1000;
}

export function isFutureDate(dateObj) {
  if (!(dateObj instanceof Date)) return false;
  return Number.isFinite(dateObj.getTime()) && dateObj.getTime() > Date.now();
}

export function isRecentDate(value, hoursWindow = 6) {
  if (!value) return false;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return false;
  const delta = Date.now() - d.getTime();
  return delta >= 0 && delta < Number(hoursWindow) * 60 * 60 * 1000;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').replace('/', '-').toUpperCase();
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

