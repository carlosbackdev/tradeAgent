import cron from 'node-cron';
import { runAgentCycle } from '../agent/executor.js';
import { logger } from '../utils/logger.js';
import { CronParse, formatInitMessage, formatStartMessage, formatStatsMessage, formatAskMessage, formatConfigMessage, formatPromptMessage, formatHelpMessage, formatAgentStatusMessage } from '../utils/formatter.js';
import { getTradingStats, getTradingPerformance } from '../services/mongo/mongo-service.js';
import { RevolutClient } from '../revolut/client.js';
import { MarketData } from '../revolut/market.js';
import { config } from '../config/config.js';
import { CRON_PRESETS } from './entities/cronPresets.js';
import { PROVIDER_MODELS } from '../agent/entities/models.js';
import { COINS } from '../agent/entities/coins.js';
import { AdminHandlers } from './admin/admin-handlers.js';
import { CallbackHandler } from './response/callback-handler.js';
import { FallbackChainHandler } from './admin/fallback-chain-handler.js';

// ── Cron presets ──────────────────────────────────────────────────
// Imported from entities/cronPresets.js

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

export class TelegramHandlers {
    constructor(botContext) {
        this.ctx = botContext;
        this.configState = { isConfiguring: false, isInviting: false, selectedKey: null };
        this.admin = new AdminHandlers(botContext);
        this.fallbackChain = new FallbackChainHandler(botContext);
        this.callbackHandler = new CallbackHandler(this, this.configState, botContext);
    }

    get isConfiguring() {
        return this.configState.isConfiguring;
    }

    async handleInit() {
        this.configState.isConfiguring = false;
        this.configState.selectedKey = null;

        const cronSt = this.ctx.getCronStatus();
        const initKeyboard = {
            inline_keyboard: [
                [
                    { text: '🚀 START', callback_data: '/start' }
                ],
                [
                    { text: '⏰ CRON', callback_data: '/cron' },
                    { text: '📊 STATUS', callback_data: '/status' },
                    { text: '📈 TRADING STATS', callback_data: '/stats' },
                ],
                [
                    { text: '🤖 AGENT CONFIG', callback_data: '/agent' },
                    { text: '⚙️ API CONFIG', callback_data: '/configuration' },
                ],
                [
                    { text: '💬 ASK AGENT', callback_data: '/ask' },
                    { text: '❓ HELP', callback_data: '/help' }
                ]
            ]
        };

        if (this.ctx.isAdmin) {
            initKeyboard.inline_keyboard.push([{ text: '👑 ADMIN PANEL', callback_data: '/admin' }]);
            initKeyboard.inline_keyboard.push([{ text: '🔗 FALLBACK CHAIN', callback_data: '/fallback_chain' }]);
        }

        const uConfig = this.ctx.readEnvFile();
        const mode = uConfig.debug.dryRun ? '🔒 DRY_RUN' : '🔴 LIVE TRADING';
        const pairs = uConfig.trading.pairs || [];

        const statusMsg = formatInitMessage({
            username: this.ctx.username,
            cronStatus: cronSt,
            mode,
            pairs
        });

        await this.ctx.sendMessage(statusMsg, { parse_mode: 'HTML', reply_markup: initKeyboard });
    }
    async handleMenu() {
        this.configState.isConfiguring = false;
        this.configState.selectedKey = null;

        const initKeyboard = {
            inline_keyboard: [
                [
                    { text: '🚀 START', callback_data: '/start' }
                ],
                [
                    { text: '⏰ CRON', callback_data: '/cron' },
                    { text: '📊 STATUS', callback_data: '/status' },
                    { text: '📈 TRADING STATS', callback_data: '/stats' },
                ],
                [
                    { text: '🤖 AGENT CONFIG', callback_data: '/agent' },
                    { text: '⚙️ API CONFIG', callback_data: '/configuration' },
                ],
                [
                    { text: '💬 ASK AGENT', callback_data: '/ask' },
                    { text: '❓ HELP', callback_data: '/help' }
                ]
            ]
        };

        if (this.ctx.isAdmin) {
            initKeyboard.inline_keyboard.push([{ text: '👑 ADMIN PANEL', callback_data: '/admin' }]);
        }

        await this.ctx.sendMessage('🤖 Acciones disponibles:', { reply_markup: initKeyboard });
    }

