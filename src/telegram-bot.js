/**
 * src/telegram-bot.js
 * Telegram bot with long-polling.
 *
 * New in this version:
 *   /cron            — show cron status + inline keyboard to enable/disable/change schedule
 *   /cron <expr>     — set a new cron expression (e.g. /cron 0 * * * *)
 *   /cron on|off     — enable or disable cron without changing schedule
 *
 * All cron state is managed here and exported so index.js can read it.
 */

import 'dotenv/config';
import https from 'https';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { runAgentCycle } from './agent/executor.js';
import { logger } from './utils/logger.js';
import { CronParse } from './utils/formatter.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const ENV_PATH  = path.join(process.cwd(), '.env');

// ── Cron state (module-level singleton) ──────────────────────────
let cronTask     = null;   // node-cron scheduled task
let cronSchedule = process.env.CRON_SCHEDULE || '*/15 * * * *';
let cronEnabled  = process.env.CRON_ENABLED  === 'true';

// ── Update offset for long polling ───────────────────────────────
let updateOffset = 0;
let isPolling = false;  // Prevent concurrent polling

// ── Config edit state (per-user, single user bot) ─────────────────
const configState = { isConfiguring: false, selectedKey: null };

const COINS = [
  { symbol: 'BTC',    name: 'Bitcoin',      emoji: '₿'  },
  { symbol: 'ETH',    name: 'Ethereum',     emoji: '◇'  },
  { symbol: 'SOL',    name: 'Solana',       emoji: '◎'  },
  { symbol: 'VENICE', name: 'Venice Token', emoji: '🦋' },
  { symbol: 'XRP',    name: 'Ripple',       emoji: '✕'  },
];

const EDITABLE_CONFIG = [
  'REVOLUT_API_KEY', 'REVOLUT_BASE_URL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  'TRADING_PAIRS', 'MAX_TRADE_SIZE', 'MIN_ORDER',
  'CRON_ENABLED', 'CRON_SCHEDULE',
  'DRY_RUN', 'DEBUG_API','INDICATORS_CANDLES_INTERVAL'
];

// ── Cron presets ──────────────────────────────────────────────────
const CRON_PRESETS = [
  { label: '5 min',  expr: '*/5 * * * *'  },
  { label: '15 min', expr: '*/15 * * * *' },
  { label: '30 min', expr: '*/30 * * * *' },
  { label: '1 hora', expr: '0 * * * *'    },
  { label: '4 horas',expr: '0 */4 * * *'  },
];

// ─────────────────────────────────────────────────────────────────
//  Telegram helpers
// ─────────────────────────────────────────────────────────────────

