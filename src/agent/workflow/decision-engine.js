/**
 * workflow/decision-engine.js
 * Checks for forced decisions (SL/TP) based on last order and rendimiento
 */

import { logger } from '../../utils/logger.js';

export async function checkForcedDecisions(lastOrder, indicators, coin, balanceArray, config, dbConnected = false) {
  let forcedDecision = null;
  let rendimiento = null;

  if (lastOrder && lastOrder.side === 'buy') {
    const baseCurrency = coin.split('-')[0];
    const baseBalance = parseFloat(balanceArray.find(b => b.currency === baseCurrency)?.total || 0);

    // Only consider the lastOrder valid if we actually hold the asset
    if (baseBalance > 0) {
      const currentPrice = indicators?.currentPrice;
      if (currentPrice && lastOrder.price) {
        const pnlPct = ((currentPrice - lastOrder.price) / lastOrder.price) * 100;
        rendimiento = parseFloat(pnlPct.toFixed(2));

        const tpPct = config.trading.takeProfitPct || 0;
        const slPct = config.trading.stopLossPct || 0;
        const usdWorth = baseBalance * currentPrice * 0.995; // 99.5% safety margin

        if (tpPct > 0 && pnlPct >= tpPct) {
          forcedDecision = {
            symbol: coin.replace('/', '-'),
            action: 'SELL',
            confidence: 100,
            reasoning: `Forced Take Profit met at +${pnlPct.toFixed(2)}% (Entry: $${lastOrder.price}, Current: $${currentPrice})`,
            orderType: 'market',
            usdAmount: parseFloat(usdWorth.toFixed(2))
          };
        } else if (slPct > 0 && pnlPct <= -slPct) {
          forcedDecision = {
            symbol: coin.replace('/', '-'),
            action: 'SELL',
            confidence: 100,
            reasoning: `Forced Stop Loss met at ${pnlPct.toFixed(2)}% (Entry: $${lastOrder.price}, Current: $${currentPrice})`,
            orderType: 'market',
            usdAmount: parseFloat(usdWorth.toFixed(2))
          };
        }
      }
    } else {
      logger.info(`ℹ️  No ${baseCurrency} balance — lastOrder from ${lastOrder.created_at?.toISOString?.() || '?'} treated as closed`);
    }
  }

  return { forcedDecision, rendimiento };
}
