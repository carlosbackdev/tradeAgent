import assert from 'assert/strict';

import { buildExecutableOrderSize } from '../src/agent/workflow/sizing/order-sizing.js';
import { buildRealAvailableBalances } from '../src/agent/workflow/available-balance.js';

function runForcedStopLossCase() {
  const decision = {
    symbol: 'VVV-USD',
    action: 'SELL',
    confidence: 100,
    orderType: 'market',
    usdAmount: 15.67,
    baseAmount: 0.94001904,
    forced: true,
    forcedReason: 'STOP_LOSS'
  };

  const plan = buildExecutableOrderSize({
    decision,
    balanceArray: [{ currency: 'VVV', total: 0.94096 }, { currency: 'USD', total: 48.48 }],
    openOrders: [],
    realAvailableBalances: {
      availableByCurrency: { VVV: 0.94096, USD: 48.48 },
      totalsByCurrency: { VVV: 0.94096, USD: 48.48 },
      reserved: { cryptoInOpenSellLimitsByCurrency: {} }
    },
    indicators: { 'VVV-USD': { currentPrice: 16.675 } },
    managedPositions: [],
    tradingConfig: {}
  });

  assert.ok(plan.sellableCrypto > 0, 'STOP_LOSS: sellableCrypto should be > 0');
  assert.ok(plan.baseAmount > 0, 'STOP_LOSS: baseAmount should be > 0');
  assert.equal(plan.effectivePositionPct, 100, 'STOP_LOSS: effectivePositionPct should be 100');
}

function runForcedTakeProfitCases() {
  const decision = {
    symbol: 'VVV-USD',
    action: 'SELL',
    confidence: 100,
    orderType: 'market',
    usdAmount: 17.5,
    baseAmount: 0.94001904,
    forced: true,
    forcedReason: 'TAKE_PROFIT'
  };

  const baseInput = {
    decision,
    balanceArray: [{ currency: 'VVV', total: 0.94096 }],
    openOrders: [],
    realAvailableBalances: {
      availableByCurrency: { VVV: 0.94096 },
      totalsByCurrency: { VVV: 0.94096 },
      reserved: { cryptoInOpenSellLimitsByCurrency: {} }
    },
    indicators: { 'VVV-USD': { currentPrice: 18.6 } },
    managedPositions: []
  };

  const plan100 = buildExecutableOrderSize({ ...baseInput, tradingConfig: {} });
  assert.equal(plan100.effectivePositionPct, 100, 'TAKE_PROFIT default: should sell 100%');
  assert.ok(plan100.sellableCrypto > 0, 'TAKE_PROFIT default: sellableCrypto should be > 0');

  const plan50 = buildExecutableOrderSize({ ...baseInput, tradingConfig: { takeProfitExitPct: 50 } });
  assert.equal(plan50.effectivePositionPct, 50, 'TAKE_PROFIT configured: should sell 50%');
  assert.ok(Math.abs(plan50.baseAmount - 0.47048) < 0.00002, 'TAKE_PROFIT configured: baseAmount should be near 0.47048');
}

function runNormalSellCase() {
  const reserved = buildRealAvailableBalances(
    [{ currency: 'VVV', total: 1 }],
    [{ symbol: 'VVV-USD', side: 'sell', status: 'open', type: 'limit', qty: 0.8 }]
  );

  const plan = buildExecutableOrderSize({
    decision: {
      symbol: 'VVV-USD',
      action: 'SELL',
      positionPct: 50,
      forced: false
    },
    balanceArray: [{ currency: 'VVV', total: 1 }],
    openOrders: [{ symbol: 'VVV-USD', side: 'sell', status: 'open', type: 'limit', qty: 0.8 }],
    realAvailableBalances: reserved,
    indicators: { 'VVV-USD': { currentPrice: 16.6 } },
    managedPositions: [{ symbol: 'VVV-USD', qty: 1 }],
    tradingConfig: {}
  });

  assert.ok(plan.sellableCrypto <= 0.20000001, 'Normal SELL: should honor reserved open sell limits');
}

try {
  runForcedStopLossCase();
  runForcedTakeProfitCases();
  runNormalSellCase();
  console.log('Validation OK: forced sell flow scenarios passed');
} catch (err) {
  console.error('Validation failed:', err.message);
  process.exitCode = 1;
}
