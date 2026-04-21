/**
 * telegram/handles.js
 * High-level notification handlers.
 */

import { send } from './telegram.js';

/**
 * Send a standard notification (truncates at 4096 chars — Telegram limit).
 */
export async function notify(text, chatId = null) {
  const MAX = 4096;
  if (text.length > MAX) {
    await send(text.slice(0, MAX - 20) + '\n...<truncated>', chatId);
  } else {
    await send(text, chatId);
  }
}

/**
 * Send an error alert with 🚨 prefix.
 */
export async function notifyError(message, chatId = null) {
  await send(`🚨 ERROR\n${message}`, chatId);
}

/**
 * Send an order execution confirmation.
 */
export async function notifyOrderExecuted({ symbol, side, qty, usdAmount, price }, chatId = null) {
  const emoji = side === 'buy' || side === 'BUY' ? '🟢' : '🔴';
  const action = side === 'buy' || side === 'BUY' ? 'COMPRA' : 'VENTA';

  const message = `${emoji} *Orden Ejecutada*
  
💱 ${symbol}
📊 Acción: *${action}*
💰 Monto: $${usdAmount}
📈 Cantidad: ${qty}
💵 Precio: $${price}

✅ Orden completada exitosamente`;

  await send(message, chatId);
}