    async handleAsk() {
        const pairs = this.ctx.readEnvFile().trading.pairs;
        const inline_keyboard = chunk(
            pairs.map(p => ({ text: `❓ ${p}`, callback_data: `ask_coin:${p}` })),
            2
        );
        inline_keyboard.push([{ text: '🔙 ATRÁS', callback_data: '/init' }]);

        const msg = formatAskMessage();
        await this.ctx.sendMessage(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard } });
    }

    async handleStart() {
        this.configState.isConfiguring = false;
        this.configState.selectedKey = null;
        const keyboardCoins = {
            inline_keyboard: [
                ...chunk(COINS.map(p => ({
                    text: p.emoji + ' ' + p.symbol,
                    callback_data: `/${p.symbol.toLowerCase()}`,
                })), 3),
                [{ text: '🔙 ATRÁS', callback_data: '/init' },
                { text: '⏰ CRON', callback_data: '/cron' },
                ]
            ],
        };

        const msg = formatStartMessage();
        await this.ctx.sendMessage(msg, { parse_mode: 'HTML', reply_markup: keyboardCoins });
    }

    async handleHelp() {
        const msg = formatHelpMessage(this.ctx.isAdmin);
        await this.ctx.sendMessage(msg, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: '🔙 VOLVER AL INICIO', callback_data: '/init' }]]
            }
        });
    }

    async handleAdminMenu() {
        if (!this.ctx.isAdmin) return;
        const keyboard = {
            inline_keyboard: [
                [{ text: '👥 LISTAR USUARIOS', callback_data: '/users' }],
                [{ text: '➕ INVITAR USUARIO', callback_data: 'admin_invite_prompt' }],
                [{ text: '📊 STATUS DEL SISTEMA', callback_data: '/admin_status' }],
                [{ text: '🔙 VOLVER', callback_data: '/init' }]
            ]
        };
        await this.ctx.sendMessage('<b>👑 PANEL DE CONTROL</b>\n\nBienvenido, administrador. Gestiona los accesos y el estado general del bot.', {
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    }

    async handleStatus() {
        const uConfig = this.ctx.readEnvFile();
        const mode = uConfig.debug.dryRun ? '🔒 DRY-RUN' : '🟢 REAL MONEY';
        const cronSt = this.ctx.getCronStatus();

        const msg = formatAgentStatusMessage({ uConfig, cronSt, mode });

        await this.ctx.sendMessage(msg, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] }
        });
    }

    async handleTradingStats() {
        // Fetch physical balances to cap MongoDB bot-managed holdings (Option B)
        const uConfig = this.ctx.readEnvFile();
        let balances = null;
        try {
            const client = new RevolutClient(uConfig);
            const market = new MarketData(client);
            balances = await market.getBalances();
        } catch (err) {
            logger.warn(`Failed to fetch balances for stats syncing: ${err.message}`);
        }

        const stats = await getTradingPerformance(this.ctx.chatId, balances);

        if (!stats) {
            await this.ctx.sendMessage(
                '❌ No se pudieron obtener las estadísticas',
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] } }
            );
            return;
        }

        const perf = {
            pnlUsd: stats.totalRealizedPnL,
            roi: stats.roiRealized,
            totalRendimiento: stats.accumulatedRendimiento
        };

        const openPositions = (stats.openPositions || []).map(p => ({
            symbol: p.symbol,
            qty: p.qty,
            price: p.avgPrice,
            cost: p.totalCost
        }));

        const msg = formatStatsMessage({
            stats: {
                totalDecisions: stats.totalDecisions,
                totalOrders: stats.totalOrders,
                totalBuys: stats.totalBuys,
                totalSells: stats.totalSells,
                executionRatio: stats.executionRate,
                winningTrades: stats.winningTrades,
                losingTrades: stats.losingTrades,
                closedTrades: stats.closedTrades,
                winRate: stats.winRate
            },
            performance: perf,
            invested: stats.totalInvested,
            openPositions,
            manualPositions: stats.manualPositions || []
        });

        await this.ctx.sendMessage(msg, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] }
        });
    }

    async handleCron(args) {
        if (args === 'on') {
            if (this.ctx.startCron(this.ctx.cronSchedule)) {
                await this.ctx.sendMessage(`✅ Cron activado\nSchedule: <code>${this.ctx.cronSchedule}</code>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] } });
            } else {
                await this.ctx.sendMessage(`❌ Schedule inválido: <code>${this.ctx.cronSchedule}</code>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] } });
            }
            return;
        }

        if (args === 'off') {
            this.ctx.stopCron();
            await this.ctx.sendMessage('⏹ Cron desactivado. Las operaciones manuales siguen disponibles.', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] } });
            return;
        }

        if (args && args.trim()) {
            const expr = args.trim();
            if (!cron.validate(expr)) {
                await this.ctx.sendMessage(`❌ Expresión cron inválida: <code>${expr}</code>\n\nEjemplos válidos:\n<code>*/5 * * * *</code>  → cada 5 min\n<code>*/15 * * * *</code> → cada 15 min\n<code>0 * * * *</code>    → cada hora\n<code>0 */4 * * *</code>  → cada 4 horas`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] } });
                return;
            }
            if (this.ctx.startCron(expr)) {
                let parseCron = CronParse(expr);
                await this.ctx.sendMessage(`✅ Cron actualizado y activado\n Ciclo: <code>${parseCron}</code>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] } });
            }
            return;
        }

        const st = this.ctx.getCronStatus();
        const keyboard = {
            inline_keyboard: [
                [
                    { text: st.enabled ? '⏸ Desactivar' : '▶️ Activar', callback_data: st.enabled ? 'cron_off' : 'cron_on' },
                    { text: '🔄 Ejecutar ahora', callback_data: 'cron_now' },
                ],
                ...chunk(CRON_PRESETS.map(p => ({
                    text: p.label,
                    callback_data: `cron_set_${p.expr}`,
                })), 3),
                [{ text: '🔙 ATRÁS', callback_data: '/init' }]
            ],
        };

        await this.ctx.sendMessage(
            `⏰ <b>GESTIÓN DE CRON</b>\n\n` +
            `Estado: ${st.enabled ? '✅ ACTIVO' : '⏸ INACTIVO'}\n` +
            `Ciclo: 📅 <code>${CronParse(st.schedule)}</code>\n\n`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    }

    async handleCoinCommand(symbol) {
        const coin = COINS.find(c => c.symbol === symbol);
        if (!coin) { await this.ctx.sendMessage('❌ Moneda no encontrada. Usa /help', { parse_mode: 'HTML' }); return; }

        await this.ctx.sendMessage(`⏳ Analizando ${coin.emoji} ${symbol}...\n\nFetching datos → indicadores → Model AI → ejecución`, { parse_mode: 'HTML' });

        try {
            await runAgentCycle('telegram', `${symbol}-USD`, '', this.ctx.readEnvFile());
        } catch (err) {
            logger.error(`Coin command failed for ${symbol}:`, err.message);
            await this.ctx.sendMessage(`❌ Error procesando ${coin.emoji} ${symbol}\n\n<code>${err.message}</code>\n\nIntenta de nuevo: /${symbol.toLowerCase()}`, { parse_mode: 'HTML' });
        } finally {
            await this.handleMenu();
        }
    }

    async handleConfiguration() {
        const userCfg = this.ctx.readEnvFile();
        const keys = this.ctx.isAdmin ? userCfg.editableKeysAdmin : userCfg.editableKeys;
        const params = keys.map(key => {
            const value = userCfg.getRaw(key) || '(—)';
            const display = key.includes('KEY') || key.includes('TOKEN') || key.includes('PEM')
                ? value.substring(0, 8) + '...'
                : value;
            return { key, value: display };
        });

        const text = formatConfigMessage(params);

        this.configState.mode = 'api';
        this.configState.selectedKey = null;
        this.configState.isConfiguring = true;
        await this.ctx.sendMessage(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] } });
    }

    async handleConfigInput(text) {
        if (this.configState.isInviting) {
            this.configState.isInviting = false;
            const input = text.trim();
            // Pass to handleInvite
            await this.handleInvite(input);
            return;
        }

        if (this.configState.isConfiguring && this.configState.mode === 'awaiting_provider_token') {
            const token = text.trim();
            const provider = this.configState.pendingProvider;
            const providerKey = `AI_PROVIDER_API_KEY_${provider.toUpperCase()}`;

            // update() auto-propagates AI_PROVIDER_API_KEY → provider-specific key,
            // but we also save providerKey directly to be explicit and immediate.
            this.ctx.updateEnvFile('AI_PROVIDER_API_KEY', token);
            this.ctx.updateEnvFile(providerKey, token);

            this.configState.isConfiguring = false;
            this.configState.mode = null;
            this.configState.selectedKey = null;
            this.configState.pendingProvider = null;

            await this.ctx.sendMessage(
                `✅ <b>API Token de ${provider.toUpperCase()} guardada</b>\n\n` +
                `🔑 <code>${token.substring(0, 8)}...</code>\n\n` +
                `La token ha sido activada para este provider.`,
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⚙️ API CONFIG', callback_data: '/configuration' }]] } }
            );
            return;
        }

        if (this.configState.isConfiguring && this.configState.mode === 'asking') {
            const question = text.trim();
            const symbol = this.configState.symbol;

            this.configState.isConfiguring = false;
            this.configState.mode = null;
            this.configState.symbol = null;

            await this.ctx.sendMessage(`⏳ Procesando pregunta para <b>${symbol}</b>...\n<i>"${question}"</i>`, { parse_mode: 'HTML' });

            try {
                await runAgentCycle('manual', symbol, question, this.ctx.readEnvFile());
            } catch (err) {
                await this.ctx.sendMessage(`❌ Error: ${err.message}`);
            }
            return;
        }

        if (this.configState.isConfiguring) {
            if (!this.configState.selectedKey) {
                const userCfg = this.ctx.readEnvFile();
                const isApiMode = this.configState.mode === 'api';
                const keys = this.configState.mode === 'agent'
                    ? userCfg.editableKeysAgent
                    : (this.ctx.isAdmin ? userCfg.editableKeysAdmin : userCfg.editableKeys);

                const idx = parseInt(text.trim()) - 1;
                if (isNaN(idx) || idx < 0 || idx >= keys.length) {
                    await this.ctx.sendMessage(`❌ Número inválido (1-${keys.length})`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] } });
                    return;
                }

                const key = keys[idx];
                this.configState.selectedKey = key;

                // Interactive options for specific agent keys
                if (key === 'VISION_AGENT') {
                    await this.ctx.sendMessage('🔭 <b>VISIÓN DEL AGENTE</b>\n\nSelecciona el horizonte temporal de análisis:', {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '⌛ Short', callback_data: 'SET_AGENT_CFG:VISION_AGENT:short' },
                                    { text: '📅 Medium', callback_data: 'SET_AGENT_CFG:VISION_AGENT:medium' },
                                    { text: '🌌 Long', callback_data: 'SET_AGENT_CFG:VISION_AGENT:long' }
                                ],
                                [{ text: '🔙 CANCELAR', callback_data: '/agent' }]
                            ]
                        }
                    });
                    return;
                }

                if (key === 'PERSONALITY_AGENT') {
                    await this.ctx.sendMessage('🧠 <b>PERSONALIDAD DEL AGENTE</b>\n\nSelecciona el perfil de riesgo:', {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '🛱️ Conservative', callback_data: 'SET_AGENT_CFG:PERSONALITY_AGENT:conservative' },
                                    { text: '⚖️ Moderate', callback_data: 'SET_AGENT_CFG:PERSONALITY_AGENT:moderate' },
                                    { text: '🔥 Aggressive', callback_data: 'SET_AGENT_CFG:PERSONALITY_AGENT:aggressive' }
                                ],
                                [{ text: '🔙 CANCELAR', callback_data: '/agent' }]
                            ]
                        }
                    });
                    return;
                }

                if (key === 'AI_PROVIDER') {
                    await this.ctx.sendMessage('🤖 <b>PROVEEDOR DE IA</b>\n\nSelecciona el proveedor que deseas usar:', {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: 'Anthropic', callback_data: 'SET_AGENT_CFG:AI_PROVIDER:anthropic' },
                                    { text: 'OpenAI', callback_data: 'SET_AGENT_CFG:AI_PROVIDER:openai' },
                                ],
                                [
                                    { text: 'Gemini', callback_data: 'SET_AGENT_CFG:AI_PROVIDER:gemini' },
                                    { text: 'DeepSeek', callback_data: 'SET_AGENT_CFG:AI_PROVIDER:deepseek' }
                                ],
                                [
                                    { text: 'Groq', callback_data: 'SET_AGENT_CFG:AI_PROVIDER:groq' }
                                ],
                                [{ text: '🔙 CANCELAR', callback_data: '/configuration' }]
                            ]
                        }
                    });
                    return;
                }

                if (key === 'AI_MODEL') {
                    const userCfg = this.ctx.readEnvFile();
                    const provider = userCfg.getRaw('AI_PROVIDER') || 'anthropic';
                    const models = PROVIDER_MODELS[provider] || [];

                    if (models.length > 0) {
                        const keyboard = {
                            inline_keyboard: [
                                ...chunk(models.map(m => ({ text: m, callback_data: `SET_AGENT_CFG:AI_MODEL:${m}` })), 1),
                                [{ text: '🔙 CANCELAR', callback_data: '/configuration' }]
                            ]
                        };
                        await this.ctx.sendMessage(`🧠 <b>MODELO DE IA (${provider.toUpperCase()})</b>\n\nSelecciona el modelo que deseas usar:`, {
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        });
                        return;
                    }
                }

                await this.ctx.sendMessage(`✏️ Escribe el nuevo valor para <code>${this.configState.selectedKey}</code>:`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] } });
                return;
            }

            const key = this.configState.selectedKey;
            const value = text.trim();
            const ok = this.ctx.updateEnvFile(key, value);

            this.configState.isConfiguring = false;
            this.configState.selectedKey = null;
            this.configState.mode = null;

            await this.ctx.sendMessage(
                ok
                    ? `✅ <b>Configuración guardada</b>\n\n<code>${key}</code> → <code>${value}</code>`
                    : `❌ Error guardando ${key}`,
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🤖 AGENTE CONFIG', callback_data: '/agent' }, { text: '🏠 MENÚ', callback_data: '/init' }]] } }
            );
        }
    }

    // ── Admin Handlers
    async handleInvite(username)      { return this.admin.handleInvite(username); }
    async handleListUsers()           { return this.admin.handleListUsers(); }
    async handleRevokeUser(username)  { return this.admin.handleRevokeUser(username); }
    async handleAdminStatus()         { return this.admin.handleAdminStatus(); }
    async handleFallbackChain()       { return this.fallbackChain.handleFallbackChainMenu(); }

    // ── Callback dispatcher
    async handleCallback(callbackQueryId, data, messageId) {
        return this.callbackHandler.handle(callbackQueryId, data, messageId);
    }
}