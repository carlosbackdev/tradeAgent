/**
 * telegram/response/callback-handler.js
 * Handles all inline keyboard callback_data events.
 * Extracted from TelegramHandlers to keep routing logic separate.
 *
 * Usage:
 *   const cb = new CallbackHandler(handlers, configState, botContext);
 *   await cb.handle(callbackQueryId, data, messageId);
 */

import { runAgentCycle } from '../../agent/executor.js';
import { CronParse } from '../../utils/formatter.js';
import { PROVIDER_MODELS } from '../../agent/entities/models.js';
import { COINS } from '../../agent/entities/coins.js';

export class CallbackHandler {
    /**
     * @param {import('../telegram-handlers.js').TelegramHandlers} handlers
     * @param {object} configState  - shared mutable reference from TelegramHandlers
     * @param {object} ctx          - botContext (sendMessage, editMessage, etc.)
     */
    constructor(handlers, configState, ctx) {
        this.h = handlers;
        this.configState = configState;
        this.ctx = ctx;
    }

    async handle(callbackQueryId, data, messageId) {
        await this.ctx.answerCallback(callbackQueryId);

        // ── Route commands that start with '/' ─────────────────────
        if (data.startsWith('/')) {
            if (data === '/init')          return await this.h.handleInit();
            if (data === '/start')         return await this.h.handleStart();
            if (data === '/help')          return await this.h.handleHelp();
            if (data === '/status')        return await this.h.handleStatus();
            if (data === '/configuration') return await this.h.handleConfiguration();
            if (data === '/cron')          return await this.h.handleCron();
            if (data === '/stats')         return await this.h.handleTradingStats();
            if (data === '/agent')         return await this.h.handleConfigurationAgent();
            if (data === '/ask')           return await this.h.handleAsk();
            if (data === '/admin')         return await this.h.handleAdminMenu();
            if (data === '/users')         return await this.h.handleListUsers();
            if (data === '/admin_status')  return await this.h.handleAdminStatus();
            if (data === '/fallback_chain') return await this.h.handleFallbackChain();

            const symbol = data.substring(1).toUpperCase();
            if (COINS.some(c => c.symbol === symbol)) {
                await this.h.handleCoinCommand(symbol);
                return;
            }
        }

        // ── Admin: invite prompt ────────────────────────────────────
        if (data === 'admin_invite_prompt') {
            if (!this.ctx.isAdmin) return;
            this.configState.isInviting = true;
            this.configState.isConfiguring = false;
            this.configState.mode = null;
            await this.ctx.sendMessage(
                '<b>👤 NUEVA INVITACIÓN</b>\n\n' +
                'Escribe a continuación el <b>@nombre_de_usuario</b> o el <b>ID numérico</b> del usuario que quieres autorizar.\n\n' +
                '<i>Nota: El usuario debe tener un alias (@) configurado en Telegram, o puedes usar su ID numérico.</i>',
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 CANCELAR', callback_data: '/admin' }]] } }
            );
            return;
        }

        // ── Cron controls ───────────────────────────────────────────
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
                const userCfg = this.ctx.readEnvFile();
                const pairs = userCfg.trading?.pairs || userCfg.editableKeysAgent;
                for (const coin of pairs) {
                    await runAgentCycle('manual', coin, '', userCfg);
                }
                await this.ctx.editMessage(messageId, '✅ Ciclo completado. Revisa el reporte abajo ↓');
            } catch (err) {
                await this.ctx.editMessage(messageId, `❌ Error: ${err.message}`);
            } finally {
                await this.h.handleInit();
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

        // ── Ask agent ───────────────────────────────────────────────
        if (data.startsWith('ask_coin:')) {
            const symbol = data.split(':')[1];
            this.configState.isConfiguring = true;
            this.configState.mode = 'asking';
            this.configState.symbol = symbol;

            await this.ctx.editMessage(messageId,
                `💬 <b>PREGUNTA PARA ${symbol}</b>\n\nEscribe tu pregunta ahora. El agente analizará el mercado y responderá teniendo en cuenta tu consulta.`,
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 CANCELAR', callback_data: '/ask' }]] } }
            );
            return;
        }

        // ── Fallback chain admin actions ────────────────────────────────

        if (data === 'FALLBACK_TOGGLE') {
            return await this.h.fallbackChain.handleToggle(messageId);
        }

        if (data.startsWith('FALLBACK_SET_PROVIDER:')) {
            const slot = data.split(':')[1];
            return await this.h.fallbackChain.handleSetProvider(slot, messageId);
        }

        if (data.startsWith('FALLBACK_PICK:')) {
            const [, slot, provider] = data.split(':');
            return await this.h.fallbackChain.handlePickProvider(slot, provider, messageId);
        }

        if (data.startsWith('FALLBACK_CONFIRM:')) {
            // Format: FALLBACK_CONFIRM:<slot>:<provider>:<model>
            // Model names may contain ':', so split only the first 3 parts
            const parts = data.split(':');
            const slot     = parts[1];
            const provider = parts[2];
            const model    = parts.slice(3).join(':');
            return await this.h.fallbackChain.handleConfirm(slot, provider, model, messageId);
        }

        // ── Agent / API config setters ──────────────────────────────
        if (data.startsWith('SET_AGENT_CFG:')) {
            const [, key, value] = data.split(':');
            let ok = this.ctx.updateEnvFile(key, value);

            // When provider changes: reset model + load or request provider-specific API token
            if (ok && key === 'AI_PROVIDER') {
                const defaultModel = PROVIDER_MODELS[value]?.[0] || '';
                if (defaultModel) {
                    this.ctx.updateEnvFile('AI_MODEL', defaultModel);
                }

                // Look for a stored token for the new provider
                const providerKey = `AI_PROVIDER_API_KEY_${value.toUpperCase()}`;
                const freshCfg = this.ctx.readEnvFile();
                const storedToken = freshCfg.getRaw(providerKey);

                if (storedToken) {
                    // Auto-activate the stored token for this provider
                    this.ctx.updateEnvFile('AI_PROVIDER_API_KEY', storedToken);
                    this.configState.isConfiguring = false;
                    this.configState.selectedKey = null;
                    this.configState.mode = null;

                    await this.ctx.editMessage(messageId,
                        `✅ <b>Provider → ${value.toUpperCase()}</b>\n\n` +
                        `🔑 API Token de ${value} cargada: <code>${storedToken.substring(0, 8)}...</code>`,
                        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⚙️ API CONFIG', callback_data: '/configuration' }]] } }
                    );
                } else {
                    // No stored token for this provider → ask the user to enter it
                    this.configState.isConfiguring = true;
                    this.configState.mode = 'awaiting_provider_token';
                    this.configState.selectedKey = 'AI_PROVIDER_API_KEY';
                    this.configState.pendingProvider = value;

                    await this.ctx.editMessage(messageId,
                        `✅ <b>Provider → ${value.toUpperCase()}</b>\n\n` +
                        `🔑 No tienes API Token guardada para <b>${value}</b>.\n\n` +
                        `Envía tu <b>API Token de ${value}</b>:`,
                        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 CANCELAR', callback_data: '/configuration' }]] } }
                    );
                }
                return;
            }

            this.configState.isConfiguring = false;
            this.configState.selectedKey = null;
            this.configState.mode = null;

            const backButton = key.includes('AI_')
                ? { text: '⚙️ API CONFIG', callback_data: '/configuration' }
                : { text: '🤖 VOLVER A AGENTE', callback_data: '/agent' };

            await this.ctx.editMessage(messageId,
                ok
                    ? `✅ <b>${key}</b> actualizado a <code>${value}</code>`
                    : `❌ Error actualizando ${key}`,
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[backButton]] } }
            );
            return;
        }
    }
}
