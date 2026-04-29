/**
 * workflow/report/trading-report.js
 * Presentation helpers for trading execution reports and Telegram notifications.
 */

import { formatDecision } from '../../../utils/formatter.js';

export function buildTradingReport({ decision, execResults, elapsed, triggerReason }) {
  return formatDecision({ decision, execResults, elapsed, triggerReason });
}

export function buildExecutionNotificationPayload({
  decision,
  orderResult,
  usdAmount,
  currentPrice
}) {
  return {
    symbol: decision?.symbol,
    side: String(decision?.action || '').toLowerCase(),
    qty: orderResult?.qty || 'pte.',
    orderType: orderResult?.type || decision?.orderType || 'market',
    usdAmount: Number(usdAmount || 0).toFixed(2),
    price: Number(currentPrice || 0).toFixed(2)
  };
}

