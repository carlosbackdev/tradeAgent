/**
 * telegram.js
 * Low-level Telegram API communication.
 */

const BASE = 'https://api.telegram.org';

export async function send(text) {
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
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[telegram] Failed to send: ${err}`);
  }
}