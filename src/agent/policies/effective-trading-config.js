import { resolveAgentPolicy } from './agent-policy-presets.js';

function toFinite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readFirstDefined(obj, keys = []) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      return obj[k];
    }
  }
  return undefined;
}

export function resolveEffectiveTakeProfitPct(tradingConfig = {}) {
  const policy = resolveAgentPolicy(tradingConfig);
  const policyValue = readFirstDefined(policy, ['takeProfitPct', 'takeProfitPolicyPct', 'tpPct']);
  if (policyValue !== undefined) return toFinite(policyValue, 0);
  return toFinite(tradingConfig?.takeProfitPct, 0);
}

export function resolveEffectiveStopLossPct(tradingConfig = {}) {
  const policy = resolveAgentPolicy(tradingConfig);
  const policyValue = readFirstDefined(policy, ['stopLossPct', 'stopLossPolicyPct', 'slPct']);
  if (policyValue !== undefined) return toFinite(policyValue, 0);
  return toFinite(tradingConfig?.stopLossPct, 0);
}

export function resolveEffectiveTpSl(tradingConfig = {}) {
  return {
    takeProfitPct: resolveEffectiveTakeProfitPct(tradingConfig),
    stopLossPct: resolveEffectiveStopLossPct(tradingConfig)
  };
}
