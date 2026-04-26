/**
 * users/user-session.js
 * A per-user isolated session that wraps TelegramHandlers with the user's own config.
 * Each active user gets one UserSession instance, completely isolated from others.
 */

import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { TelegramHandlers } from '../telegram/telegram-handlers.js';
import { TelegramCommands } from '../telegram/commands.js';
import { runAgentCycle } from '../agent/executor.js';
import { CronParse } from '../utils/formatter.js';
import { updateUserConfig } from './user-registry.js';

export class UserSession {
  constructor({ user, userConfig, sendMessage, editMessage, answerCallback }) {
    this.user = user;
    this.userConfig = userConfig;
    this.userId = user.telegram_id;
    this.username = user.telegram_username;

    // Communication helpers bound to this user's chat
    this._send = sendMessage;
    this._edit = editMessage;
    this._answer = answerCallback;

    // Cron task for this user only
    this.cronTask = null;

    // Build the bot context compatible with TelegramHandlers
    const self = this;
    const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID ? String(process.env.ADMIN_TELEGRAM_ID).trim() : null;
    const currentId = String(this.userId).trim();
    const isAdmin = ADMIN_ID && currentId === ADMIN_ID;

    if (isAdmin) logger.info(`👑 Session ${this.userId} initialized with ADMIN privileges`);

    this.botContext = {
      isAdmin: !!isAdmin,
      chatId: this.userId,
      sendMessage: (t, r) => sendMessage(t, r),
      editMessage: (m, t, r) => editMessage(m, t, r),
      answerCallback: (c, t) => answerCallback(c, t),
      readEnvFile: () => userConfig,
      updateEnvFile: (k, v) => self.updateConfig(k, v),
      startCron: (s) => self.startCron(s),
      stopCron: () => self.stopCron(),
      getCronStatus: () => self.getCronStatus(),
      get cronSchedule() { return userConfig.cron.schedule; },
      set cronSchedule(s) { userConfig.cron.schedule = s; },
      username: this.username
    };

    this.handlers = new TelegramHandlers(this.botContext);
    this.commandsRouter = new TelegramCommands(this.handlers, (t, r) => sendMessage(t, r));
  }

  async init() {
    // Auto-start cron if user had it enabled
    if (this.userConfig.cron.enabled && cron.validate(this.userConfig.cron.schedule)) {
      this.startCron(this.userConfig.cron.schedule);
      logger.info(`⏰ Auto-started cron for user ${this.username}: ${this.userConfig.cron.schedule}`);
    }

    // Send init message
    await this.handlers.handleInit().catch(() => { });
    logger.info(`✅ UserSession initialized for @${this.username}`);
  }

  async handleMessage(text, messageId) {
    // Intercept /config command for user-specific settings
    if (text === '/myconfig') {
      return this.showUserConfig();
    }
    if (text === '/resetconfig') {
      return this.promptResetConfig();
    }
    await this.commandsRouter.processTextMessage({ text, message_id: messageId });
  }

  async handleCallback(callbackQueryId, data, messageId) {
    await this._answer(callbackQueryId);

    // Handle user-specific callbacks
    if (data === 'reset_config_confirm') {
      await this.resetUserConfig();
      return;
    }

    await this.handlers.handleCallback(callbackQueryId, data, messageId);
  }

  // ── Config management ──────────────────────────────────────────