function telegramRequest(method, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/${method}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': data.length },
    };

    const req = https.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const parsed = JSON.parse(body);
        if (res.statusCode === 200) resolve(parsed);
        else reject(new Error(`HTTP ${res.statusCode}: ${body}`));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendMessage(text, replyMarkup = null) {
  if (!text?.trim()) return;
  const payload = { chat_id: CHAT_ID, text: text.trim(), parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegramRequest('sendMessage', payload).catch(err =>
    logger.error('Telegram sendMessage failed:', err.message)
  );
}

async function editMessage(messageId, text, replyMarkup = null) {
  const payload = { chat_id: CHAT_ID, message_id: messageId, text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegramRequest('editMessageText', payload).catch(err =>
    logger.error('Telegram editMessage failed:', err.message)
  );
}

async function answerCallback(callbackQueryId, text = '✅') {
  return telegramRequest('answerCallbackQuery', {
    callback_query_id: callbackQueryId, text, show_alert: false,
  }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────
//  .env helpers
// ─────────────────────────────────────────────────────────────────

function readEnvFile() {
  try {
    const env = {};
    fs.readFileSync(ENV_PATH, 'utf-8').split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const [key, ...rest] = line.split('=');
      if (key) env[key.trim()] = rest.join('=').trim();
    });
    return env;
  } catch { return {}; }
}

function updateEnvFile(key, value) {
  try {
    let content = fs.readFileSync(ENV_PATH, 'utf-8');
    const regex = new RegExp(`^${key}=.*$`, 'm');
    content = regex.test(content)
      ? content.replace(regex, `${key}=${value}`)
      : content + `\n${key}=${value}`;
    fs.writeFileSync(ENV_PATH, content, 'utf-8');
    process.env[key] = value;
    return true;
  } catch (err) {
    logger.error(`updateEnvFile failed:`, err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────
//  Cron management
// ─────────────────────────────────────────────────────────────────

function startCron(schedule) {
  if (cronTask) { cronTask.stop(); cronTask = null; }

  if (!cron.validate(schedule)) {
    logger.error(`Invalid cron expression: ${schedule}`);
    return false;
  }

  cronTask = cron.schedule(schedule, async () => {
    logger.info(`⏰ Cron triggered: ${schedule}`);
    try {
      await runAgentCycle('cron');
    } catch (err) {
      logger.error('Cron cycle failed:', err.message);
    }
  });

  cronEnabled  = true;
  cronSchedule = schedule;
  updateEnvFile('CRON_ENABLED', 'true');
  updateEnvFile('CRON_SCHEDULE', schedule);
  logger.info(`✅ Cron started: ${schedule}`);
  return true;
}

function stopCron() {
  if (cronTask) { cronTask.stop(); cronTask = null; }
  cronEnabled = false;
  updateEnvFile('CRON_ENABLED', 'false');
  logger.info('⏹ Cron stopped');
}

function getCronStatus() {
  const next = cronEnabled && cronSchedule
    ? `Próximo ciclo según: >${cronSchedule}>`
    : 'Desactivado';
  return {
    enabled:  cronEnabled,
    schedule: cronSchedule,
    next,
  };
}

// ─────────────────────────────────────────────────────────────────
//  Command handlers
// ─────────────────────────────────────────────────────────────────

async function handleStart() {
  await sendMessage(`🤖 REVOLUT X TRADING AGENT

🎯 OPERAR:
/btc 
/eth 
/sol 
/venice 
/xrp

⏰ Cron automático:
/cron — ver estado y opciones
/cron_on — activar
/cron_off — desactivar
/cron_5m -> cada 5 min
/cron_15m -> cada 15 min
/cron_1h -> cada hora
/cron_4h -> cada 4 horas

⚙️ CONFIG:
/status /configuration /help`);
}

async function handleHelp() {
  await sendMessage(`❓ COMANDOS DISPONIBLES

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
/help — este menú`);
}

async function handleStatus() {
  const dry = process.env.DRY_RUN === 'true' ? '🔒 DRY-RUN' : '🔴 REAL MONEY';
  const cronSt = getCronStatus();
  let parseCron = CronParse(cronSt.schedule);

  await sendMessage(`📊 ESTADO ACTUAL

🎯 Pares: >${process.env.TRADING_PAIRS}>
💰 Max trade: >${(parseFloat(process.env.MAX_TRADE_SIZE || 0.1) * 100).toFixed(0)}%>
💵 Min orden: >$${process.env.MIN_ORDER}>
🧠 Modelo: >${process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5'}>

⏰ Cron: ${cronSt.enabled ? '✅ ACTIVO' : '⏸ INACTIVO'}
📅 Schedule: >${parseCron}>

${dry}`);
}

// ── /cron command ─────────────────────────────────────────────────
async function handleCron(args) {
  // /cron on
  if (args === 'on') {
    if (startCron(cronSchedule)) {
      await sendMessage(`✅ Cron activado\nSchedule: >${cronSchedule}>`);
    } else {
      await sendMessage(`❌ Schedule inválido: >${cronSchedule}>`);
    }
    return;
  }

  // /cron off
  if (args === 'off') {
    stopCron();
    await sendMessage('⏹ Cron desactivado. Las operaciones manuales siguen disponibles.');
    return;
  }

  // /cron <expr>  — set new schedule and start
  if (args && args.trim()) {
    const expr = args.trim();
    if (!cron.validate(expr)) {
      await sendMessage(`❌ Expresión cron inválida: >${expr}>

Ejemplos válidos:
>*/5 * * * *  → cada 5 min
>*/15 * * * * → cada 15 min
>0 * * * *    → cada hora
>0 */4 * * *  → cada 4 horas`);
      return;
    }
    if (startCron(expr)) {
      let parseCron = CronParse(expr);
      await sendMessage(`✅ Cron actualizado y activado\n Ciclo: ${parseCron}`);
    }
    return;
  }

  // /cron — show status + inline keyboard
  const st = getCronStatus();
  

  const keyboard = {
    inline_keyboard: [
      // Row 1: Enable / Disable
      [
        { text: st.enabled ? '⏸ Desactivar' : '▶️ Activar', callback_data: st.enabled ? 'cron_off' : 'cron_on' },
        { text: '🔄 Ejecutar ahora', callback_data: 'cron_now' },
      ],
      // Row 2: Presets
      ...chunk(CRON_PRESETS.map(p => ({
        text: p.label,
        callback_data: `cron_set_${p.expr}`,
      })), 3),
    ],
  };

  await sendMessage(
    `⏰ GESTIÓN DE CRON\n\n` +
    `Estado: ${st.enabled ? '✅ ACTIVO' : '⏸ INACTIVO'}\n` +
    `Schedule: ${st.schedule}\n\n` +
    `Selecciona una opción o envía:\n/cron */15 * * * *`,
    keyboard
  );
}

// ── Coin command ──────────────────────────────────────────────────
async function handleCoinCommand(symbol) {
  const coin = COINS.find(c => c.symbol === symbol);
  if (!coin) { await sendMessage('❌ Moneda no encontrada. Usa /help'); return; }

  await sendMessage(`⏳ Analizando ${coin.emoji} ${symbol}...\n\nFetching datos → indicadores → Claude AI → ejecución`);

  const originalPairs = process.env.TRADING_PAIRS;
  process.env.TRADING_PAIRS = `${symbol}/USD`;

  try {
    await runAgentCycle('telegram');
    // executor.js already sends the formatted result via notify()
  } catch (err) {
    logger.error(`Coin command failed for ${symbol}:`, err.message);
    await sendMessage(`❌ Error procesando ${coin.emoji} ${symbol}\n\n>${err.message}>\n\nIntenta de nuevo: /${symbol.toLowerCase()}`);
  } finally {
    process.env.TRADING_PAIRS = originalPairs;
  }
}

// ── /configuration ────────────────────────────────────────────────
async function handleConfiguration() {
  const envVars = readEnvFile();
  let text = '⚙️ CONFIGURACIÓN EDITABLE\n\n';

  EDITABLE_CONFIG.forEach((key, i) => {
    const value = envVars[key] || process.env[key] || '(no configurado)';
    const display = key.includes('KEY') || key.includes('TOKEN')
      ? value.substring(0, 10) + '...'
      : value;
    text += `${i + 1}. ${key}: ${display}\n`;
  });

  text += `\n📝 Responde con el NÚMERO y luego el nuevo valor.\nEjemplo: 4 → claude-haiku-4-5`;

  configState.isConfiguring = true;
  configState.selectedKey   = null;
  await sendMessage(text);
}

async function handleConfigInput(text) {
  if (!configState.isConfiguring) return;

  if (!configState.selectedKey) {
    const idx = parseInt(text.trim()) - 1;
    if (isNaN(idx) || idx < 0 || idx >= EDITABLE_CONFIG.length) {
      await sendMessage(`❌ Número inválido (1-${EDITABLE_CONFIG.length})`);
      return;
    }
    configState.selectedKey = EDITABLE_CONFIG[idx];
    await sendMessage(`✏️ ${configState.selectedKey}\n\nEscribe el nuevo valor:`);
    return;
  }

  const key   = configState.selectedKey;
  const value = text.trim();
  const ok    = updateEnvFile(key, value);

  // If cron-related, apply immediately
  if (key === 'CRON_SCHEDULE') cronSchedule = value;
  if (key === 'CRON_ENABLED') {
    value === 'true' ? startCron(cronSchedule) : stopCron();
  }

  await sendMessage(ok
    ? `✅ ${key} actualizado.\n\n/configuration para más cambios`
    : `❌ Error guardando ${key}`
  );

  configState.isConfiguring = false;
  configState.selectedKey   = null;
}

// ─────────────────────────────────────────────────────────────────
//  Callback query handler
// ─────────────────────────────────────────────────────────────────

async function handleCallback(callbackQueryId, data, messageId) {
  await answerCallback(callbackQueryId);

  if (data === 'cron_on') {
    const ok = startCron(cronSchedule);
    await editMessage(messageId,
      ok
        ? `✅ Cron activado\nSchedule: ${cronSchedule}`
        : `❌ Error activando cron. Schedule actual: ${cronSchedule}`
    );
    return;
  }

  if (data === 'cron_off') {
    stopCron();
    await editMessage(messageId, '⏹ Cron desactivado.');
    return;
  }

  if (data === 'cron_now') {
    await editMessage(messageId, '⏳ Ejecutando ciclo ahora...');
    try {
      await runAgentCycle('manual');
      await editMessage(messageId, '✅ Ciclo completado. Revisa el reporte arriba ↑');
    } catch (err) {
      await editMessage(messageId, `❌ Error: ${err.message}`);
    }
    return;
  }

  if (data.startsWith('cron_set_')) {
    const expr = data.replace('cron_set_', '');
    const ok   = startCron(expr);
    await editMessage(messageId,
      ok
        ? `✅ Cron actualizado\nSchedule: ${expr}\nEstado: ACTIVO`
        : `❌ Error con schedule: ${expr}`
    );
    return;
  }
}

// ─────────────────────────────────────────────────────────────────
//  Long polling loop
// ─────────────────────────────────────────────────────────────────

async function getUpdates() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/getUpdates?offset=${updateOffset}&timeout=25`,
      method:   'GET',
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body).result || []); }
        catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

async function processUpdates() {
  if (isPolling) return;  // Skip if already polling
  isPolling = true;
  
  try {
    const updates = await getUpdates();

    for (const update of updates) {
      updateOffset = update.update_id + 1;

      try {
        // ── Text messages ───────────────────────────────────────────
        if (update.message?.text) {
          const full = update.message.text.trim();
          const [cmd, ...argParts] = full.split(' ');
          const args = argParts.join(' ');
          const command = cmd.toLowerCase();

          if (configState.isConfiguring && !command.startsWith('/')) {
            await handleConfigInput(full);
            continue;
          }

          switch (command) {
            case '/start':         await handleStart();            break;
            case '/help':          await handleHelp();             break;
            case '/status':        await handleStatus();           break;
            case '/trigger':       await handleHelp();             break;
            case '/configuration': await handleConfiguration();    break;
            case '/cron':          await handleCron(args);         break;
            case '/cron_on':       await handleCron('on');         break;
            case '/cron_off':      await handleCron('off');        break;
            case '/cron_5m':        await handleCron('*/5 * * * *'); break;
            case '/cron_15m':       await handleCron('*/15 * * * *');break;
            case '/cron_1h':        await handleCron('0 * * * *');   break;
            case '/cron_4h':        await handleCron('0 */4 * * *'); break;
            case '/btc':           await handleCoinCommand('BTC'); break;
            case '/eth':           await handleCoinCommand('ETH'); break;
            case '/sol':           await handleCoinCommand('SOL'); break;
            case '/venice':        await handleCoinCommand('VENICE'); break;
            case '/xrp':           await handleCoinCommand('XRP'); break;
            default:
              await sendMessage('❓ Comando no reconocido. Usa /help');
          }
        }

        // ── Callbacks ────────────────────────────────────────────────
        if (update.callback_query) {
          const { id, data, message } = update.callback_query;
          await handleCallback(id, data, message?.message_id);
        }

      } catch (err) {
        if (!err.message?.includes('409')) {
          logger.error('Error processing update:', err.message);
        }
      }
    }
  } catch (err) {
    logger.error('Error in processUpdates:', err.message);
  } finally {
    isPolling = false;
  }
}

// ─────────────────────────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────────────────────────

export async function startTelegramBot() {
  if (!BOT_TOKEN || !CHAT_ID) {
    logger.warn('⚠️ Telegram not configured (missing BOT_TOKEN or CHAT_ID)');
    return;
  }

  logger.info('🤖 Starting Telegram bot...');

  // Auto-start cron if enabled in env
  if (cronEnabled && cron.validate(cronSchedule)) {
    startCron(cronSchedule);
    logger.info(`⏰ Auto-started cron: ${cronSchedule}`);
  }

  await sendMessage(
    `✅ Trading Bot Online\n\n` +
    `Cron: ${cronEnabled ? `✅ ${cronSchedule}` : '⏸ desactivado'}\n` +
    `DRY_RUN: ${process.env.DRY_RUN === 'true' ? '🔒 sí' : '🔴 no'}\n\n` +    
    `/start para ver comandos`
  ).catch(() => {});

  // Sequential long polling (waits for each cycle to complete before starting next)
  const startPolling = async () => {
    while (true) {
      await processUpdates();
      // Small delay to prevent tight loop and rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  };

  startPolling().catch(err => logger.error('Polling loop error:', err));
}

export { startCron, stopCron, getCronStatus };
export default startTelegramBot;

// ─────────────────────────────────────────────────────────────────
//  Utility
// ─────────────────────────────────────────────────────────────────
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}