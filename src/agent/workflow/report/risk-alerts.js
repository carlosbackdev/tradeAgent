/**
 * workflow/report/risk-alerts.js
 * Telegram alerts for execution failures and defensive sells.
 */

import { notify } from '../../../telegram/handles.js';

export async function notifyDefensiveSell(decision, usdAmount, chatId = null) {
  const pct = Number(decision?.positionPct || 0) * 100;
  const reason = decision?.defensiveReason || 'RISK_DEFENSE';
  const message = [
    'ALERTA RIESGO',
    `Simbolo: ${decision?.symbol || 'N/A'}`,
    'Evento: SELL defensivo ejecutado',
    `Tamano: ${pct.toFixed(0)}% | Monto: $${Number(usdAmount || 0).toFixed(2)}`,
    `Razon: ${reason}`
  ].join('\n');

  await notify(message, chatId);
}

export async function notifyExchangeRejection(decision, errorMessage, chatId = null) {
  const msg = String(errorMessage || 'Unknown exchange rejection');
  const message = [
    'ALERTA EXCHANGE',
    `Simbolo: ${decision?.symbol || 'N/A'}`,
    `Accion: ${decision?.action || 'N/A'}`,
    `Motivo: ${truncate(msg, 260)}`
  ].join('\n');

  await notify(message, chatId);
}

export function isExchangeRejectionError(errorMessage) {
  const text = String(errorMessage || '').toLowerCase();
  return text.includes('422') ||
    text.includes('insufficient') ||
    text.includes('insuf') ||
    text.includes('rejected') ||
    text.includes('reject') ||
    text.includes('invalid');
}

function truncate(text, maxLen) {
  if (String(text).length <= maxLen) return String(text);
  return `${String(text).slice(0, maxLen - 3)}...`;
}
