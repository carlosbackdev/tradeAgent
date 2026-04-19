import cron from 'node-cron';
import { runAgentCycle } from '../agent/executor.js';
import { logger } from '../utils/logger.js';
import { CronParse } from '../utils/formatter.js';
import { getTradingStats, getTradingPerformance } from '../utils/mongodb.js';
import { config } from '../config/config.js';
import { CRON_PRESETS } from './entities/cronPresets.js';

const COINS = [
    { symbol: 'BTC', name: 'Bitcoin', emoji: '₿' },
    { symbol: 'ETH', name: 'Ethereum', emoji: '◇' },
    { symbol: 'SOL', name: 'Solana', emoji: '◎' },
    { symbol: 'VVV', name: 'Venice Token', emoji: '🦋' },
    { symbol: 'XRP', name: 'Ripple', emoji: '✕' },
];


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
                    { text: '🤖 AGENT CONFIG', callback_data: '/agent' },
                    { text: '⚙️ API CONFIG', callback_data: '/configuration' },
                ],
                [
                    { text: '💬 ASK AGENT', callback_data: '/ask' },
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
                    { text: '🤖 AGENT CONFIG', callback_data: '/agent' },
                    { text: '⚙️ API CONFIG', callback_data: '/configuration' },
                ],
                [
                    { text: '💬 ASK AGENT', callback_data: '/ask' },
                    { text: '❓ HELP', callback_data: '/help' }
                ]
            ]
        };

        await this.ctx.sendMessage('🤖 Acciones disponibles:', initKeyboard);
    }

    async handleAsk() {
        const pairs = config.trading.pairs;
        const inline_keyboard = chunk(
            pairs.map(p => ({ text: `❓ ${p}`, callback_data: `ask_coin:${p}` })),
            2
        );
        inline_keyboard.push([{ text: '🔙 ATRÁS', callback_data: '/init' }]);

        await this.ctx.sendMessage(
            '💬 *PREGUNTA AL AGENTE*\n\nSelecciona una moneda para analizar con tu pregunta:',
            { parse_mode: 'Markdown', inline_keyboard }
        );
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
        const dry = config.debug.dryRun ? '🔒 DRY-RUN' : '🟢 REAL MONEY';
        const cronSt = this.ctx.getCronStatus();
        let parseCron = CronParse(cronSt.schedule);

        await this.ctx.sendMessage(`📊 ESTADO ACTUAL DEL AGENTE

🎯 Pares: ${config.trading.pairs.join(',')}
🧐 Personalidad: ${config.trading.personalityAgent}
🔮 Vision: ${config.trading.visionAgent}
🕯️ Velas: a ${config.indicators.candlesInterval} minutos

💰 Max trade: ${(config.trading.maxTradeSize * 100).toFixed(0)}%
💵 Min orden: $${config.trading.minOrderUsd}

🎯 TP: ${config.trading.takeProfitPct}%
🎯 SL: ${config.trading.stopLossPct}%

🧠 Modelo: ${config.anthropic.model}

⏰ Cron: ${cronSt.enabled ? '✅ ACTIVO' : '⏸ INACTIVO'}
📅 Ciclo: ${parseCron}

${dry}`, { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] });
    }

    async handleTradingStats() {
        const stats = await getTradingPerformance();

        if (!stats) {
            await this.ctx.sendMessage(
                '❌ No se pudieron obtener las estadísticas',
                { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] }
            );
            return;
        }

        const openPos = stats.openPositions?.length > 0
            ? '\n\n📂 POSICIONES ABIERTAS\n' + stats.openPositions.map(p =>
                `  • ${p.symbol}: ${p.qty} @ $${p.avgPrice} (coste $${p.totalCost})`
            ).join('\n')
            : '';

        const accumRend = stats.accumulatedRendimiento;
        const accumSign = accumRend > 0 ? '+' : '';
        const accumEmoji = accumRend > 0 ? '🟢' : accumRend < 0 ? '🔴' : '⚪';

        await this.ctx.sendMessage(
            `📊 ESTADÍSTICAS TRADING AGENT

🤔 Total decisions: ${stats.totalDecisions}
📦 Total executed orders: ${stats.totalOrders}
🛒 Total buys: ${stats.totalBuys}
🤝🏻 Total sells: ${stats.totalSells}
⚙️ Ratio de ejecución: ${stats.executionRate}

💰 BENEFICIO / PÉRDIDA REALIZADO
💵 PnL realizado: ${stats.totalRealizedPnL} USD
📈 ROI realizado: ${stats.roiRealized}
💹 Total invertido: $${stats.totalInvested}
${accumEmoji} Rendimiento acumulado: ${accumSign}${accumRend}%

🏆 Winning trades: ${stats.winningTrades}
📉 Losing trades: ${stats.losingTrades}
📊 Closed trades: ${stats.closedTrades}
🎯 Win rate: ${stats.winRate}${openPos}`,
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
        const keys = config.editableKeys;
        let text = '⚙️ CONFIGURACIÓN API\n\n';

        keys.forEach((key, i) => {
            const value = config.getRaw(key) || '(no configurado)';
            const display = key.includes('KEY') || key.includes('TOKEN')
                ? value.substring(0, 10) + '...'
                : value;
            text += `${i + 1}. ${key}: ${display}\n`;
        });

        text += `\n📝 Responde con el NÚMERO y luego el nuevo valor.\nEjemplo: 4 → claude-haiku-4-5`;

        this.configState.isConfiguring = true;
        this.configState.mode = 'api';
        this.configState.selectedKey = null;
        await this.ctx.sendMessage(text, { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] });
    }

    async handleConfigInput(text) {
        if (this.configState.isConfiguring && this.configState.mode === 'asking') {
            const question = text.trim();
            const symbol = this.configState.symbol;

            this.configState.isConfiguring = false;
            this.configState.mode = null;
            this.configState.symbol = null;

            await this.ctx.sendMessage(`⏳ Procesando pregunta para *${symbol}*...\n_"${question}"_`, { parse_mode: 'Markdown' });

            try {
                await runAgentCycle('manual', symbol, question);
            } catch (err) {
                await this.ctx.sendMessage(`❌ Error: ${err.message}`);
            }
            return;
        }

        if (this.configState.isConfiguring) {
            if (!this.configState.selectedKey) {
                const keys = this.configState.mode === 'agent'
                    ? config.editableKeysAgent
                    : config.editableKeys;

                const idx = parseInt(text.trim()) - 1;
                if (isNaN(idx) || idx < 0 || idx >= keys.length) {
                    await this.ctx.sendMessage(`❌ Número inválido (1-${keys.length})`, { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] });
                    return;
                }

                const key = keys[idx];
                this.configState.selectedKey = key;

                // Interactive options for specific agent keys
                if (key === 'VISION_AGENT') {
                    await this.ctx.sendMessage('🔭 Selecciona la VISIÓN del agente:', {
                        inline_keyboard: [
                            [
                                { text: 'Short', callback_data: 'SET_AGENT_CFG:VISION_AGENT:short' },
                                { text: 'Medium', callback_data: 'SET_AGENT_CFG:VISION_AGENT:medium' },
                                { text: 'Long', callback_data: 'SET_AGENT_CFG:VISION_AGENT:long' }
                            ],
                            [{ text: '🔙 CANCELAR', callback_data: '/agent' }]
                        ]
                    });
                    return;
                }

                if (key === 'PERSONALITY_AGENT') {
                    await this.ctx.sendMessage('🧠 Selecciona la PERSONALIDAD del agente:', {
                        inline_keyboard: [
                            [
                                { text: 'Conservative', callback_data: 'SET_AGENT_CFG:PERSONALITY_AGENT:Conservative' },
                                { text: 'Moderate', callback_data: 'SET_AGENT_CFG:PERSONALITY_AGENT:Moderate' },
                                { text: 'Aggressive', callback_data: 'SET_AGENT_CFG:PERSONALITY_AGENT:Aggressive' }
                            ],
                            [{ text: '🔙 CANCELAR', callback_data: '/agent' }]
                        ]
                    });
                    return;
                }

                await this.ctx.sendMessage(`✏️ ${this.configState.selectedKey}\n\nEscribe el nuevo valor:`, { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] });
                return;
            }

            const key = this.configState.selectedKey;
            const value = text.trim();
            const ok = this.ctx.updateEnvFile(key, value);

            await this.ctx.sendMessage(ok
                ? `✅ ${key} actualizado.\n\nRegresa al menú con /init`
                : `❌ Error guardando ${key}`,
                { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] }
            );

            this.configState.isConfiguring = false;
            this.configState.selectedKey = null;
        }
    }
    async handleConfigurationAgent() {
        const keys = config.editableKeysAgent;
        let text = '⚙️ CONFIGURACIÓN AGENT\n\n';

        keys.forEach((key, i) => {
            const value = config.getRaw(key) || '(no configurado)';
            if (key == 'INDICATORS_CANDLES_INTERVAL') {
                text += `${i + 1}. ${key}: ${value} (min)\n`;
            } else if (key == 'TAKE_PROFIT_PCT' || key == 'STOP_LOSS_PCT') {
                text += `${i + 1}. ${key}: ${value} %\n`;
            } else if (key == 'MIN_ORDER') {
                text += `${i + 1}. ${key}: ${value} USD\n`;
            }
            else {
                text += `${i + 1}. ${key}: ${value}\n`;
            }
        });

        text += `\n📝 Responde con el NÚMERO y luego el nuevo valor SOLO NUMERICO.\nEjemplo: 8 → 20\n`;
        text += `\n❓Para los Ciclos temporales se usan las monedas configuradas en TRADING_PAIRS se analizaran 
        cada Ciclo de agente una a una de la lista compuesta.`;

        this.configState.isConfiguring = true;
        this.configState.mode = 'agent';
        this.configState.selectedKey = null;
        await this.ctx.sendMessage(text, { inline_keyboard: [[{ text: '🔙 ATRÁS', callback_data: '/init' }]] });
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
            if (data === '/agent') return await this.handleConfigurationAgent();
            if (data === '/ask') return await this.handleAsk();

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

        if (data.startsWith('ask_coin:')) {
            const symbol = data.split(':')[1];
            this.configState.isConfiguring = true;
            this.configState.mode = 'asking';
            this.configState.symbol = symbol;

            await this.ctx.editMessage(messageId,
                `💬 *PREGUNTA PARA ${symbol}*\n\nEscribe tu pregunta ahora. El agente analizará el mercado y responderá teniendo en cuenta tu consulta.`,
                { parse_mode: 'Markdown', inline_keyboard: [[{ text: '🔙 CANCELAR', callback_data: '/ask' }]] }
            );
            return;
        }

        if (data.startsWith('SET_AGENT_CFG:')) {
            const [, key, value] = data.split(':');
            const ok = this.ctx.updateEnvFile(key, value);

            await this.ctx.editMessage(messageId, ok
                ? `✅ ${key} actualizado a: *${value}*`
                : `❌ Error actualizando ${key}`,
                { parse_mode: 'Markdown', inline_keyboard: [[{ text: '🔙 VOLVER', callback_data: '/agent' }]] }
            );

            this.configState.isConfiguring = false;
            this.configState.selectedKey = null;
            return;
        }
    }
}