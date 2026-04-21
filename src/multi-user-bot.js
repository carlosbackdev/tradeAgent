/**
 * multi-user-bot.js
 * Main Telegram bot that handles ALL users sharing ONE bot token.
 *
 * Flow:
 *   1. Receive update from Telegram
 *   2. Identify user by telegram_id
 *   3. If not invited → reject with message
 *   4. If pending_invite → claim invite, start onboarding
 *   5. If pending_setup → route to onboarding wizard
 *   6. If active → route to their UserSession instance
 *
 * Admin commands (only from ADMIN_TELEGRAM_ID):
 *   /invite @username   - Add a user
 *   /users              - List all users and their status
 *   /revoke @username   - Suspend a user
 *   /admin_status       - Bot health overview
 */

import cron from 'node-cron';
import { logger } from './utils/logger.js';
import {
  claimInvite,
  claimInviteByCode,
  findUserByTelegramId,
  inviteUser,
  listUsers,
  revokeUser,
  updateUserConfig,
} from './users/user-registry.js';
import {
  getWelcomeMessage,
  processOnboardingStep,
  getStep,
  buildOnboardingStatus,
  buildProgressBar,
  TOTAL_STEPS,
} from './users/onboarding-wizard.js';
import { buildUserConfig, validateUserConfig } from './users/user-config.js';
import { UserSession } from './users/user-session.js';

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;
const BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Active user sessions: Map<telegramId, UserSession>
const sessions = new Map();
let botUser = null; 

// ─────────────────────────────────────────────────────────────────
// Telegram API helpers
// ─────────────────────────────────────────────────────────────────

async function telegramRequest(method, payload) {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram ${method} failed: ${body}`);
  }
  return res.json();
}

async function sendMessage(chatId, text, extra = {}) {
  if (!text?.trim()) return;
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text: text.trim(),
    parse_mode: 'HTML',
    ...extra,
  }).catch(err => logger.warn(`sendMessage failed to ${chatId}: ${err.message}`));
}

async function editMessage(chatId, messageId, text, extra = {}) {
  const payload = { 
    chat_id: chatId, 
    message_id: messageId, 
    text, 
    parse_mode: 'HTML',
    ...(extra.reply_markup ? { reply_markup: extra.reply_markup } : extra)
  };
  return telegramRequest('editMessageText', payload).catch((err) => {
    logger.warn(`editMessage failed to ${chatId}: ${err.message}`);
  });
}

async function answerCallback(callbackQueryId, text = '✅') {
  return telegramRequest('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────
// Admin commands
// ─────────────────────────────────────────────────────────────────

async function handleAdminCommand(chatId, text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '/invite') {
    const username = parts[1];
    if (!username) {
      return sendMessage(chatId, '❌ Uso: `/invite @username`');
    }
    const result = await inviteUser({ telegramUsername: username, invitedBy: String(chatId) });
    if (result.ok) {
        if (!botUser?.username) {
          await sendMessage(chatId, `✅ @${result.username} ha sido invitado. Cargando nombre del bot...`);
          return;
        }

        const inviteLink = `https://t.me/${botUser.username}?start=invite_${result.inviteCode}`;
        await sendMessage(
          chatId,
          `✅ @${result.username} ha sido invitado.\n\n` +
          `Pásale este enlace para activar su acceso:\n${inviteLink}`
        );
    } else {
      await sendMessage(chatId, `⚠️ ${result.reason}`);
    }
    return;
  }

  if (cmd === '/users') {
    const users = await listUsers();
    if (!users.length) return sendMessage(chatId, 'No hay usuarios registrados.');

    const statusEmoji = { pending_invite: '⏳', pending_setup: '🔧', active: '✅', suspended: '🚫' };
    let msg = `👥 *Usuarios registrados* (${users.length})\n\n`;
    for (const u of users) {
      const emoji = statusEmoji[u.status] || '❓';
      const pairs = u.config?.TRADING_PAIRS || '—';
      msg += `${emoji} @${u.telegram_username || '?'} — ${u.status}\n`;
      msg += `   ID: \`${u.telegram_id || 'pendiente'}\` | Pares: ${pairs}\n`;
    }
    return sendMessage(chatId, msg);
  }

  if (cmd === '/revoke') {
    const target = parts[1];
    if (!target) return sendMessage(chatId, '❌ Uso: `/revoke @username`');
    const result = await revokeUser(target);
    if (result.ok) {
      // Destroy their active session
      const user = await findUserByTelegramId(result.userId);
      if (user) sessions.delete(user.telegram_id);
      await sendMessage(chatId, `🚫 @${result.username} ha sido suspendido.`);
    } else {
      await sendMessage(chatId, `⚠️ ${result.reason}`);
    }
    return;
  }

  if (cmd === '/admin_status') {
    const users = await listUsers();
    const active = users.filter(u => u.status === 'active').length;
    const pending = users.filter(u => u.status === 'pending_setup' || u.status === 'pending_invite').length;
    const sessions_count = sessions.size;

    await sendMessage(chatId,
      `🤖 *Admin Status*\n\n` +
      `👥 Total usuarios: ${users.length}\n` +
      `✅ Activos: ${active}\n` +
      `🔧 Pendientes: ${pending}\n` +
      `⚡ Sesiones vivas: ${sessions_count}\n` +
      `🖥 Node: ${process.version}`
    );
    return;
  }

  // Unknown admin command - pass to their personal session if active
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Onboarding flow
// ─────────────────────────────────────────────────────────────────

