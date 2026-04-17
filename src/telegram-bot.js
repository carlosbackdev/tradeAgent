/**
 * src/telegram-bot.js
 * Telegram bot with long-polling.
 *
 */
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { runAgentCycle } from './agent/executor.js';
import { logger } from './utils/logger.js';
import { TelegramHandlers } from './telegram/telegram-handlers.js';
import { TelegramCommands } from './telegram/commands.js';
import { config } from './config/config.js';

// ── Cron state (module-level singleton) ──────────────────────────
let cronTask = null;   // node-cron scheduled task

// ── Update offset for long polling ───────────────────────────────
let updateOffset = 0;
let isPolling = false;  // Prevent concurrent polling

// ── Context for Handlers ─────────────────────────────────────────
const botContext = {
  sendMessage: (t, r) => sendMessage(t, r),
  editMessage: (m, t, r) => editMessage(m, t, r),
  answerCallback: (c, t) => answerCallback(c, t),
  readEnvFile: () => process.env, // Provide env vars for reading in configuration panel
  updateEnvFile: (k, v) => config.update(k, v),
  startCron: (s) => startCron(s),
  stopCron: () => stopCron(),
  getCronStatus: () => getCronStatus(),
  get cronSchedule() { return config.cron.schedule; },
  set cronSchedule(s) { config.update('CRON_SCHEDULE', s); }
};

const handlers = new TelegramHandlers(botContext);
const commandsRouter = new TelegramCommands(handlers, sendMessage);

// ─────────────────────────────────────────────────────────────────
//  Telegram helpers
// ─────────────────────────────────────────────────────────────────

async function telegramRequest(method, payload) {
  const url = `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

async function sendMessage(text, replyMarkup = null) {
  if (!text?.trim()) return;
  const payload = { chat_id: config.telegram.chatId, text: text.trim(), parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegramRequest('sendMessage', payload).catch(err =>
    logger.error('Telegram sendMessage failed:', err.message)
  );
}

async function editMessage(messageId, text, replyMarkup = null) {
  const payload = { chat_id: config.telegram.chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegramRequest('editMessageText', payload).catch(err =>
    logger.error('Telegram editMessage failed:', err.message)
  );
}

async function answerCallback(callbackQueryId, text = '✅') {
  return telegramRequest('answerCallbackQuery', {
    callback_query_id: callbackQueryId, text, show_alert: false,
  }).catch(() => { });
}

// ─────────────────────────────────────────────────────────────────
//  Cron management
// ─────────────────────────────────────────────────────────────────

function startCron(schedule) {
  if (cronTask) { cronTask.stop(); cronTask = null; }

  if (!cron.validate(schedule)) {
    logger.error(`Invalid cron expression: ${schedule}`);
    return false;
  }

  cronTask = cron.schedule(schedule, async () => {
    logger.info(`⏰ Cron triggered: ${schedule}`);
    try {
      const pairs = config.trading.pairs;
      for (const coin of pairs) {
        logger.info(`🔄 Processing coin: ${coin}`);
        await runAgentCycle('cron', coin);
      }
    } catch (err) {
      logger.error('Cron cycle failed:', err.message);
    }
  });

  config.update('CRON_ENABLED', 'true');
  config.update('CRON_SCHEDULE', schedule);
  logger.info(`✅ Cron started: ${schedule}`);
  return true;
}

function stopCron() {
  if (cronTask) { cronTask.stop(); cronTask = null; }
  config.update('CRON_ENABLED', 'false');
  logger.info('⏹ Cron stopped');
}

function getCronStatus() {
  const next = config.cron.enabled && config.cron.schedule
    ? `Próximo ciclo según: >${config.cron.schedule}>`
    : 'Desactivado';
  return {
    enabled: config.cron.enabled,
    schedule: config.cron.schedule,
    next,
  };
}

// ─────────────────────────────────────────────────────────────────
//  Long polling loop
// ─────────────────────────────────────────────────────────────────

async function getUpdates() {
  try {
    const url = `https://api.telegram.org/bot${config.telegram.botToken}/getUpdates?offset=${updateOffset}&timeout=25`;
    const res = await fetch(url);
    if (!res.ok) return [];

    const parsed = await res.json();
    return parsed.result || [];
  } catch (err) {
    return [];
  }
}

async function processUpdates() {
  if (isPolling) return;  // Skip if already polling
  isPolling = true;

  try {
    const updates = await getUpdates();

    for (const update of updates) {
      updateOffset = update.update_id + 1;

      try {
        // ── Text messages ───────────────────────────────────────────
        if (update.message?.text) {
          await commandsRouter.processTextMessage(update.message);
        }

        // ── Callbacks ────────────────────────────────────────────────
        if (update.callback_query) {
          const { id, data, message } = update.callback_query;
          await handlers.handleCallback(id, data, message?.message_id);
        }

      } catch (err) {
        if (!err.message?.includes('409')) {
          logger.error('Error processing update:', err.message);
        }
      }
    }
  } catch (err) {
    logger.error('Error in processUpdates:', err.message);
  } finally {
    isPolling = false;
  }
}

// ─────────────────────────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────────────────────────

export async function startTelegramBot() {
  if (!config.telegram.botToken || !config.telegram.chatId) {
    logger.warn('⚠️ Telegram not configured (missing BOT_TOKEN or CHAT_ID)');
    return;
  }

  logger.info('🤖 Starting Telegram bot...');

  // Auto-start cron if enabled in env
  if (config.cron.enabled && cron.validate(config.cron.schedule)) {
    startCron(config.cron.schedule);
    logger.info(`⏰ Auto-started cron: ${config.cron.schedule}`);
  }

  await handlers.handleInit().catch(() => { });

  // Sequential long polling (waits for each cycle to complete before starting next)
  const startPolling = async () => {
    while (true) {
      await processUpdates();
      // Small delay to prevent tight loop and rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  };

  startPolling().catch(err => logger.error('Polling loop error:', err));
}

export { startCron, stopCron, getCronStatus };
export default startTelegramBot;