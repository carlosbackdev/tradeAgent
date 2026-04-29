import assert from 'assert/strict';

import { applyPortfolioManagerDecision } from '../src/agent/workflow/portfolio-manager.js';
import { buildExecutableOrderSize } from '../src/agent/workflow/sizing/order-sizing.js';
import { OrderManager } from '../src/revolut/orders.js';
import { applySellToOpenLots } from '../src/services/mongo/modules/orders-repository.js';

function minutesAgo(minutes) {
  return new Date(Date.now() - (minutes * 60 * 1000)).toISOString();
}

function buildAnalyzerContext({ currentPrice = 1.3948, crossTfGate = true, higherTfSell = false, baseTfSell = false, riskHeavy = false }) {
  const symbol = 'XRP-USD';
  const confluence = baseTfSell ? 'SELL_SIGNAL' : 'NEUTRAL';

  return {
    indicators: {
      [symbol]: {
        currentPrice,
        ema12: riskHeavy ? currentPrice * 1.01 : currentPrice * 0.99,
        ema26: riskHeavy ? currentPrice * 1.02 : currentPrice * 0.98,
        macdHistogram: riskHeavy ? -0.002 : 0.001,
        confluence: { suggestion: confluence },
        volumeContext: {
          volume_quality: riskHeavy ? 'low' : 'normal',
          price_vol_divergence: riskHeavy ? 'bearish_divergence' : 'none'
        }
      }
    },
    pairs: [
      {
        symbol,
        atr: { move_significance: riskHeavy ? 'large' : 'normal' },
        recentClosesContext: {
          last30: {
            priceNarrative: {
              momentumShiftPct: riskHeavy ? -25 : -5,
              detectedPattern: riskHeavy ? 'three_consecutive_red' : 'no_clear_pattern',
              lastMoveVsATR: riskHeavy ? 'strong_move' : 'normal_move'
            }
          }
        },
        regimeSummary: { regime: riskHeavy ? 'bearish' : 'mixed' }
      }
    ],
    crossTfConfluence: {
      [symbol]: {
        gate: crossTfGate,
        entryMode: crossTfGate ? 'allowed' : 'blocked'
      }
    },
    higherTimeframe: {
      confluence: {
        suggestion: higherTfSell ? 'SELL_SIGNAL' : 'NEUTRAL',
        bearishCount: higherTfSell ? 3 : 1,
        bullishCount: higherTfSell ? 1 : 2
      }
    },
    balances: {
      summary: {
        cryptoPercentage: 50
      }
    },
    previousDecisions: {
      [symbol]: []
    }
  };
}

function buildConfig() {
  return {
    trading: {
      minOrderUsd: 20,
      sellAllResidualUsdThreshold: 4,
      stopLossPct: 2.5,
      minHoldMinutesAfterBuy: 240,
      maxTradeSize: 25
    }
  };
}

function runPortfolioCase({
  ageMinutes,
  currentRoi,
  decisionPct = 100,
  riskHeavy = false,
  higherTfSell = false,
  baseTfSell = false,
  currentPrice = 1.3948,
  totalQty = 29.2043
}) {
  const symbol = 'XRP-USD';
  const positionSummary = {
    totalOpenQty: totalQty,
    openLots: [{ created_at: minutesAgo(ageMinutes), remaining_qty: totalQty }],
    unrealizedRoiPct: currentRoi
  };

  const lifecycleState = {
    phase: currentRoi >= 0 ? 'IN_PROFIT' : 'IN_DRAWDOWN',
    current_roi_pct: currentRoi,
    max_unrealized_roi_pct: Math.max(currentRoi, 1.5),
    last_defensive_sell_at: null,
    cooldown_until: null
  };

  const decision = {
    symbol,
    action: 'SELL',
    confidence: 90,
    positionPct: decisionPct,
    orderType: 'limit',
    limitPrice: 1.3941,
    reasoning: 'test'
  };

  return applyPortfolioManagerDecision({
    decision,
    symbol,
    analyzerContext: buildAnalyzerContext({
      currentPrice,
      crossTfGate: true,
      higherTfSell,
      baseTfSell,
      riskHeavy
    }),
    positionSummary,
    lifecycleState,
    config: buildConfig()
  });
}

