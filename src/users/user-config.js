/**
 * users/user-config.js
 * Builds a per-user config object compatible with the existing Config class.
 * Each user has their own isolated configuration stored in MongoDB.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

/**
 * Build a runtime config object for a specific user.
 * This replaces the global config for per-user bot instances.
 */
export function buildUserConfig(user) {
  const cfg = user.config || {};

  // Write the user's private key to a temp file (Revolut client needs a file path)
  let privateKeyPath = null;
  if (cfg.REVOLUT_PRIVATE_KEY_PEM) {
    privateKeyPath = writeUserPrivateKey(user.telegram_id, cfg.REVOLUT_PRIVATE_KEY_PEM);
  }

  const parseNum = (val, fallback) => {
    const n = parseFloat(String(val || '').replace(',', '.'));
    return isNaN(n) ? fallback : n;
  };

  return {
    chatId: user.telegram_id,
    revolut: {
      apiKey: cfg.REVOLUT_API_KEY || '',
      baseUrl: cfg.REVOLUT_BASE_URL || 'https://sandbox-trading.revolut.com/api/1.0',
      privateKeyPath: privateKeyPath || cfg.REVOLUT_PRIVATE_KEY_PATH || '',
    },
    anthropic: {
      apiKey: cfg.ANTHROPIC_API_KEY || '',
      model: cfg.ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
    },
    telegram: {
      // User interacts via the shared bot token; chatId is their own ID
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: user.telegram_id,
    },
    trading: {
      pairs: (cfg.TRADING_PAIRS || 'BTC-USD')
        .split(',')
        .map(p => p.trim())
        .filter(Boolean),
      maxTradeSize: parseNum(cfg.MAX_TRADE_SIZE, 0.10),
      minOrderUsd: parseNum(cfg.MIN_ORDER, 50),
      takeProfitPct: parseNum(cfg.TAKE_PROFIT_PCT, 0),
      stopLossPct: parseNum(cfg.STOP_LOSS_PCT, 0),
      visionAgent: cfg.VISION_AGENT || 'short',
      personalityAgent: cfg.PERSONALITY_AGENT || 'moderate',
    },
    cron: {
      enabled: cfg.CRON_ENABLED === 'true',
      schedule: cfg.CRON_SCHEDULE || '*/15 * * * *',
    },
    indicators: {
      candlesInterval: parseInt(cfg.INDICATORS_CANDLES_INTERVAL || '5') || 5,
    },
    debug: {
      dryRun: cfg.DRY_RUN === 'true',
      logLevel: cfg.LOG_LEVEL || 'info',
      debugApi: cfg.DEBUG_API === 'true',
    },
    mongodb: {
      uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
      dbName: process.env.MONGODB_DB || 'revolut-trading-agent',
    },
    // User metadata
    _userId: user.telegram_id,
    _username: user.telegram_username,

    // Helpers compatible with existing Config class API
    getRaw(key) {
      // Return stored value first, then known defaults
      if (cfg[key] !== undefined && cfg[key] !== null && cfg[key] !== '') return String(cfg[key]);
      const defaults = {
        'REVOLUT_BASE_URL': process.env.REVOLUT_BASE_URL || 'https://trading.revolut.com/api/1.0',
        'ANTHROPIC_MODEL': process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
        'VISION_AGENT': process.env.VISION_AGENT || 'short',
        'PERSONALITY_AGENT': process.env.PERSONALITY_AGENT || 'moderate',
        'TRADING_PAIRS': process.env.TRADING_PAIRS || 'BTC-USD',
        'MAX_TRADE_SIZE': process.env.MAX_TRADE_SIZE || '0.1',
        'MIN_ORDER': process.env.MIN_ORDER || '50',
        'TAKE_PROFIT_PCT': process.env.TAKE_PROFIT_PCT || '0',
        'STOP_LOSS_PCT': process.env.STOP_LOSS_PCT || '0',
        'INDICATORS_CANDLES_INTERVAL': process.env.INDICATORS_CANDLES_INTERVAL || '15',
      };
      return defaults[key] ?? '';
    },
    update(key, value) {
      cfg[key] = value;
      // Persist async (fire and forget)
      import('./user-registry.js').then(({ updateUserConfig }) => {
        updateUserConfig(user.telegram_id, { [key]: value }).catch(() => { });
      });
      return true;
    },
    // Keys a regular user can edit (no shared Telegram credentials)
    get editableKeys() {
      return ['REVOLUT_API_KEY', 'REVOLUT_BASE_URL', 'REVOLUT_PRIVATE_KEY_PATH', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'];
    },
    // Additional keys only visible to admin
    get editableKeysAdmin() {
      return ['REVOLUT_API_KEY', 'REVOLUT_BASE_URL', 'REVOLUT_PRIVATE_KEY_PATH', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
    },
    get editableKeysAgent() {
      return ['VISION_AGENT', 'PERSONALITY_AGENT', 'TRADING_PAIRS', 'MAX_TRADE_SIZE', 'MIN_ORDER', 'TAKE_PROFIT_PCT', 'STOP_LOSS_PCT', 'INDICATORS_CANDLES_INTERVAL'];
    },
  };
}

/**
 * Validate a user's config before activating their bot instance.
 * Returns { ok, missing[] }
 */
export function validateUserConfig(userConfig) {
  const missing = [];
  if (!userConfig.revolut.apiKey) missing.push('REVOLUT_API_KEY');
  if (!userConfig.revolut.privateKeyPath) missing.push('REVOLUT_PRIVATE_KEY_PEM');
  if (!userConfig.anthropic.apiKey) missing.push('ANTHROPIC_API_KEY');
  if (!userConfig.trading.pairs.length) missing.push('TRADING_PAIRS');
  return { ok: missing.length === 0, missing };
}

/**
 * Write a user's private key PEM to a temp file.
 * Returns the file path.
 */
function writeUserPrivateKey(telegramId, pem) {
  const dir = path.join(os.tmpdir(), 'revolut-agent-keys');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const filename = `user_${telegramId}_${crypto.createHash('md5').update(telegramId).digest('hex').slice(0, 8)}.pem`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, pem, { mode: 0o600 });
  return filepath;
}
