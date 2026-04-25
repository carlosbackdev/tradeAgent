import 'dotenv/config';

/**
 * Global Configuration (Shared Infrastructure)
 * Multi-user mode uses this for core connectivity (MongoDB, Master Bot, Admin ID).
 * Per-user trading settings are handled in user-config.js.
 */
class Config {
  constructor() {
    this.load();
  }

  load() {
    // ── Shared Services ──────────────────────────────────────────────
    this.mongodb = {
      uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
      dbName: process.env.MONGODB_DB || 'revolut-trading-agent'
    };

    this.telegram = {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID, // Main admin chat ID
    };

    this.anthropic = {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
    };

    this.revolut = {
      apiKey: process.env.REVOLUT_API_KEY,
      baseUrl: process.env.REVOLUT_BASE_URL || 'https://revx.revolut.com',
      privateKeyPath: process.env.REVOLUT_PRIVATE_KEY_PATH,
    };

    // ── Global System Defaults ───────────────────────────────────────
    this.debug = {
      dryRun: process.env.DRY_RUN === 'true',
      logLevel: process.env.LOG_LEVEL || 'info',
      debugApi: process.env.DEBUG_API === 'true',
    };

    this.trading = {
      pairs: (process.env.TRADING_PAIRS || '').split(',').map(p => p.trim().replace('/', '-')).filter(Boolean),
    };

    // ── LLM Provider Config ───────────────────────────────────────
    this.llm = {
      provider: process.env.AI_PROVIDER || 'anthropic', // anthropic | openai | gemini | deepseek
      apiKey:
        process.env.AI_PROVIDER_API_KEY ||
        process.env.ANTHROPIC_API_KEY ||
        '',
      model:
        process.env.AI_MODEL ||
        process.env.ANTHROPIC_MODEL ||
        'claude-haiku-4-5',
    };


    this.indicators = {
      candlesInterval: parseInt(process.env.INDICATORS_CANDLES_INTERVAL) || 5,
    };
  }
}

export const config = new Config();
