export function buildEntryRiskFactors({ indicators, crossTfConfluence }) {
  const risks = [];

  if (crossTfConfluence?.gate === false) {
    risks.push('cross_tf_conflict');
  }

  if (crossTfConfluence?.entryMode === 'blocked') {
    risks.push('entry_blocked_by_cross_tf_gate');
  }

  if (crossTfConfluence?.entryMode === 'starter_allowed') {
    risks.push('starter_entry_only');
  }

  if (
    Array.isArray(crossTfConfluence?.conflicts) &&
    crossTfConfluence.conflicts.includes('EMA_direction_conflict')
  ) {
    risks.push('cross_tf_ema_conflict');
  }

  if (indicators?.rsi14 >= 70) {
    risks.push('rsi_overbought');
  }

  if (indicators?.bollinger?.positionPct > 100) {
    risks.push('price_above_upper_bollinger');
  }

  if (indicators?.volumeContext?.volume_quality === 'low') {
    risks.push('low_volume');
  }

  return risks;
}

export function buildEntrySupportFactors({ indicators, crossTfConfluence }) {
  const support = [];

  if (crossTfConfluence?.signals?.includes('MACD_aligned_bullish')) {
    support.push('macd_aligned_bullish');
  }

  if (indicators?.macd?.histogram > 0) {
    support.push('macd_positive');
  }

  if (indicators?.ema12 > indicators?.ema26) {
    support.push('ema_golden_cross');
  }

  if (indicators?.volumeContext?.obv_trend === 'accumulation') {
    support.push('obv_accumulation');
  }

  if (indicators?.rsi14 >= 45 && indicators?.rsi14 <= 68) {
    support.push('healthy_rsi_zone');
  }

  return support;
}
