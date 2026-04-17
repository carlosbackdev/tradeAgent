/**
 * telegram/utils.js
 * Telegram utilities and .env helpers
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

const ENV_PATH = path.join(process.cwd(), '.env');

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

export function readEnvFile() {
  try {
    const env = {};
    fs.readFileSync(ENV_PATH, 'utf-8').split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const [key, ...rest] = line.split('=');
      if (key) env[key.trim()] = rest.join('=').trim();
    });
    return env;
  } catch { return {}; }
}

export function updateEnvFile(key, value) {
  try {
    let content = fs.readFileSync(ENV_PATH, 'utf-8');
    const regex = new RegExp(`^${key}=.*$`, 'm');
    content = regex.test(content)
      ? content.replace(regex, `${key}=${value}`)
      : content + `\n${key}=${value}`;
    fs.writeFileSync(ENV_PATH, content, 'utf-8');
    process.env[key] = value;
    return true;
  } catch (err) {
    logger.error(`updateEnvFile failed:`, err.message);
    return false;
  }
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
