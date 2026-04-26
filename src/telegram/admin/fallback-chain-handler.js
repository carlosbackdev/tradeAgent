/**
 * telegram/admin/fallback-chain-handler.js
 *
 * Telegram UI for the Admin-only Fallback Chain feature.
 * Accessible via the main menu button "🔗 FALLBACK CHAIN" (admin only).
 *
 * Handles:
 *  - /fallback_chain          → status + enable/disable toggle
 *  - FALLBACK_SET_PROVIDER:1  → show provider picker for slot 1
 *  - FALLBACK_SET_PROVIDER:2  → show provider picker for slot 2
 *  - FALLBACK_SET_PROVIDER:3  → show provider picker for slot 3
 *  - FALLBACK_PICK:<slot>:<provider> → show model picker for that provider
 *  - FALLBACK_CONFIRM:<slot>:<provider>:<model> → save slot config
 *  - FALLBACK_TOGGLE          → enable / disable the chain
 */

import { PROVIDER_MODELS } from '../../agent/entities/models.js';
import { getFallbackChain, isFallbackChainEnabled } from '../../agent/services/fallback-chain.js';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const PROVIDER_LABELS = {
  anthropic: '🟣 Anthropic',
  openai: '🟢 OpenAI',
  gemini: '🔵 Gemini',
  deepseek: '🟡 DeepSeek',
  groq: '⚡ Groq',
};

export class FallbackChainHandler {
  constructor(botContext) {
    this.ctx = botContext;
  }

  // ── Status / main screen ──────────────────────────────────────────

  async handleFallbackChainMenu() {
    const userCfg = this.ctx.readEnvFile();
    const enabled = isFallbackChainEnabled(userCfg);
    const chain = getFallbackChain(userCfg);

    let statusText = `🔗 <b>FALLBACK CHAIN</b>\n\n`;
    statusText += `Estado: ${enabled ? '✅ ACTIVA' : '⏸ INACTIVA'}\n\n`;
    statusText += `Si el modelo principal falla, se intentan los siguientes en orden\n`;
    statusText += `Recomendacion practica, usar primero providers con modelos gratuitos si fallan por limtes,
    usar provider con api key de pago.\n\n`;

    if (chain.length === 0) {
      statusText += '⚠️ <i>Sin providers configurados.</i>\n';
      statusText += 'Configura al menos un slot para activar.\n';
    } else {
      statusText += '<b>Cadena actual:</b>\n';
      chain.forEach(({ provider, model }, i) => {
        const label = PROVIDER_LABELS[provider] || provider;
        statusText += `  ${i + 1}. ${label} — <code>${model}</code>\n`;
      });
    }

    statusText += '\n<i>Si el provider 1 falla (rate-limit / quota), se intenta el 2, luego el 3.</i>';

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: enabled ? '⏸ Desactivar' : '▶️ Activar',
            callback_data: 'FALLBACK_TOGGLE'
          }
        ],
        [
          { text: `1️⃣ Slot 1${chain[0] ? ` (${chain[0].provider})` : ''}`, callback_data: 'FALLBACK_SET_PROVIDER:1' },
          { text: `2️⃣ Slot 2${chain[1] ? ` (${chain[1].provider})` : ''}`, callback_data: 'FALLBACK_SET_PROVIDER:2' },
          { text: `3️⃣ Slot 3${chain[2] ? ` (${chain[2].provider})` : ''}`, callback_data: 'FALLBACK_SET_PROVIDER:3' },
        ],
        [{ text: '🔙 ATRÁS', callback_data: '/admin' }]
      ]
    };

    await this.ctx.sendMessage(statusText, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  // ── Toggle enabled/disabled ───────────────────────────────────────

  async handleToggle(messageId) {
    if (!this.ctx.isAdmin) return;
    const userCfg = this.ctx.readEnvFile();
    const current = userCfg.getRaw('FALLBACK_CHAIN_ENABLED') === 'true';
    const next = !current;

    this.ctx.updateEnvFile('FALLBACK_CHAIN_ENABLED', String(next));

    await this.ctx.editMessage(
      messageId,
      next ? '✅ Fallback chain <b>ACTIVADA</b>.' : '⏸ Fallback chain <b>DESACTIVADA</b>.',
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔗 VER ESTADO', callback_data: '/fallback_chain' }]] }
      }
    );
  }

  // ── Slot: pick provider ───────────────────────────────────────────

  async handleSetProvider(slot, messageId) {
    if (!this.ctx.isAdmin) return;
    const providers = Object.keys(PROVIDER_MODELS);
    const rows = chunk(
      providers.map(p => ({
        text: PROVIDER_LABELS[p] || p,
        callback_data: `FALLBACK_PICK:${slot}:${p}`
      })),
      2
    );
    rows.push([{ text: '🔙 CANCELAR', callback_data: '/fallback_chain' }]);

    await this.ctx.editMessage(
      messageId,
      `🔗 <b>SLOT ${slot} — Elige provider:</b>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
    );
  }

  // ── Slot: pick model for provider ─────────────────────────────────

  async handlePickProvider(slot, provider, messageId) {
    if (!this.ctx.isAdmin) return;
    const models = PROVIDER_MODELS[provider] || [];
    if (models.length === 0) {
      await this.ctx.editMessage(messageId, `❌ No hay modelos definidos para <b>${provider}</b>.`, { parse_mode: 'HTML' });
      return;
    }

    const rows = chunk(
      models.map(m => ({
        text: m,
        callback_data: `FALLBACK_CONFIRM:${slot}:${provider}:${m}`
      })),
      1
    );
    rows.push([{ text: '🔙 CANCELAR', callback_data: '/fallback_chain' }]);

    await this.ctx.editMessage(
      messageId,
      `🔗 <b>SLOT ${slot} — ${PROVIDER_LABELS[provider] || provider}</b>\nElige modelo:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
    );
  }

  // ── Slot: confirm + save ──────────────────────────────────────────

  async handleConfirm(slot, provider, model, messageId) {
    if (!this.ctx.isAdmin) return;

    // Persist slot config
    this.ctx.updateEnvFile(`FALLBACK_CHAIN_${slot}`, provider);
    this.ctx.updateEnvFile(`FALLBACK_CHAIN_${slot}_MODEL`, model);

    // Check if we have an API key for this provider; if not, warn
    const userCfg = this.ctx.readEnvFile();
    const providerKeyName = `AI_PROVIDER_API_KEY_${provider.toUpperCase()}`;
    const hasKey = !!userCfg.getRaw(providerKeyName);

    let msg = `✅ <b>Slot ${slot} guardado</b>\n\n${PROVIDER_LABELS[provider] || provider} — <code>${model}</code>`;
    if (!hasKey) {
      msg += `\n\n⚠️ <b>Atención:</b> No tienes API Token guardada para <b>${provider}</b>.\n`
        + `Ve a ⚙️ API CONFIG → cambia el provider a <b>${provider}</b> y guarda la token.`;
    }

    await this.ctx.editMessage(
      messageId,
      msg,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🔗 VER CADENA', callback_data: '/fallback_chain' }]] }
      }
    );
  }
}
