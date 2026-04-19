import fs from 'fs';
import path from 'path';
import 'dotenv/config';

class Config {
  constructor() {
    this.envPath = path.join(process.cwd(), '.env');
    this.load();
  }

  load() {
    this.revolut = {
      apiKey: process.env.REVOLUT_API_KEY,
      baseUrl: process.env.REVOLUT_BASE_URL || 'https://revx.revolut.com',
      privateKeyPath: process.env.REVOLUT_PRIVATE_KEY_PATH,
    };
    this.anthropic = {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
    };
    this.telegram = {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
    };
    const parseNum = (val) => parseFloat(String(val).replace(',', '.'));

    this.trading = {
      pairs: (process.env.TRADING_PAIRS || '').split(',').map(p => p.trim().replace('/', '-')).filter(Boolean),
      maxTradeSize: parseNum(process.env.MAX_TRADE_SIZE || '0.10'),
      minOrderUsd: parseNum(process.env.MIN_ORDER || '50'),
      takeProfitPct: parseNum(process.env.TAKE_PROFIT_PCT || '0'),
      stopLossPct: parseNum(process.env.STOP_LOSS_PCT || '0'),
      visionAgent: process.env.VISION_AGENT || 'short',
      personalityAgent: process.env.PERSONALITY_AGENT || 'moderate',
    };
    this.cron = {
      enabled: process.env.CRON_ENABLED === 'true',
      schedule: process.env.CRON_SCHEDULE || '*/15 * * * *',
    };
    this.indicators = {
      candlesInterval: parseInt(process.env.INDICATORS_CANDLES_INTERVAL) || 5, // in minutes
    };
    this.debug = {
      dryRun: process.env.DRY_RUN === 'true',
      logLevel: process.env.LOG_LEVEL || 'info',
      debugApi: process.env.DEBUG_API === 'true',
    };
    this.mongodb = {
      uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
      dbName: process.env.MONGODB_DB || 'revolut-trading-agent'
    };
  }

  update(key, value) {
    try {
      let content = fs.existsSync(this.envPath) ? fs.readFileSync(this.envPath, 'utf-8') : '';
      const regex = new RegExp(`^${key}=.*$`, 'm');

      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        // Ensure we add a newline if the file doesn't end with one
        content = content + (content && !content.endsWith('\n') ? '\n' : '') + `${key}=${value}\n`;
      }

      fs.writeFileSync(this.envPath, content, 'utf-8');

      process.env[key] = value;
      this.load();
      return true;
    } catch (err) {
      console.error(`Config update failed for ${key}:`, err.message);
      return false;
    }
  }

  getRaw(key) {
    return process.env[key] || '';
  }

  get editableKeys() {
    return [
      'REVOLUT_API_KEY', 'REVOLUT_BASE_URL', 'REVOLUT_PRIVATE_KEY_PATH',
      'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
      'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'
    ];
  }

  get editableKeysAgent() {
    return [
      'VISION_AGENT', 'PERSONALITY_AGENT',
      'TRADING_PAIRS', 'MAX_TRADE_SIZE', 'MIN_ORDER', 'TAKE_PROFIT_PCT', 'STOP_LOSS_PCT',
      'INDICATORS_CANDLES_INTERVAL'
    ];
  }

  validateConfig() {
    const required = [
      ['REVOLUT_API_KEY', this.revolut.apiKey],
      ['REVOLUT_PRIVATE_KEY_PATH', this.revolut.privateKeyPath],
      ['REVOLUT_BASE_URL', this.revolut.baseUrl],
      ['ANTHROPIC_API_KEY', this.anthropic.apiKey],
      ['TELEGRAM_BOT_TOKEN', this.telegram.botToken],
      ['TELEGRAM_CHAT_ID', this.telegram.chatId],
    ];

    const missing = required
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missing.length > 0) {
      throw new Error(`Missing required env vars: ${missing.join(', ')}`);
    }

    if (this.trading.maxTradeSize <= 0 || this.trading.maxTradeSize > 1) {
      throw new Error(`MAX_TRADE_SIZE must be between 0 and 1, got ${this.trading.maxTradeSize}`);
    }

    if (this.trading.minOrderUsd < 0) {
      throw new Error(`MIN_ORDER must be non-negative, got ${this.trading.minOrderUsd}`);
    }
  }
}

export const config = new Config();

export function validateConfig() {
  return config.validateConfig();
}
