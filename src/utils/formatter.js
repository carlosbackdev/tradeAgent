/**
 * utils/formatter.js
 * Format decision results and execution info for Telegram notifications.
 */

export function formatDecision({ decision, execResults, elapsed, triggerReason }) {
  let msg = `📊 Trading Agent Cycle\n`;
  msg += `⏱️ Elapsed: ${elapsed}s | Trigger: ${triggerReason}\n\n`;

  msg += `Market Summary:\n${decision.marketSummary}\n\n`;

  msg += `Decisions Executed:\n`;

  if (execResults.length === 0) {
    msg += `No trades executed this cycle.\n`;
  } else {
    for (const result of execResults) {
      msg += `\n${result.symbol}\n`;
      msg += `  Action: ${result.action}\n`;
      msg += `  Status: ${result.status}\n`;
      msg += `  Confidence: ${result.confidence}%\n`;
      msg += `  USD Amount: $${result.usdAmount}\n`;

      if (result.status === 'executed') {
        msg += `  ✅ Qty: ${result.qty}\n`;
      } else if (result.status === 'skipped') {
        msg += `  ⏭️  ${result.reason}\n`;
      } else if (result.status === 'error') {
        msg += `  ❌ ${result.error}\n`;
      }

      msg += `  Reasoning: ${result.reasoning}\n`;
    }
  }

  return msg;
}
export function CronParse(expr) {
   if(expr === '*/5 * * * *') return 'cada 5 minutos';
  if(expr === '*/15 * * * *') return 'cada 15 minutos (predeterminado)';
  if(expr === '0 * * * *') return 'cada hora';
  if(expr === '0 */4 * * *') return 'cada 4 horas';
}