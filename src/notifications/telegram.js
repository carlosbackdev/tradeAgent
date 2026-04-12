/**
 * notifications/telegram.js
 * Sends messages to a Telegram chat via Bot API.
 * Uses HTML parse mode for clean formatting.
 */

const BASE = 'https://api.telegram.org';

async function send(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error(`[telegram] Missing BOT_TOKEN or CHAT_ID`);
  }

  const url = `${BASE}/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[telegram] Failed to send: ${err}`);
  }
}

/**
 * Send a standard notification (truncates at 4096 chars — Telegram limit).
 */
export async function notify(text) {
  const MAX = 4096;
  if (text.length > MAX) {
    await send(text.slice(0, MAX - 20) + '\n...<truncated>');
  } else {
    await send(text);
  }
}

/**
 * Send an error alert with 🚨 prefix.
 */
export async function notifyError(message) {
  await send(`🚨 ERROR\n${message}`);
}