async function run() {
  const case1 = runPortfolioCase({
    ageMinutes: 83,
    currentRoi: -0.61,
    decisionPct: 100,
    riskHeavy: false,
    higherTfSell: false,
    baseTfSell: false
  });
  assert.equal(case1.action, 'HOLD', 'Case 1 failed: recent BUY + -0.61% should HOLD');

  const case2 = runPortfolioCase({
    ageMinutes: 83,
    currentRoi: -2.6,
    decisionPct: 100,
    riskHeavy: false,
    higherTfSell: false,
    baseTfSell: false
  });
  assert.equal(case2.action, 'SELL', 'Case 2 failed: stop-loss breach should allow SELL');

  const case3 = runPortfolioCase({
    ageMinutes: 400,
    currentRoi: -0.61,
    decisionPct: 100,
    riskHeavy: false,
    higherTfSell: false,
    baseTfSell: false
  });
  assert.notEqual(case3.action, 'SELL', 'Case 3 failed: moderate drawdown should not SELL 100%');

  const case3b = runPortfolioCase({
    ageMinutes: 500,
    currentRoi: -2.0,
    decisionPct: 80,
    riskHeavy: true,
    higherTfSell: true,
    baseTfSell: true,
    currentPrice: 8.598,
    totalQty: 2.08273518
  });
  assert.equal(case3b.action, 'SELL', 'Case 3b failed: high risk defensive sell should remain SELL');
  assert.equal(Number(case3b.positionPct), 100, 'Case 3b failed: non-operable residual should force SELL 100%');

  const sizingPlan = buildExecutableOrderSize({
    decision: {
      symbol: 'XRP-USD',
      action: 'SELL',
      positionPct: 100,
      orderType: 'limit',
      limitPrice: 1.3941
    },
    balanceArray: [{ currency: 'XRP', total: 29.2043 }],
    openOrders: [],
    realAvailableBalances: {
      availableByCurrency: {
        XRP: 29.2043,
        USD: 0
      }
    },
    indicators: {
      'XRP-USD': {
        currentPrice: 1.3948
      }
    },
    managedPositions: [{ symbol: 'XRP-USD', qty: 29.2043 }],
    maxTradeSizePct: 25
  });

  assert.ok(Number(sizingPlan.baseAmount) <= 29.2043, 'Case 4 failed: baseAmount exceeds available balance');

  const dryRunClient = {
    config: { debug: { dryRun: true } },
    post: async () => ({ data: {} }),
    get: async () => ({}),
    delete: async () => ({})
  };

  const orderManager = new OrderManager(dryRunClient);

  const sellLimit = await orderManager.placeOrder({
    symbol: 'XRP-USD',
    side: 'sell',
    type: 'limit',
    usdAmount: 40.71,
    baseAmount: sizingPlan.baseAmount,
    price: 1.3941,
    currentPrice: 1.3948
  });

  const sellLimitPrice = sellLimit.payload.order_configuration.limit.price;
  assert.equal(sellLimitPrice, '1.3941', 'Case 5 failed: price precision should keep 1.3941');

  const buyMarket = await orderManager.placeOrder({
    symbol: 'XRP-USD',
    side: 'buy',
    type: 'market',
    usdAmount: 100,
    price: null,
    currentPrice: 1.3948
  });

  assert.equal(
    buyMarket.payload.order_configuration.market.quote_size,
    '100.00',
    'Case 6 failed: BUY market must use quote_size'
  );

  assert.equal(
    sellLimit.payload.order_configuration.limit.base_size,
    Number(sizingPlan.baseAmount).toFixed(8),
    'Case 7 failed: SELL LIMIT must use base_size/baseAmount'
  );

  const applySellFnSrc = String(applySellToOpenLots);
  assert.ok(
    applySellFnSrc.includes('residualCloseBelowUsd'),
    'Case 8 failed: applySellToOpenLots should support residual close threshold'
  );

  console.log('Validation OK: 9/9 scenarios passed');
}

run().catch((err) => {
  console.error('Validation failed:', err.message);
  process.exitCode = 1;
});
