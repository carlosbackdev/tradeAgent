/**
 * utils/formatter.js
 * Format decision results and execution info for Telegram notifications.
 */

export function formatDecision({ decision, execResults, elapsed, triggerReason }) {
  let msg = `📊 Trading Agent Cycle\n`;
  msg += `⏱️ Elapsed: ${elapsed}s | 🎯 Trigger: ${triggerReason}\n\n`;

  msg += `🌍 Market Summary:\n${decision.marketSummary}\n\n`;

  msg += `⚡ Decisions:\n`;

  if (execResults.length === 0) {
    msg += `No trades executed this cycle.\n`;
  } else {
    for (const result of execResults) {
      const emoji = result.action === 'BUY' ? '🟢' : result.action === 'SELL' ? '🔴' : '⚪';
      msg += `\n${emoji} ${result.symbol}\n`;
      msg += `  • Action: ${result.action.toUpperCase()}\n`;
      msg += `  • Confidence: ${result.confidence}%\n`;
      // Show USD amount for executed/active orders, positionPct for HOLDs
      if (result.status === 'executed' && result.usdAmount) {
        msg += `  • Amount: $${Number(result.usdAmount).toFixed(2)}\n`;
      } else if (result.positionPct > 0) {
        msg += `  • Size: ${(result.positionPct * 100).toFixed(0)}% del balance\n`;
      }
      if (result.rendimiento != null) {
        const sign = result.rendimiento >= 0 ? '+' : '';
        msg += `  📈 Rendimiento: ${sign}${result.rendimiento.toFixed(2)}%\n`;
      }
      if (result.status === 'executed') {
        const qtyDisplay = result.orderResult?.qty || result.qty || 'pte.';
        msg += `  ✅ Status: EJECUTADO (${qtyDisplay})\n\n`;
      } else if (result.status === 'skipped') {
        msg += `  ⏭️ Status: SKIPPED (${result.reason})\n\n`;
      } else if (result.status === 'error') {
        msg += `  ❌ Status: ERROR (${result.error})\n\n`;
      }

      msg += `  💡 Reasoning: ${result.reasoning}\n`;
    }
  }

  return msg;
}
export function CronParse(expr) {
  if (expr === '*/5 * * * *') return 'cada 5 minutos';
  if (expr === '*/15 * * * *') return 'cada 15 minutos (predeterminado)';
  if (expr === '*/30 * * * *') return 'cada 30 minutos';
  if (expr === '0 * * * *') return 'cada hora';
  if (expr === '0 */2 * * *') return 'cada 2 horas';
  if (expr === '0 */3 * * *') return 'cada 3 horas';
  if (expr === '0 */4 * * *') return 'cada 4 horas';
  if (expr === '0 */8 * * *') return 'cada 8 horas';
  if (expr === '0 */12 * * *') return 'cada 12 horas';
  if (expr === '0 0 * * *') return 'cada día (00:00)';
}