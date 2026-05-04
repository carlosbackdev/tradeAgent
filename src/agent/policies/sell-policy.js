import { resolveAgentPolicy } from './agent-policy-presets.js';

export function getPolicySellRules(tradingConfig = {}) {
  const policy = resolveAgentPolicy(tradingConfig);
  if (!policy) return null;

  return {
    policyId: policy.id,
    policyName: policy.name,
    minProfitToSellPct: Number(policy.minProfitToSellPct ?? 0),
    minProfitToDefensiveSellPct: Number(policy.minProfitToDefensiveSellPct ?? 0),
    maxNormalSellPct: Number(policy.maxNormalSellPct ?? 100),
    maxDefensiveSellPct: Number(policy.maxDefensiveSellPct ?? 100),
    defensiveSellRequiresProfit: Boolean(policy.defensiveSellRequiresProfit),
    allowLossSellOnlyOnHardStop: Boolean(policy.allowLossSellOnlyOnHardStop),
    minRiskFactorsForDefensiveSell: Number(policy.minRiskFactorsForDefensiveSell ?? 0),
    minRiskFactorsForLossSell: Number(policy.minRiskFactorsForLossSell ?? 0)
  };
}

export function evaluatePolicySellDecision({
  tradingConfig,
  action,
  currentRoiPct,
  requestedPositionPct,
  isDefensiveSell,
  isHardStop,
  isStopLoss,
  isExtremeInvalidation,
  strongRiskFactors = []
}) {
  const rules = getPolicySellRules(tradingConfig);
  if (!rules) {
    return { hasPolicy: false, allowed: true, positionPct: requestedPositionPct, reason: 'legacy_mode_no_policy', rules: null };
  }

  const normalizedAction = String(action || '').toUpperCase();
  if (normalizedAction !== 'SELL') {
    return { hasPolicy: true, allowed: true, positionPct: requestedPositionPct, reason: 'not_sell', rules };
  }

  const roi = Number(currentRoiPct ?? 0);
  const riskCount = Array.isArray(strongRiskFactors) ? strongRiskFactors.length : 0;
  const hasEmergencyExit = Boolean(isHardStop) || Boolean(isStopLoss) || Boolean(isExtremeInvalidation);

  if (hasEmergencyExit) {
    return { hasPolicy: true, allowed: true, positionPct: requestedPositionPct, reason: 'emergency_exit_allowed', rules };
  }

  if (roi < 0 && rules.allowLossSellOnlyOnHardStop && riskCount < rules.minRiskFactorsForLossSell) {
    return {
      hasPolicy: true,
      allowed: false,
      positionPct: 0,
      reason: `policy_blocks_loss_sell_roi_${roi}_risk_${riskCount}_min_${rules.minRiskFactorsForLossSell}`,
      rules
    };
  }

  if (isDefensiveSell) {
    if (riskCount < rules.minRiskFactorsForDefensiveSell) {
      return {
        hasPolicy: true,
        allowed: false,
        positionPct: 0,
        reason: `policy_blocks_defensive_sell_not_enough_risk_factors_${riskCount}_min_${rules.minRiskFactorsForDefensiveSell}`,
        rules
      };
    }
    if (rules.defensiveSellRequiresProfit && roi < rules.minProfitToDefensiveSellPct) {
      return {
        hasPolicy: true,
        allowed: false,
        positionPct: 0,
        reason: `policy_blocks_defensive_sell_low_profit_roi_${roi}_min_${rules.minProfitToDefensiveSellPct}`,
        rules
      };
    }
    return {
      hasPolicy: true,
      allowed: true,
      positionPct: Math.min(Number(requestedPositionPct || 0), rules.maxDefensiveSellPct),
      reason: 'policy_defensive_sell_allowed_capped',
      rules
    };
  }

  if (roi >= 0 && roi < rules.minProfitToSellPct) {
    return {
      hasPolicy: true,
      allowed: false,
      positionPct: 0,
      reason: `policy_blocks_normal_sell_low_profit_roi_${roi}_min_${rules.minProfitToSellPct}`,
      rules
    };
  }

  return {
    hasPolicy: true,
    allowed: true,
    positionPct: Math.min(Number(requestedPositionPct || 0), rules.maxNormalSellPct),
    reason: 'policy_normal_sell_allowed_capped',
    rules
  };
}
