import { resolveAgentPolicy } from '../../policies/agent-policy-presets.js';

export function getHoldConfidenceThreshold(personalityAgent = 'moderate') {
  const personality = String(personalityAgent || 'moderate').toLowerCase();

  if (personality === 'aggressive') return 40;
  if (personality === 'conservative') return 55;
  return 45;
}

export function getRequiredConfidenceForAction(action, tradingConfig = {}) {
  const policy = resolveAgentPolicy(tradingConfig);
  if (policy) {
    const normalizedAction = String(action || '').toUpperCase();
    if (normalizedAction === 'BUY') return Number(policy.buyConfidenceMin);
    if (normalizedAction === 'SELL') return Number(policy.sellConfidenceMin);
  }

  return getHoldConfidenceThreshold(tradingConfig?.personalityAgent);
}