  updateConfig(key, value) {
    const normalizedValue = typeof value === 'string' ? value.trim() : value;

    // Validate any API key (generic or provider-specific)
    if (key === 'AI_PROVIDER_API_KEY' || key === 'ANTHROPIC_API_KEY' || key.startsWith('AI_PROVIDER_API_KEY_')) {
      const apiKey = String(normalizedValue || '');
      if (!apiKey || apiKey.length < 10) {
        this._send(`❌ <b>API Key inválida</b>\n\nLa clave debe tener al menos 10 caracteres.`, { parse_mode: 'HTML' }).catch(() => { });
        return false;
      }
    }

    // Update in-memory raw config
    const cfg = this.user.config || {};
    cfg[key] = normalizedValue;
    this.user.config = cfg;

    // Build the MongoDB patch (may include extra keys)
    const patch = { [key]: normalizedValue };

    // Rebuild trading/debug/etc sub-objects
    const parseNum = (val, fb) => { const n = parseFloat(String(val || '').replace(',', '.')); return isNaN(n) ? fb : n; };
    if (key === 'TRADING_PAIRS') {
      this.userConfig.trading.pairs = value.split(',').map(p => p.trim()).filter(Boolean);
    } else if (key === 'MAX_TRADE_SIZE') {
      let n = parseFloat(String(value || '').replace(',', '.'));
      if (!isNaN(n) && n > 0) {
        this.userConfig.trading.maxTradeSize = Math.min(100, n);
      }
    } else if (key === 'MIN_ORDER') {
      this.userConfig.trading.minOrderUsd = parseNum(value, 50);
    } else if (key === 'TAKE_PROFIT_PCT') {
      this.userConfig.trading.takeProfitPct = parseNum(value, 0);
    } else if (key === 'STOP_LOSS_PCT') {
      this.userConfig.trading.stopLossPct = parseNum(value, 0);
    } else if (key === 'VISION_AGENT') {
      this.userConfig.trading.visionAgent = value;
    } else if (key === 'PERSONALITY_AGENT') {
      this.userConfig.trading.personalityAgent = value;
    } else if (key === 'INDICATORS_CANDLES_INTERVAL') {
      this.userConfig.indicators.candlesInterval = parseNum(value, 15);
    } else if (key === 'AI_MODEL') {
      this.userConfig.llm.model = normalizedValue;
    } else if (key === 'AI_PROVIDER_API_KEY') {
      // Save generically AND under the current provider's specific key
      this.userConfig.llm.apiKey = normalizedValue;
      const currentProvider = this.userConfig.llm.provider || 'anthropic';
      const providerKey = `AI_PROVIDER_API_KEY_${currentProvider.toUpperCase()}`;
      cfg[providerKey] = normalizedValue;
      patch[providerKey] = normalizedValue;
    } else if (key.startsWith('AI_PROVIDER_API_KEY_')) {
      // Direct provider-specific key — also update active llm.apiKey if it matches current provider
      const currentProvider = this.userConfig.llm.provider || 'anthropic';
      const expectedKey = `AI_PROVIDER_API_KEY_${currentProvider.toUpperCase()}`;
      if (key === expectedKey) {
        this.userConfig.llm.apiKey = normalizedValue;
      }
    } else if (key === 'AI_PROVIDER') {
      this.userConfig.llm.provider = normalizedValue;
      // Reload apiKey from stored provider-specific key (if exists)
      const providerKey = `AI_PROVIDER_API_KEY_${normalizedValue.toUpperCase()}`;
      const storedKey = cfg[providerKey] || process.env[providerKey] || '';
      if (storedKey) {
        this.userConfig.llm.apiKey = storedKey;
      }
    } else if (key === 'REVOLUT_API_KEY') {
      this.userConfig.revolut.apiKey = normalizedValue;
    } else if (key === 'REVOLUT_BASE_URL') {
      this.userConfig.revolut.baseUrl = normalizedValue;
    } else if (key === 'REVOLUT_PRIVATE_KEY_PATH') {
      this.userConfig.revolut.privateKeyPath = normalizedValue;
    } else if (key === 'DRY_RUN') {
      this.userConfig.debug.dryRun = normalizedValue === 'true';
    } else if (key === 'CRON_SCHEDULE') {
      this.userConfig.cron.schedule = normalizedValue;
    } else if (key === 'CRON_ENABLED') {
      this.userConfig.cron.enabled = normalizedValue === 'true';
    }

    // Persist to MongoDB
    updateUserConfig(this.userId, patch).catch(err =>
      logger.warn(`Failed to persist config for user ${this.userId}: ${err.message}`)
    );
    return true;
  }

