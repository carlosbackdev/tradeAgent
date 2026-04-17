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
      msg += `\n🔸 ${result.symbol}\n`;
      msg += `  • Action: ${result.action.toUpperCase()}\n`;
      msg += `  • Confidence: ${result.confidence}%\n`;
      msg += `  • Amount: $${result.usdAmount}\n`;
      if (result.rendimiento !== undefined) {
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
  if (expr === '0 */4 * * *') return 'cada 4 horas';
}