import cron from 'node-cron';
import { runAgentCycle } from '../agent/executor.js';
import { logger } from '../utils/logger.js';
import { CronParse } from '../utils/formatter.js';
import { getTradingStats } from '../utils/mongodb.js';
import { config } from '../config/config.js';

const COINS = [
    { symbol: 'BTC', name: 'Bitcoin', emoji: '₿' },
    { symbol: 'ETH', name: 'Ethereum', emoji: '◇' },
    { symbol: 'SOL', name: 'Solana', emoji: '◎' },
    { symbol: 'VVV', name: 'Venice Token', emoji: '🦋' },
    { symbol: 'XRP', name: 'Ripple', emoji: '✕' },
];


// ── Cron presets ──────────────────────────────────────────────────
const CRON_PRESETS = [
    { label: '5 min', expr: '*/5 * * * *' },
    { label: '15 min', expr: '*/15 * * * *' },
    { label: '30 min', expr: '*/30 * * * *' },
    { label: '1 hora', expr: '0 * * * *' },
    { label: '4 horas', expr: '0 */4 * * *' },
];

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

export class TelegramHandlers {
    constructor(botContext) {
        this.ctx = botContext;
        this.configState = { isConfiguring: false, selectedKey: null };
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
                    { text: '⚙️ CONFIG', callback_data: '/configuration' },
                    { text: '❓ HELP', callback_data: '/help' }
                ]
            ]
        };

        const dry = config.debug.dryRun ? '🔒 DRY_RUN' : '🔴 LIVE TRADING';

        await this.ctx.sendMessage(
            `🤖 Revolut x Trading Agent inicializado\n\n` +
            `Agente de trading automatizado con IA para Revolut X\n\n` +
            `Analiza el mercado, evalua las probabilidades, ` +
            `Analiza tu cartera y tus operaciones, todo en contexto y con indicadores para ejecutar la mejor decisión.\n\n` +
            `Las Operaciones se ejecutan automaticamente en Revolut segun la decision tomada por el Agente.\n\n` +
            `⚙️ Estado del sistema:\n` +
            `⏰ Cron: ${cronSt.enabled ? `✅ <code>${CronParse(cronSt.schedule)}</code>` : '⏸ desactivado'}\n` +
            `💰 Modo: ${dry}\n\n`,
            initKeyboard
        );
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
                    { text: '⚙️ CONFIG', callback_data: '/configuration' },
                    { text: '❓ HELP', callback_data: '/help' }
                ]
            ]
        };

        await this.ctx.sendMessage('🤖 Acciones disponibles:', initKeyboard);
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

        await this.ctx.sendMessage(`🤖 REVOLUT X TRADING AGENT

✅ Selecciona una crypto para analizar y operar, El agente analizara la situacion actual y tomara la mejor decisión.

⏰ Para programar analisis y operaciones automaticas, pulsa en el boton CRON (se realiza sobre cada una de nuestra lista
de cryptomonedas).
`
            , keyboardCoins);
    }

    async handleHelp() {
        await this.ctx.sendMessage(`❓ COMANDOS DISPONIBLES

Análisis manual:
/btc — Bitcoin
/eth — Ethereum
/sol — Solana
/venice — Venice Token
/xrp — Ripple

Cron automático:
/cron — ver estado y opciones
/cron_on — activar
/cron_off — desactivar
/cron_*/5 * * * *>  → cada 5 min
/cron_*/15 * * * *> → cada 15 min
/cron_0 * * * *>    → cada hora
/cron_0 */4 * * *>  → cada 4 horas

Info:
/status — configuración actual y cron
/configuration — editar variables .env
/help — este menú`, { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] });
    }

    async handleStatus() {
        const dry = config.debug.dryRun ? '🔒 DRY-RUN' : '🔴 REAL MONEY';
        const cronSt = this.ctx.getCronStatus();
        let parseCron = CronParse(cronSt.schedule);

        await this.ctx.sendMessage(`📊 ESTADO ACTUAL

🎯 Pares: >${config.trading.pairs.join(',')}>
💰 Max trade: >${(config.trading.maxTradeSize * 100).toFixed(0)}%>
💵 Min orden: >$${config.trading.minOrderUsd}>
🧠 Modelo: >${config.anthropic.model}>

⏰ Cron: ${cronSt.enabled ? '✅ ACTIVO' : '⏸ INACTIVO'}
📅 Schedule: >${parseCron}>

${dry}`, { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] });
    }

    async handleTradingStats() {
        const tradingStats = await getTradingStats();

        if (!tradingStats) {
            await this.ctx.sendMessage(
                '❌ No se pudieron obtener las estadísticas',
                { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] }
            );
            return;
        }

        await this.ctx.sendMessage(
            `📊 ESTADÍSTICAS EN TRADING AGENT

📌 Total decisions: ${tradingStats.totalDecisions}
📌 Total executed orders: ${tradingStats.totalOrders}
🟢 Total buys: ${tradingStats.totalBuys}
🔴 Total sells: ${tradingStats.totalSells}
📈 Rendimiento total: ${tradingStats.executionRate}`,
            { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] }
        );
    }

    async handleCron(args) {
        if (args === 'on') {
            if (this.ctx.startCron(this.ctx.cronSchedule)) {
                await this.ctx.sendMessage(`✅ Cron activado\nSchedule: >${this.ctx.cronSchedule}>`, { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] });
            } else {
                await this.ctx.sendMessage(`❌ Schedule inválido: >${this.ctx.cronSchedule}>`, { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] });
            }
            return;
        }

        if (args === 'off') {
            this.ctx.stopCron();
            await this.ctx.sendMessage('⏹ Cron desactivado. Las operaciones manuales siguen disponibles.', { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] });
            return;
        }

        if (args && args.trim()) {
            const expr = args.trim();
            if (!cron.validate(expr)) {
                await this.ctx.sendMessage(`❌ Expresión cron inválida: >${expr}>

Ejemplos válidos:
>*/5 * * * *  → cada 5 min
>*/15 * * * * → cada 15 min
>0 * * * *    → cada hora
>0 */4 * * *  → cada 4 horas`, { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] });
                return;
            }
            if (this.ctx.startCron(expr)) {
                let parseCron = CronParse(expr);
                await this.ctx.sendMessage(`✅ Cron actualizado y activado\n Ciclo: ${parseCron}`, { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] });
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
            `⏰ GESTIÓN DE CRON\n\n` +
            `Estado: ${st.enabled ? '✅ ACTIVO' : '⏸ INACTIVO'}\n` +
            `Ciclo:📅 ${CronParse(st.schedule)}\n\n`,
            keyboard
        );
    }

    async handleCoinCommand(symbol) {
        const coin = COINS.find(c => c.symbol === symbol);
        if (!coin) { await this.ctx.sendMessage('❌ Moneda no encontrada. Usa /help'); return; }

        await this.ctx.sendMessage(`⏳ Analizando ${coin.emoji} ${symbol}...\n\nFetching datos → indicadores → Claude AI → ejecución`);

        try {
            await runAgentCycle('telegram', `${symbol}-USD`);
        } catch (err) {
            logger.error(`Coin command failed for ${symbol}:`, err.message);
            await this.ctx.sendMessage(`❌ Error procesando ${coin.emoji} ${symbol}\n\n>${err.message}>\n\nIntenta de nuevo: /${symbol.toLowerCase()}`);
        } finally {
            await this.handleMenu();
        }
    }

    async handleConfiguration() {
        const FALLBACK_KEYS = [
            'REVOLUT_API_KEY', 'REVOLUT_BASE_URL', 'REVOLUT_PRIVATE_KEY_PATH',
            'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
            'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
            'TRADING_PAIRS', 'MAX_TRADE_SIZE', 'MIN_ORDER', 'TAKE_PROFIT_PCT', 'STOP_LOSS_PCT',
            'CRON_ENABLED', 'CRON_SCHEDULE', 'INDICATORS_CANDLES_INTERVAL',
            'DRY_RUN', 'LOG_LEVEL', 'DEBUG_API', 'MONGODB_URI', 'MONGODB_DB'
        ];
        const keys = Array.isArray(config.editableKeys) ? config.editableKeys : FALLBACK_KEYS;
        let text = '⚙️ CONFIGURACIÓN EDITABLE\n\n';

        keys.forEach((key, i) => {
            const value = config.getRaw(key) || '(no configurado)';
            const display = key.includes('KEY') || key.includes('TOKEN')
                ? value.substring(0, 10) + '...'
                : value;
            text += `${i + 1}. ${key}: ${display}\n`;
        });

        text += `\n📝 Responde con el NÚMERO y luego el nuevo valor.\nEjemplo: 4 → claude-haiku-4-5`;

        this.configState.isConfiguring = true;
        this.configState.selectedKey = null;
        await this.ctx.sendMessage(text, { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] });
    }

    async handleConfigInput(text) {
        if (!this.configState.isConfiguring) return;

        if (!this.configState.selectedKey) {
            const keys = config.editableKeys;
            const idx = parseInt(text.trim()) - 1;
            if (isNaN(idx) || idx < 0 || idx >= keys.length) {
                await this.ctx.sendMessage(`❌ Número inválido (1-${keys.length})`, { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] });
                return;
            }
            this.configState.selectedKey = keys[idx];
            await this.ctx.sendMessage(`✏️ ${this.configState.selectedKey}\n\nEscribe el nuevo valor:`, { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] });
            return;
        }

        const key = this.configState.selectedKey;
        const value = text.trim();
        const ok = this.ctx.updateEnvFile(key, value);

        if (key === 'CRON_SCHEDULE') this.ctx.cronSchedule = value;
        if (key === 'CRON_ENABLED') {
            value === 'true' ? this.ctx.startCron(this.ctx.cronSchedule) : this.ctx.stopCron();
        }

        await this.ctx.sendMessage(ok
            ? `✅ ${key} actualizado.\n\n/configuration para más cambios`
            : `❌ Error guardando ${key}`,
            { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] }
        );

        this.configState.isConfiguring = false;
        this.configState.selectedKey = null;
    }

    async handleCallback(callbackQueryId, data, messageId) {
        await this.ctx.answerCallback(callbackQueryId);

        // Handle coin selections from the inline keyboard
        if (data.startsWith('/')) {
            if (data === '/init') return await this.handleInit();
            if (data === '/start') return await this.handleStart();
            if (data === '/help') return await this.handleHelp();
            if (data === '/status') return await this.handleStatus();
            if (data === '/configuration') return await this.handleConfiguration();
            if (data === '/cron') return await this.handleCron();
            if (data === '/stats') return await this.handleTradingStats();

            const symbol = data.substring(1).toUpperCase();
            if (COINS.some(c => c.symbol === symbol)) {
                await this.handleCoinCommand(symbol);
                return;
            }
        }

        if (data === 'cron_on') {
            const ok = this.ctx.startCron(this.ctx.cronSchedule);
            await this.ctx.editMessage(messageId,
                ok
                    ? `✅ Cron activado\nSchedule: ${this.ctx.cronSchedule}`
                    : `❌ Error activando cron. Schedule actual: ${this.ctx.cronSchedule}`
            );
            return;
        }

        if (data === 'cron_off') {
            this.ctx.stopCron();
            await this.ctx.editMessage(messageId, '⏹ Cron desactivado.');
            return;
        }

        if (data === 'cron_now') {
            await this.ctx.editMessage(messageId, '⏳ Ejecutando ciclo ahora...');
            try {
                const pairs = config.trading.pairs;
                for (const coin of pairs) {
                    await runAgentCycle('manual', coin);
                }
                await this.ctx.editMessage(messageId, '✅ Ciclo completado. Revisa el reporte arriba ↑');
            } catch (err) {
                await this.ctx.editMessage(messageId, `❌ Error: ${err.message}`);
            } finally {
                await this.handleInit();
            }
            return;
        }

        if (data.startsWith('cron_set_')) {
            const expr = data.replace('cron_set_', '');
            const ok = this.ctx.startCron(expr);
            await this.ctx.editMessage(messageId,
                ok
                    ? `✅ Cron actualizado\nCiclo: ${CronParse(expr)}\nEstado: ACTIVO`
                    : `❌ Error con schedule: ${expr}`
            );
            return;
        }
    }
}
