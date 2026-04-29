/**
 * workflow/report/risk-alerts.js
 * Telegram alerts for risk blocks and execution failures.
 */

import { notify } from '../../../telegram/handles.js';

export async function notifyHoldBlocked(decision, chatId = null) {
  const reason = decision?.summaryReasoning || decision?.reasoning || 'HOLD por bloqueo de riesgo';
  const message = [
    '🛡️ ALERTA RIESGO',
    `Símbolo: ${decision?.symbol || 'N/A'}`,
    'Evento: HOLD por bloqueo',
    `Motivo: ${truncate(reason, 240)}`
  ].join('\n');

  await notify(message, chatId);
}

export async function notifyDefensiveSell(decision, usdAmount, chatId = null) {
  const pct = Number(decision?.positionPct || 0) * 100;
  const reason = decision?.defensiveReason || 'RISK_DEFENSE';
  const message = [
    '🛡️ ALERTA RIESGO',
    `Símbolo: ${decision?.symbol || 'N/A'}`,
    'Evento: SELL defensivo ejecutado',
    `Tamaño: ${pct.toFixed(0)}% | Monto: $${Number(usdAmount || 0).toFixed(2)}`,
    `Razón: ${reason}`
  ].join('\n');

  await notify(message, chatId);
}

export async function notifyExchangeRejection(decision, errorMessage, chatId = null) {
  const msg = String(errorMessage || 'Unknown exchange rejection');
  const message = [
    '🚫 ALERTA EXCHANGE',
    `Símbolo: ${decision?.symbol || 'N/A'}`,
    `Acción: ${decision?.action || 'N/A'}`,
    `Motivo: ${truncate(msg, 260)}`
  ].join('\n');

  await notify(message, chatId);
}

export function isBlockedHoldDecision(decision) {
  if (String(decision?.action || '').toUpperCase() !== 'HOLD') return false;
  const text = `${decision?.summaryReasoning || ''} ${decision?.reasoning || ''}`.toLowerCase();
  return text.includes('bloque') || text.includes('cooldown') || text.includes('riesgo') || text.includes('drawdown');
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

