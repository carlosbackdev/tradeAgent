/**
 * agent/workflow/portfolio-guard.js
 * Portfolio health check: verifies drawdown is within acceptable limits
 * Prevents trading if portfolio has lost too much capital
 */

import { logger } from '../../utils/logger.js';

/**
 * DEPRECATED: This module is no longer used in the current workflow. The portfolio health check has been integrated directly into the executor cycle for more streamlined logic and better error handling. The checkPortfolioHealth function can still be imported and used if needed, but it is not called by default in the agent cycle.
 * Check if portfolio health is acceptable for trading
 * Drawdown is calculated as: (losses from this session) / (current portfolio value)
 * initialCapital is set to currentPortfolioValue at start of cycle (dynamic baseline)
 * @param {number} currentPortfolioValue - Current total portfolio value in USD
 * @param {number} maxDrawdownPct - Maximum allowed drawdown percentage (e.g., 10 for 10%)
 * @param {number} previousCycleValue - Portfolio value from previous cycle (optional, for tracking real losses)
 * @returns {Promise<{shouldTrade: boolean, drawdownPct: number, reason: string}>}
 */
export async function checkPortfolioHealth(currentPortfolioValue, maxDrawdownPct, previousCycleValue = null) {
  try {
    if (!currentPortfolioValue || currentPortfolioValue < 0) {
      logger.warn('⚠️ Invalid current portfolio value');
      return {
        shouldTrade: true,
        drawdownPct: 0,
        reason: 'Portfolio value unavailable, skipping guard'
      };
    }

    if (maxDrawdownPct === undefined || maxDrawdownPct === null || maxDrawdownPct <= 0) {
      logger.warn('⚠️ MAX_PORTFOLIO_STOPLOSS not configured or invalid');
      return {
        shouldTrade: true,
        drawdownPct: 0,
        reason: 'Max drawdown not configured, allowing trade'
      };
    }

    // Use previousCycleValue as reference, or current value if no history
    const referenceValue = previousCycleValue || currentPortfolioValue;
    
    // Calculate drawdown percentage from reference point
    const drawdown = referenceValue - currentPortfolioValue;
    const drawdownPct = referenceValue > 0 ? (drawdown / referenceValue) * 100 : 0;

    // Determine if we should continue trading
    const shouldTrade = drawdownPct <= maxDrawdownPct;

    if (shouldTrade) {
      logger.info(
        `💰 Portfolio health: ${drawdownPct.toFixed(2)}% drawdown ` +
        `(within limit of ${maxDrawdownPct}%) - TRADING ALLOWED`
      );
      return {
        shouldTrade: true,
        drawdownPct: parseFloat(drawdownPct.toFixed(2)),
        reason: `Drawdown ${drawdownPct.toFixed(2)}% is within limit`
      };
    } else {
      const exceedBy = drawdownPct - maxDrawdownPct;
      logger.error(
        `🚨 PORTFOLIO STOPLOSS TRIGGERED\n` +
        `Drawdown: ${drawdownPct.toFixed(2)}% (Limit: ${maxDrawdownPct}%)\n` +
        `Exceeded by: ${exceedBy.toFixed(2)}%\n` +
        `Reference Value: $${referenceValue.toFixed(2)}\n` +
        `Current Value: $${currentPortfolioValue.toFixed(2)}\n` +
        `Loss: $${drawdown.toFixed(2)}`
      );
      return {
        shouldTrade: false,
        drawdownPct: parseFloat(drawdownPct.toFixed(2)),
        reason: `Drawdown ${drawdownPct.toFixed(2)}% exceeds limit of ${maxDrawdownPct}% - TRADING PAUSED`
      };
    }
  } catch (err) {
    logger.error(`Portfolio guard check failed: ${err.message}`, err);
    // On error, allow trading but log the issue
    return {
      shouldTrade: true,
      drawdownPct: 0,
      reason: `Portfolio guard error: ${err.message}`
    };
  }
}
