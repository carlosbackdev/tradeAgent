/**
 * workflow/decision-engine.js
 * Checks for forced decisions (SL/TP) based on open FIFO lots and rendimiento
 */

import { logger } from '../../utils/logger.js';
import { getOpenPositionSummary } from '../../utils/mongodb.js';

export async function checkForcedDecisions(indicators, coin, balanceArray, config, dbConnected = false, chatId = null) {
  let forcedDecision = null;
  let rendimiento = null;

  if (dbConnected) {
    const baseCurrency = coin.split('-')[0];
    const baseBalance = parseFloat(balanceArray.find(b => b.currency === baseCurrency)?.total || 0);

    // Only consider forcing SL/TP if we actually hold the asset
    if (baseBalance > 0) {
      const currentPrice = indicators?.currentPrice;
      if (currentPrice) {
        const positionSummary = await getOpenPositionSummary(coin, currentPrice, chatId);

        if (positionSummary.openLots.length > 0) {
          rendimiento = positionSummary.unrealizedRoiPct;

          const tpPct = config.trading.takeProfitPct || 0;
          const slPct = config.trading.stopLossPct || 0;
          const usdWorth = baseBalance * currentPrice * 0.995; // 99.5% safety margin

          if (tpPct > 0 && rendimiento >= tpPct) {
            forcedDecision = {
              symbol: coin.replace('/', '-'),
              action: 'SELL',
              confidence: 100,
              reasoning: `Forced Take Profit met at +${rendimiento}% (Avg Entry: $${positionSummary.avgEntryPrice}, Current: $${currentPrice})`,
              orderType: 'market',
              usdAmount: parseFloat(usdWorth.toFixed(2))
            };
          } else if (slPct > 0 && rendimiento <= -slPct) {
            forcedDecision = {
              symbol: coin.replace('/', '-'),
              action: 'SELL',
              confidence: 100,
              reasoning: `Forced Stop Loss met at ${rendimiento}% (Avg Entry: $${positionSummary.avgEntryPrice}, Current: $${currentPrice})`,
              orderType: 'market',
              usdAmount: parseFloat(usdWorth.toFixed(2))
            };
          }
        } else {
          logger.info(`ℹ️  No open lots for ${baseCurrency} despite balance. Physical balance might be manual. No SL/TP forced.`);
        }
      }
    } else {
      logger.info(`ℹ️  No ${baseCurrency} balance — no SL/TP forced.`);
    }
  }

  return { forcedDecision, rendimiento };
}