async function handleOnboarding(user, text, messageId) {
  const chatId = user.telegram_id;

  // Special commands during onboarding
  if (text === '/status') {
    return sendMessage(chatId, buildOnboardingStatus(user));
  }

  if (text === '/start' || text === '/help') {
    const step = getStep(user.onboarding_step || 1);
    return sendMessage(chatId, (step ? step.prompt : '¡Casi listo! Usa /status para ver tu progreso.'));
  }

  // Process their answer to current step
  const result = await processOnboardingStep(user, text);

  if (result.error) {
    await sendMessage(chatId, `❌ ${result.error}\n\n${result.prompt}`);
    return;
  }

  if (result.done) {
    // Onboarding complete - activate session
    await sendMessage(chatId, result.activationMessage);
    // Reload user from DB and create session
    const freshUser = await findUserByTelegramId(chatId);
    await activateUserSession(freshUser);
    return;
  }

  // Show next step
  await sendMessage(chatId, result.nextPrompt);
}

// ─────────────────────────────────────────────────────────────────
// Session management
// ─────────────────────────────────────────────────────────────────

async function activateUserSession(user) {
  if (sessions.has(user.telegram_id)) return sessions.get(user.telegram_id);

  const userConfig = buildUserConfig(user);
  const validation = validateUserConfig(userConfig);

  if (!validation.ok) {
    logger.warn(`User ${user.telegram_id} has incomplete config: ${validation.missing.join(', ')}`);
    return null;
  }

  const session = new UserSession({
    user,
    userConfig,
    sendMessage: (text, extra) => sendMessage(user.telegram_id, text, extra),
    editMessage: (msgId, text, markup) => editMessage(user.telegram_id, msgId, text, markup),
    answerCallback: (cbId, text) => answerCallback(cbId, text),
  });

  await session.init();
  sessions.set(user.telegram_id, session);
  logger.info(`✅ Session activated for user ${user.telegram_username} (${user.telegram_id})`);
  return session;
}

// ─────────────────────────────────────────────────────────────────
// Main update router
// ─────────────────────────────────────────────────────────────────

