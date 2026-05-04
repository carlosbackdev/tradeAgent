import assert from 'node:assert/strict';
import {
  AGENT_POLICY_PRESETS,
  resolveAgentPolicy,
  buildStrategyPolicyPromptContext
} from '../src/agent/policies/agent-policy-presets.js';
import {
  getHoldConfidenceThreshold,
  getRequiredConfidenceForAction
} from '../src/agent/context/prompts/confidence-threshold.js';
import { evaluatePolicySellDecision } from '../src/agent/policies/sell-policy.js';
import { getSystemPrompt } from '../src/agent/context/prompts/trading-system-prompt.js';
import { getOpenOrderSystemPrompt } from '../src/agent/context/prompts/open-orders-system-prompt.js';
import { resolveEffectiveTpSl } from '../src/agent/policies/effective-trading-config.js';

function run() {
  const legacyCfg = { personalityAgent: 'moderate' };
  assert.equal(resolveAgentPolicy({}), null, 'No policy should resolve to null');
  assert.equal(getRequiredConfidenceForAction('BUY', legacyCfg), getHoldConfidenceThreshold('moderate'), 'Legacy BUY should use legacy threshold');
  assert.equal(getRequiredConfidenceForAction('SELL', legacyCfg), getHoldConfidenceThreshold('moderate'), 'Legacy SELL should use legacy threshold');
  const legacyTpSl = resolveEffectiveTpSl({ takeProfitPct: 3, stopLossPct: 2 });
  assert.equal(legacyTpSl.takeProfitPct, 3, 'Legacy TP resolver should use tradingConfig');
  assert.equal(legacyTpSl.stopLossPct, 2, 'Legacy SL resolver should use tradingConfig');

  const capitalCfg = { agentPolicyPreset: 'capital_protection', personalityAgent: 'aggressive' };
  assert.equal(getRequiredConfidenceForAction('BUY', capitalCfg), 72, 'capital_protection BUY should be 72');
  assert.equal(getRequiredConfidenceForAction('SELL', capitalCfg), 58, 'capital_protection SELL should be 58');
  const swingCfg = { agentPolicyPreset: 'swing_balanced', personalityAgent: 'moderate' };
  assert.equal(getRequiredConfidenceForAction('BUY', swingCfg), 55, 'swing_balanced BUY should be 55');
  assert.equal(getRequiredConfidenceForAction('SELL', swingCfg), 52, 'swing_balanced SELL should be 52');

  assert.equal(resolveAgentPolicy({ agentPolicyPreset: 'long_accumulation' })?.baseInterval, 1440, 'long_accumulation baseInterval should be 1440');
  assert.equal(resolveAgentPolicy({ agentPolicyPreset: 'long_accumulation' })?.minProfitToSellPct, 4.0, 'long_accumulation minProfitToSellPct should be 4.0');
  assert.equal(resolveAgentPolicy({ agentPolicyPreset: 'long_accumulation' })?.maxDefensiveSellPct, 15, 'long_accumulation maxDefensiveSellPct should be 15');
  assert.equal(resolveAgentPolicy({ agentPolicyPreset: 'swing_balanced' })?.minProfitToSellPct, 1.5, 'swing_balanced minProfitToSellPct should be 1.5');
  assert.equal(resolveAgentPolicy({ agentPolicyPreset: 'swing_balanced' })?.maxDefensiveSellPct, 30, 'swing_balanced maxDefensiveSellPct should be 30');
  assert.equal(resolveAgentPolicy({ agentPolicyPreset: 'daily_trader' })?.baseInterval, 30, 'daily_trader baseInterval should be 30');
  assert.equal(resolveAgentPolicy({ agentPolicyPreset: 'daily_trader' })?.higherInterval, 240, 'daily_trader higherInterval should be 240');

  assert.equal(resolveAgentPolicy({ agentPolicyPreset: 'invalid_policy' }), null, 'Invalid policy must fallback to null');
  AGENT_POLICY_PRESETS.daily_trader.takeProfitPct = 9;
  AGENT_POLICY_PRESETS.daily_trader.stopLossPct = 4;
  const policyTpSl = resolveEffectiveTpSl({ agentPolicyPreset: 'daily_trader', takeProfitPct: 1, stopLossPct: 1 });
  assert.equal(policyTpSl.takeProfitPct, 9, 'Policy TP resolver should override legacy when policy field exists');
  assert.equal(policyTpSl.stopLossPct, 4, 'Policy SL resolver should override legacy when policy field exists');
  delete AGENT_POLICY_PRESETS.daily_trader.takeProfitPct;
  delete AGENT_POLICY_PRESETS.daily_trader.stopLossPct;
  assert.equal(buildStrategyPolicyPromptContext({}), null, 'Prompt context should be null without policy');
  const longPromptCtx = buildStrategyPolicyPromptContext({ agentPolicyPreset: 'long_accumulation' });
  for (const key of ['id', 'name', 'horizon', 'timeframes', 'confidence', 'holding', 'sellRules', 'exposure', 'profitProtectionMode', 'behavior']) {
    assert.equal(Object.prototype.hasOwnProperty.call(longPromptCtx, key), true, `Prompt ctx missing ${key}`);
  }
  for (const key of ['description', 'emoji', 'minRiskFactorsForDefensiveSell', 'minRiskFactorsForLossSell', 'allowLossSellOnlyOnHardStop', 'defensiveSellRequiresProfit']) {
    assert.equal(Object.prototype.hasOwnProperty.call(longPromptCtx, key), false, `Prompt ctx should not include ${key}`);
  }

  for (const preset of Object.values(AGENT_POLICY_PRESETS)) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(preset, 'maxTradeSizeMultiplier'),
      false,
      `Policy ${preset.id} must not include maxTradeSizeMultiplier`
    );
    for (const key of [
      'minProfitToSellPct',
      'minProfitToDefensiveSellPct',
      'maxNormalSellPct',
      'maxDefensiveSellPct',
      'defensiveSellRequiresProfit',
      'allowLossSellOnlyOnHardStop',
      'minRiskFactorsForDefensiveSell',
      'minRiskFactorsForLossSell'
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(preset, key), true, `${preset.id} missing ${key}`);
    }
  }

  const legacySell = evaluatePolicySellDecision({
    tradingConfig: {},
    action: 'SELL',
    currentRoiPct: 0.5,
    requestedPositionPct: 60
  });
  assert.equal(legacySell.allowed, true, 'Legacy should allow sell');
  assert.equal(legacySell.positionPct, 60, 'Legacy should not cap sell');

  const swingLow = evaluatePolicySellDecision({
    tradingConfig: { agentPolicyPreset: 'swing_balanced' },
    action: 'SELL',
    currentRoiPct: 0.5,
    requestedPositionPct: 80,
    isDefensiveSell: false,
    strongRiskFactors: ['a', 'b']
  });
  assert.equal(swingLow.allowed, false, 'Swing should block normal low-profit sell');

  const swingCap = evaluatePolicySellDecision({
    tradingConfig: { agentPolicyPreset: 'swing_balanced' },
    action: 'SELL',
    currentRoiPct: 2.0,
    requestedPositionPct: 80,
    isDefensiveSell: false
  });
  assert.equal(swingCap.allowed, true);
  assert.equal(swingCap.positionPct, 45, 'Swing normal sell should cap to 45');

  const longDefLow = evaluatePolicySellDecision({
    tradingConfig: { agentPolicyPreset: 'long_accumulation' },
    action: 'SELL',
    currentRoiPct: 0.5,
    requestedPositionPct: 50,
    isDefensiveSell: true,
    strongRiskFactors: ['a', 'b', 'c', 'd', 'e']
  });
  assert.equal(longDefLow.allowed, false, 'Long defensive low-profit should block');

  const longDefCap = evaluatePolicySellDecision({
    tradingConfig: { agentPolicyPreset: 'long_accumulation' },
    action: 'SELL',
    currentRoiPct: 3.0,
    requestedPositionPct: 50,
    isDefensiveSell: true,
    strongRiskFactors: ['a', 'b', 'c', 'd']
  });
  assert.equal(longDefCap.allowed, true);
  assert.equal(longDefCap.positionPct, 15, 'Long defensive should cap to 15');

  const capProtectionDef = evaluatePolicySellDecision({
    tradingConfig: { agentPolicyPreset: 'capital_protection' },
    action: 'SELL',
    currentRoiPct: 0.1,
    requestedPositionPct: 60,
    isDefensiveSell: true,
    strongRiskFactors: ['a', 'b']
  });
  assert.equal(capProtectionDef.allowed, true, 'Capital protection should allow defensive low-profit sell');

  const hardStopNeg = evaluatePolicySellDecision({
    tradingConfig: { agentPolicyPreset: 'swing_balanced' },
    action: 'SELL',
    currentRoiPct: -3.0,
    requestedPositionPct: 100,
    isHardStop: true
  });
  assert.equal(hardStopNeg.allowed, true, 'Hard stop must always be allowed');

  const analyzerPolicyPrompt = getSystemPrompt({ ...legacyCfg, agentPolicyPreset: 'capital_protection', maxTradeSize: 25, minOrderUsd: 50, takeProfitPct: 3 });
  assert.equal(analyzerPolicyPrompt.includes('Active Agent Policy:'), true, 'Analyzer prompt should include Active Agent Policy with policy');
  assert.equal(analyzerPolicyPrompt.includes('Legacy strategy mode:'), false, 'Analyzer prompt should not include Legacy block with policy');
  assert.equal(analyzerPolicyPrompt.includes('Position lifecycle:'), true, 'Analyzer prompt should include Position lifecycle section');
  assert.equal(analyzerPolicyPrompt.includes('Starter BUY rule:'), true, 'Analyzer prompt should include Starter BUY rule section');
  assert.equal(analyzerPolicyPrompt.includes('Reasoning must be specific and concrete'), true, 'Analyzer prompt should include detailed reasoning instruction');

  const analyzerLegacyPrompt = getSystemPrompt({ ...legacyCfg, maxTradeSize: 25, minOrderUsd: 50, takeProfitPct: 3, visionAgent: 'short' });
  assert.equal(analyzerLegacyPrompt.includes('Legacy strategy mode:'), true, 'Analyzer prompt should include Legacy block without policy');
  assert.equal(analyzerLegacyPrompt.includes('Active Agent Policy:'), false, 'Analyzer prompt should not include Active Agent Policy without policy');
  assert.equal(analyzerLegacyPrompt.includes('Position lifecycle:'), true, 'Legacy analyzer prompt should keep rich lifecycle rules');
  assert.equal(analyzerLegacyPrompt.includes('Cross-TF rule:'), true, 'Legacy analyzer prompt should keep Cross-TF section');
  assert.equal(analyzerLegacyPrompt.includes('Entry rule:'), true, 'Legacy analyzer prompt should keep Entry rule section');
  assert.equal(analyzerLegacyPrompt.includes('If strategyPolicy'), false, 'Analyzer prompt should not include If strategyPolicy');
  assert.equal(analyzerLegacyPrompt.includes('When strategyPolicy'), false, 'Analyzer prompt should not include When strategyPolicy');
  assert.equal(analyzerLegacyPrompt.includes('strategyPolicy is null'), false, 'Analyzer prompt should not include strategyPolicy is null');

  const ooPolicyPrompt = getOpenOrderSystemPrompt({ ...legacyCfg, agentPolicyPreset: 'swing_balanced', maxTradeSize: 25, visionAgent: 'short' });
  assert.equal(ooPolicyPrompt.includes('Active Agent Policy:'), true, 'Open orders prompt should include Active Agent Policy with policy');
  assert.equal(ooPolicyPrompt.includes('Legacy strategy mode:'), false, 'Open orders prompt should not include Legacy block with policy');
  assert.equal(ooPolicyPrompt.includes('If strategyPolicy'), false, 'Open orders prompt should not include If strategyPolicy');
  assert.equal(ooPolicyPrompt.includes('When strategyPolicy'), false, 'Open orders prompt should not include When strategyPolicy');

  const ooLegacyPrompt = getOpenOrderSystemPrompt({ ...legacyCfg, maxTradeSize: 25, visionAgent: 'short' });
  assert.equal(ooLegacyPrompt.includes('Legacy strategy mode:'), true, 'Open orders prompt should include Legacy block without policy');
  assert.equal(ooLegacyPrompt.includes('Active Agent Policy:'), false, 'Open orders prompt should not include Active Agent Policy without policy');

  console.log('validate-agent-policy-presets: OK');
}

run();
