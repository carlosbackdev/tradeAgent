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
export async function notifyOrderExecuted({ symbol, side, qty, orderType, usdAmount, price }, chatId = null) {
  const emoji = side === 'buy' || side === 'BUY' ? '🟢' : '🔴';
  const action = side === 'buy' || side === 'BUY' ? 'COMPRA' : 'VENTA';
  let orderComplete;
  if (orderType === 'market') {
    orderComplete = 'Orden completada exitosamente';
  } else {
    orderComplete = 'Orden abierta completada';
  }

  const message = `${emoji} <b>Orden Ejecutada</b>
  
💱 ${symbol}
📊 Acción: <b>${action}</b>
⚖️ Orden: <b>${orderType}</b>
💰 Monto: $${usdAmount}
📈 Cantidad: ${qty}
💵 Precio: $${price}

✅ ${orderComplete}`;
  await send(message, chatId);
}