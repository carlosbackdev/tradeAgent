/**
 * workflow/decision-engine.js
 * Checks for forced decisions (SL/TP) based on open FIFO lots and rendimiento
 */

import { logger } from '../../utils/logger.js';
import { getOpenPositionSummary } from '../../services/mongo/mongo-service.js';

export async function checkForcedDecisions(indicators, coin, balanceArray, realAvailableBalances, config, dbConnected = false, chatId = null) {
  let forcedDecision = null;
  let rendimiento = null;
  const forcedExitMinUsd = resolveMinForcedExitUsd(config);

  if (dbConnected) {
    const baseCurrency = coin.split('-')[0];
    const baseBalance = parseFloat(realAvailableBalances?.availableByCurrency?.[baseCurrency] || 0);

    // Only consider forcing SL/TP if we actually hold the asset
    if (baseBalance > 0) {
      const currentPrice = indicators?.currentPrice;
      if (currentPrice) {
        const positionSummary = await getOpenPositionSummary(coin, currentPrice, chatId);

        if (positionSummary.openLots.length > 0) {
          rendimiento = positionSummary.unrealizedRoiPct;

          const tpPct = config.trading.takeProfitPct || 0;
          const slPct = config.trading.stopLossPct || 0;
          const sellBuffer = Number(config?.trading?.sellSizeBuffer || 0.999);
          const bufferedQty = Math.floor(baseBalance * sellBuffer * 100000000) / 100000000;
          const usdWorth = bufferedQty * currentPrice;

          if (usdWorth < forcedExitMinUsd) {
            logger.info(`ℹ️  Forced exit ignored as dust for ${coin}: estUsd=$${usdWorth.toFixed(6)} < $${forcedExitMinUsd}`);
            return { forcedDecision: null, rendimiento };
          }

          if (tpPct > 0 && rendimiento >= tpPct) {
            forcedDecision = {
              symbol: coin.replace('/', '-'),
              action: 'SELL',
              confidence: 100,
              reasoning: `Forced Take Profit met at +${rendimiento}% (Avg Entry: $${positionSummary.avgEntryPrice}, Current: $${currentPrice})`,
              orderType: 'market',
              usdAmount: parseFloat(usdWorth.toFixed(2)),
              baseAmount: bufferedQty,
              forced: true,
              forcedReason: 'TAKE_PROFIT'
            };
          } else if (slPct > 0 && rendimiento <= -slPct) {
            forcedDecision = {
              symbol: coin.replace('/', '-'),
              action: 'SELL',
              confidence: 100,
              reasoning: `Forced Stop Loss met at ${rendimiento}% (Avg Entry: $${positionSummary.avgEntryPrice}, Current: $${currentPrice})`,
              orderType: 'market',
              usdAmount: parseFloat(usdWorth.toFixed(2)),
              baseAmount: bufferedQty,
              forced: true,
              forcedReason: 'STOP_LOSS'
            };
          }
        } else {
          logger.info(`ℹ️  No open lots for ${baseCurrency} despite balance. Physical balance might be manual. No SL/TP forced.`);
        }
      }
    } else {
      logger.info(`ℹ️  No disponible ${baseCurrency} balance — no SL/TP forced.`);
    }
  }

  return { forcedDecision, rendimiento };
}

function resolveMinForcedExitUsd(config) {
  const n = Number(config?.trading?.forcedExitMinUsd ?? config?.trading?.dustIgnoreUsd ?? 0.1);
  if (!Number.isFinite(n) || n <= 0) return 0.1;
  return n;
}