async function routeUpdate(update) {
  // Extract common fields
  const msg = update.message;
  const cb = update.callback_query;

  const fromId = msg?.from?.id || cb?.from?.id;
  const fromUsername = msg?.from?.username || cb?.from?.username;
  const text = msg?.text || '';
  const cbData = cb?.data;
  const cbId = cb?.id;
  const msgId = msg?.message_id || cb?.message?.message_id;
  const chatId = String(fromId);

  const textTrimmed = (text || '').trim();
  const startMatch = textTrimmed.match(/^\/start(?:\s+(.+))?$/i);
  const startPayload = startMatch?.[1] || null;

  if (!fromId) return;

  if (startMatch) {
    logger.info(`Received /start from ${fromUsername || fromId}${startPayload ? ' with payload: ' + startPayload : ''}`);
  }

  // ── Identify user ────────────────────────────────────────────────
  let user = await findUserByTelegramId(chatId);

  // ── Admin commands for non-active or guest admins ────────────────
  const isAdmin = ADMIN_ID && chatId === String(ADMIN_ID);
  if (isAdmin && !sessions.has(chatId) && (text.startsWith('/invite') || text.startsWith('/users') || text.startsWith('/revoke') || text.startsWith('/admin_status'))) {
    const handled = await handleAdminCommand(chatId, text);
    if (handled !== null) return;
  }

  // Try to claim a pending invite by code (deep link)
  if (!user && startPayload?.startsWith('invite_')) {
    const inviteCode = startPayload.replace('invite_', '').trim();
    logger.info(`Attempting to claim invite by code: ${inviteCode} for ${fromId} (@${fromUsername || '?'})`);
    user = await claimInviteByCode(chatId, inviteCode, fromUsername);
    if (user) logger.info(`✅ Invite code claimed successfully for ${user.telegram_username}`);
  }

  // Try to claim a pending invite by username (fallback)
  if (!user || user.status === 'pending_invite') {
    if (fromUsername) {
       logger.info(`Attempting to claim invite by username: ${fromUsername} for ${fromId}`);
       user = await claimInvite(chatId, fromUsername);
       if (user) logger.info(`✅ Invite username claimed successfully for ${user.telegram_username}`);
    }
  }

  // Not invited at all
  if (!user) {
    if (startMatch) {
      await sendMessage(chatId,
        `👋 Hola! Este bot es privado y solo está disponible por invitación.\n\n` +
        `Si tienes acceso, contacta con el administrador.`
      );
    }
    return;
  }

  // Suspended user
  if (user.status === 'suspended') {
    await sendMessage(chatId, '🚫 Tu acceso ha sido suspendido. Contacta con el administrador.');
    return;
  }

  // ── Pending setup — route to onboarding ─────────────────────────
  if (user.status === 'pending_setup' || user.status === 'pending_invite') {
    if (startMatch) {
      logger.info(`Sending welcome message to user ${chatId} (@${fromUsername || '?'})`);
      await sendMessage(chatId, getWelcomeMessage(fromUsername), {
        reply_markup: {
          inline_keyboard: [[{ text: '▶️ Comenzar configuración', callback_data: 'onboarding_start' }]]
        }
      });
      return;
    }

    if (cbData === 'onboarding_start' || cbData === 'onboarding_start_force') {
      await answerCallback(cbId);
      
      if (cbData === 'onboarding_start_force') {
        const { updateUserStatus } = await import('./users/user-registry.js');
        await updateUserStatus(chatId, 'pending_setup');
        // We'll also need to update the local 'user' object or the next steps will fail
        user.status = 'pending_setup';
        user.onboarding_step = 0;
      }

      const firstStep = getStep(0);
      const bar = buildProgressBar(0, TOTAL_STEPS);
      await sendMessage(chatId, `${bar}\n\n${firstStep.prompt}`);
      return;
    }

    if (cb && !cbData?.startsWith('onboarding')) {
      await answerCallback(cbId, 'Completa la configuración primero');
      return;
    }

    if (msg) await handleOnboarding(user, text, msgId);
    return;
  }

  // ── Active user — route to their session ─────────────────────────
  if (user.status === 'active') {
    let session = sessions.get(user.telegram_id);
    if (!session) {
      session = await activateUserSession(user);
    }

    if (!session) {
      // Session failed to activate — incomplete config
      // If admin pressed the "start config" button, reset to onboarding
      if (cbData === 'onboarding_start_force') {
        await answerCallback(cbId);
        const { setUserStatus, setOnboardingStep } = await import('./users/user-registry.js');
        await setUserStatus(chatId, 'pending_setup');
        await setOnboardingStep(chatId, 0);
        user.status = 'pending_setup';
        user.onboarding_step = 0;
        const firstStep = getStep(0);
        const bar = buildProgressBar(0, TOTAL_STEPS);
        await sendMessage(chatId, `${bar}\n\n${firstStep.prompt}`);
        return;
      }

      // Show the "config incomplete" prompt with onboarding button
      await sendMessage(chatId,
        '<b>⚠️ Configuración incompleta</b>\n\n' +
        'Faltan credenciales necesarias para operar (API Key de Revolut, clave privada o Anthropic).\n\n' +
        'Pulsa el botón de abajo para configurar tu cuenta paso a paso.',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '🔧 Configurar ahora', callback_data: 'onboarding_start_force' }]]
          }
        }
      );
      return;
    }

    if (cb) {
      await session.handleCallback(cbId, cbData, msgId);
    } else if (msg) {
      await session.handleMessage(text, msgId);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Long polling loop
// ─────────────────────────────────────────────────────────────────

let updateOffset = 0;
let isPolling = false;

async function getUpdates() {
  try {
    const res = await fetch(`${BASE}/getUpdates?offset=${updateOffset}&timeout=25`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.result || [];
  } catch {
    return [];
  }
}

async function pollOnce() {
  if (isPolling) return;
  isPolling = true;
  try {
    const updates = await getUpdates();
    for (const update of updates) {
      updateOffset = update.update_id + 1;
      routeUpdate(update).catch(err => {
        if (!err.message?.includes('409')) {
          logger.error('Update routing error:', err.message);
        }
      });
    }
  } finally {
    isPolling = false;
  }
}

// ─────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────

export async function startMultiUserBot() {
  if (!BOT_TOKEN) {
    logger.warn('⚠️ TELEGRAM_BOT_TOKEN not set — multi-user bot disabled');
    return;
  }

  if (!ADMIN_ID) {
    logger.warn('⚠️ ADMIN_TELEGRAM_ID not set — admin commands disabled');
  }

  logger.info('🤖 Multi-user Telegram bot starting...');
  logger.info(`👤 Admin ID: ${ADMIN_ID || '(not set)'}`);

  // Auto-detect bot identity
  try {
    const me = await telegramRequest('getMe', {});
    botUser = me.result;
    logger.info(`🤖 Bot identity: @${botUser.username} (${botUser.first_name})`);
  } catch (err) {
    logger.warn(`⚠️ Could not fetch bot identity: ${err.message}`);
  }

  // Re-activate sessions for all active users on startup
  const { listUsers } = await import('./users/user-registry.js');
  const users = await listUsers().catch(() => []);
  const activeUsers = users.filter(u => u.status === 'active');
  logger.info(`🔄 Reactivating ${activeUsers.length} active user session(s)...`);

  for (const u of activeUsers) {
    const fullUser = await findUserByTelegramId(u.telegram_id).catch(() => null);
    if (fullUser) await activateUserSession(fullUser).catch(err => {
      logger.warn(`Failed to activate session for ${u.telegram_username}: ${err.message}`);
    });
  }

  // Start polling loop
  const poll = async () => {
    while (true) {
      await pollOnce();
      await new Promise(r => setTimeout(r, 1000));
    }
  };

  poll().catch(err => logger.error('Polling loop crashed:', err));
  logger.info('✅ Multi-user bot running');
}
