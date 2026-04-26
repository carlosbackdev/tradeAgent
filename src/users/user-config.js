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
  const isAdmin = process.env.ADMIN_TELEGRAM_ID && String(user.telegram_id) === String(process.env.ADMIN_TELEGRAM_ID);

  // Write the user's private key to a temp file
  let privateKeyPath = null;
  const privateKeyPem = cfg.REVOLUT_PRIVATE_KEY_PEM || (isAdmin ? process.env.REVOLUT_PRIVATE_KEY_PEM : null);

  if (privateKeyPem) {
    privateKeyPath = writeUserPrivateKey(user.telegram_id, privateKeyPem);
  }

  const parseNum = (val, fallback) => {
    const n = parseFloat(String(val || '').replace(',', '.'));
    return isNaN(n) ? fallback : n;
  };

  const parseMaxTradeSize = (val, fallback) => {
    let n = parseFloat(String(val || '').replace(',', '.'));
    if (isNaN(n) || n <= 0) return fallback;

    // Auto-migrate legacy decimal configs (e.g. 0.25 -> 25%, 1 -> 100%)
    if (n <= 1) {
      n = n * 100;
    }

    return Math.min(100, n);
  };

  // Admin specifics for fallbacks
  const getEnv = (key, fallback = '') => process.env[key] || fallback;

  return {
    chatId: user.telegram_id,
    revolut: {
      apiKey: cfg.REVOLUT_API_KEY || (isAdmin ? getEnv('REVOLUT_API_KEY') : ''),
      baseUrl: cfg.REVOLUT_BASE_URL || (isAdmin ? getEnv('REVOLUT_BASE_URL') : 'https://revx.revolut.com'),
      privateKeyPath: privateKeyPath || cfg.REVOLUT_PRIVATE_KEY_PATH || (isAdmin ? getEnv('REVOLUT_PRIVATE_KEY_PATH') : ''),
    },
    // LLM config — API key is stored per-provider (AI_PROVIDER_API_KEY_<PROVIDER>)
    llm: (() => {
      const provider = cfg.AI_PROVIDER || (isAdmin ? getEnv('AI_PROVIDER') : 'anthropic');
      const providerKey = `AI_PROVIDER_API_KEY_${provider.toUpperCase()}`;
      // Prefer provider-specific key, fall back to legacy generic key for backwards compat
      const apiKey =
        cfg[providerKey] ||
        (isAdmin ? getEnv(providerKey) : '') ||
        cfg.AI_PROVIDER_API_KEY ||
        (isAdmin ? getEnv('AI_PROVIDER_API_KEY') : '');
      return {
        apiKey,
        model: cfg.AI_MODEL || (isAdmin ? getEnv('AI_MODEL') : 'claude-haiku-4-5'),
        provider,
      };
    })(),
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: user.telegram_id,
    },
    trading: {
      pairs: (cfg.TRADING_PAIRS || (isAdmin ? getEnv('TRADING_PAIRS', 'BTC-USD') : 'BTC-USD'))
        .split(',')
        .map(p => p.trim())
        .filter(Boolean),
      maxTradeSize: parseMaxTradeSize(cfg.MAX_TRADE_SIZE || (isAdmin ? getEnv('MAX_TRADE_SIZE') : ''), 10),
      minOrderUsd: parseNum(cfg.MIN_ORDER || (isAdmin ? getEnv('MIN_ORDER') : ''), 50),
      takeProfitPct: parseNum(cfg.TAKE_PROFIT_PCT || (isAdmin ? getEnv('TAKE_PROFIT_PCT') : ''), 0),
      stopLossPct: parseNum(cfg.STOP_LOSS_PCT || (isAdmin ? getEnv('STOP_LOSS_PCT') : ''), 0),
      visionAgent: cfg.VISION_AGENT || (isAdmin ? getEnv('VISION_AGENT') : 'short'),
      personalityAgent: cfg.PERSONALITY_AGENT || (isAdmin ? getEnv('PERSONALITY_AGENT') : 'moderate'),
    },
    cron: {
      enabled: (cfg.CRON_ENABLED || (isAdmin ? getEnv('CRON_ENABLED') : 'false')) === 'true',
      schedule: cfg.CRON_SCHEDULE || (isAdmin ? getEnv('CRON_SCHEDULE') : '*/15 * * * *'),
    },
    indicators: {
      candlesInterval: parseInt(cfg.INDICATORS_CANDLES_INTERVAL || (isAdmin ? getEnv('INDICATORS_CANDLES_INTERVAL') : '5')) || 5,
    },
    debug: {
      dryRun: (cfg.DRY_RUN || (isAdmin ? getEnv('DRY_RUN') : 'false')) === 'true',
      logLevel: cfg.LOG_LEVEL || (isAdmin ? getEnv('LOG_LEVEL') : 'info'),
      debugApi: (cfg.DEBUG_API || (isAdmin ? getEnv('DEBUG_API') : 'false')) === 'true',
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
      // For the generic AI_PROVIDER_API_KEY, resolve from current provider-specific key
      if (key === 'AI_PROVIDER_API_KEY') {
        const provider = cfg.AI_PROVIDER || process.env.AI_PROVIDER || 'anthropic';
        const providerKey = `AI_PROVIDER_API_KEY_${provider.toUpperCase()}`;
        const providerVal = cfg[providerKey] || process.env[providerKey] || '';
        if (providerVal) return providerVal;
        return cfg.AI_PROVIDER_API_KEY || process.env.AI_PROVIDER_API_KEY || '';
      }
      // Return stored value first, then known defaults
      if (cfg[key] !== undefined && cfg[key] !== null && cfg[key] !== '') return String(cfg[key]);
      const defaults = {
        'REVOLUT_BASE_URL': process.env.REVOLUT_BASE_URL || 'https://trading.revolut.com/api/1.0',
        'AI_MODEL': process.env.AI_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
        'AI_PROVIDER': process.env.AI_PROVIDER || 'anthropic',
        'VISION_AGENT': process.env.VISION_AGENT || 'short',
        'PERSONALITY_AGENT': process.env.PERSONALITY_AGENT || 'moderate',
        'TRADING_PAIRS': process.env.TRADING_PAIRS || 'BTC-USD',
        'MAX_TRADE_SIZE': process.env.MAX_TRADE_SIZE || '10',
        'MIN_ORDER': process.env.MIN_ORDER || '50',
        'TAKE_PROFIT_PCT': process.env.TAKE_PROFIT_PCT || '0',
        'STOP_LOSS_PCT': process.env.STOP_LOSS_PCT || '0',
        'INDICATORS_CANDLES_INTERVAL': process.env.INDICATORS_CANDLES_INTERVAL || '15',
      };
      return defaults[key] ?? '';
    },
    update(key, value) {
      cfg[key] = value;
      const patch = { [key]: value };

      // When saving the generic API key, also persist it under the current provider's specific key
      if (key === 'AI_PROVIDER_API_KEY') {
        const provider = cfg.AI_PROVIDER || process.env.AI_PROVIDER || 'anthropic';
        const providerKey = `AI_PROVIDER_API_KEY_${provider.toUpperCase()}`;
        cfg[providerKey] = value;
        patch[providerKey] = value;
      }

      // Persist async (fire and forget)
      import('./user-registry.js').then(({ updateUserConfig }) => {
        updateUserConfig(user.telegram_id, patch).catch(() => { });
      });
      return true;
    },
    // Keys a regular user can edit (no shared Telegram credentials)
    get editableKeys() {
      return ['REVOLUT_API_KEY', 'REVOLUT_PRIVATE_KEY_PATH', 'AI_PROVIDER_API_KEY', 'AI_MODEL', 'AI_PROVIDER'];
    },
    // Additional keys only visible to admin
    get editableKeysAdmin() {
      return ['REVOLUT_API_KEY', 'REVOLUT_BASE_URL', 'REVOLUT_PRIVATE_KEY_PATH', 'AI_PROVIDER_API_KEY', 'AI_MODEL', 'AI_PROVIDER', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
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
  // Validate LLM credentials
  if (!userConfig.llm.apiKey) missing.push('AI_PROVIDER_API_KEY');
  // Optional: ensure model present
  if (!userConfig.llm.model) missing.push('AI_MODEL');
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
