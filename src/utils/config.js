/**
 * src/utils/config.js
 * Centralized configuration with validation.
 */

export const config = {
  revolut: {
    apiKey: process.env.REVOLUT_API_KEY,
    baseUrl: process.env.REVOLUT_BASE_URL,
    privateKeyPath: process.env.REVOLUT_PRIVATE_KEY_PATH,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  trading: {
    pairs: (process.env.TRADING_PAIRS || '').split(',').map(p => p.trim()),
    maxTradeSize: parseFloat(process.env.MAX_TRADE_SIZE || '0.10'),
    minOrderUsd: parseFloat(process.env.MIN_ORDER || '50'),
  },
  cron: {
    enabled: process.env.CRON_ENABLED,
    schedule: process.env.CRON_SCHEDULE || '*/15 * * * *',
  },
  indicatos: {
    candlesInterval: parseInt(process.env.INDICATORS_CANDLES_INTERVAL), // in minutes
  },
  debug: {
    dryRun: process.env.DRY_RUN === 'true',
    logLevel: process.env.LOG_LEVEL || 'info',
    debugApi: process.env.DEBUG_API === 'true',
  },
};

export function validateConfig() {
  const required = [
    ['REVOLUT_API_KEY', config.revolut.apiKey],
    ['REVOLUT_PRIVATE_KEY_PATH', config.revolut.privateKeyPath],
    ['REVOLUT_BASE_URL', config.revolut.baseUrl],
    ['ANTHROPIC_API_KEY', config.anthropic.apiKey],
    ['TELEGRAM_BOT_TOKEN', config.telegram.botToken],
    ['TELEGRAM_CHAT_ID', config.telegram.chatId],
    ['TRADING_PAIRS', config.trading.pairs.length > 0],
    ['CRON_SCHEDULE', config.cron.schedule],
  ];

  const missing = required
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  if (config.trading.maxTradeSize <= 0 || config.trading.maxTradeSize > 1) {
    throw new Error(`MAX_TRADE_SIZE must be between 0 and 1, got ${config.trading.maxTradeSize}`);
  }

  if (config.trading.minOrderUsd < 0) {
    throw new Error(`MIN_ORDER must be non-negative, got ${config.trading.minOrderUsd}`);
  }
}
