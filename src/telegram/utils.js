/**
 * telegram/utils.js
 * Telegram utilities
 */

import https from 'https';
import { logger } from '../utils/logger.js';

export function telegramRequest(botToken, method, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${botToken}/${method}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': data.length },
    };

    const req = https.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const parsed = JSON.parse(body);
        if (res.statusCode === 200) resolve(parsed);
        else reject(new Error(`HTTP ${res.statusCode}: ${body}`));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export function createTelegramHelpers(botToken, chatId) {
  return {
    async sendMessage(text, replyMarkup = null) {
      if (!text || typeof text !== 'string') return;
      const trimmed = text.trim();
      if (!trimmed) return;
      const payload = { chat_id: chatId, text: trimmed };
      if (replyMarkup) payload.reply_markup = replyMarkup;
      return telegramRequest(botToken, 'sendMessage', payload).catch(err =>
        logger.error('Telegram sendMessage failed:', err.message)
      );
    },

    async editMessage(messageId, text, replyMarkup = null) {
      const payload = { chat_id: chatId, message_id: messageId, text };
      if (replyMarkup) payload.reply_markup = replyMarkup;
      return telegramRequest(botToken, 'editMessageText', payload).catch(err =>
        logger.error('Telegram editMessage failed:', err.message)
      );
    },

    async answerCallback(callbackQueryId, text = '✅') {
      return telegramRequest(botToken, 'answerCallbackQuery', {
        callback_query_id: callbackQueryId, text, show_alert: false,
      }).catch(() => {});
    },
  };
}

export function getUpdates(botToken, updateOffset) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${botToken}/getUpdates?offset=${updateOffset}&timeout=25`,
      method:   'GET',
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body).result || []); }
        catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}