  async showUserConfig() {
    const cfg = this.user.config || {};
    const dry = this.userConfig.debug.dryRun ? '🔒 DRY RUN' : '🔴 REAL MONEY';
    const provider = this.userConfig.llm.provider || 'anthropic';
    const providerKey = `AI_PROVIDER_API_KEY_${provider.toUpperCase()}`;
    const activeKey = cfg[providerKey] || cfg.AI_PROVIDER_API_KEY || '';

    await this._send(
      `⚙️ *Tu configuración*\n\n` +
      `🎯 Pares: ${this.userConfig.trading.pairs.join(', ')}\n` +
      `💰 Max trade: ${this.userConfig.trading.maxTradeSize}%\n` +
      `💵 Min orden: $${this.userConfig.trading.minOrderUsd}\n` +
      `🎯 TP: ${this.userConfig.trading.takeProfitPct}%\n` +
      `🎯 SL: ${this.userConfig.trading.stopLossPct}%\n` +
      `🧠 Modelo: ${this.userConfig.llm.model} (${provider})\n` +
      `🌐 URL Revolut: ${this.userConfig.revolut.baseUrl}\n` +
      `${dry}\n` +
      `\n🔑 API Key Revolut: \`${(cfg.REVOLUT_API_KEY || '').substring(0, 12)}...\`\n` +
      `🤖 IA (${provider}): \`${activeKey.substring(0, 10)}...\``
    );
  }

  async promptResetConfig() {
    await this._send(
      '⚠️ *¿Resetear configuración?*\n\n' +
      'Esto borrará tu API Key de Revolut, la clave privada y la de IA.\n' +
      'Tendrás que volver a configurarlo todo desde /start.',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔴 Sí, resetear', callback_data: 'reset_config_confirm' }],
            [{ text: '❌ Cancelar', callback_data: '/init' }],
          ]
        }
      }
    );
  }

  async resetUserConfig() {
    await updateUserConfig(this.userId, {
      REVOLUT_API_KEY: '',
      REVOLUT_PRIVATE_KEY_PEM: '',
      AI_PROVIDER_API_KEY: '',
    });
    this.stopCron();
    await this._send('✅ Configuración de API reseteada. Vuelve a configurar con /start.');
  }

  // ── Cron management (per-user) ─────────────────────────────────

  startCron(schedule) {
    if (this.cronTask) { this.cronTask.stop(); this.cronTask = null; }
    if (!cron.validate(schedule)) return false;

    this.cronTask = cron.schedule(schedule, async () => {
      logger.info(`⏰ [User: ${this.username}] Cron triggered: ${schedule}`);
      try {
        for (const coin of this.userConfig.trading.pairs) {
          // Pass userConfig to executor so it uses this user's keys
          await runAgentCycle('cron', coin, '', this.userConfig);
        }
        await this.handlers.handleMenu();
      } catch (err) {
        logger.error(`[User: ${this.username}] Cron cycle failed: ${err.message}`);
      }
    });

    this.updateConfig('CRON_ENABLED', 'true');
    this.updateConfig('CRON_SCHEDULE', schedule);
    logger.info(`✅ [User: ${this.username}] Cron started: ${schedule}`);
    return true;
  }

  stopCron() {
    if (this.cronTask) { this.cronTask.stop(); this.cronTask = null; }
    this.updateConfig('CRON_ENABLED', 'false');
    logger.info(`⏹ [User: ${this.username}] Cron stopped`);
  }

  getCronStatus() {
    const enabled = this.userConfig.cron.enabled && !!this.cronTask;
    const schedule = this.userConfig.cron.schedule;
    return {
      enabled,
      schedule,
      next: enabled ? `Próximo ciclo según: ${schedule}` : 'Desactivado',
    };
  }

  destroy() {
    this.stopCron();
    logger.info(`🗑 Session destroyed for @${this.username}`);
  }
}
