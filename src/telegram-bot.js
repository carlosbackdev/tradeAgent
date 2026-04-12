/**
 * src/telegram-bot.js
 * Telegram bot to trigger trades on demand
 * Commands:
 *   /trigger - Show coin menu and run one cycle
 *   /status - Show current config and last trade
 *   /configuration - Edit all configuration variables
 *   /help - Show available commands
 */

import 'dotenv/config';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runAgentCycle } from './agent/executor.js';
import { logger } from './utils/logger.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const UPDATE_OFFSET = {};
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.join(process.cwd(), '.env');

// Estado temporal para configuración
const configState = {};

const COINS = [
  { symbol: 'BTC', name: 'Bitcoin', emoji: '₿' },
  { symbol: 'ETH', name: 'Ethereum', emoji: '◇' },
  { symbol: 'SOL', name: 'Solana', emoji: '◎' },
  { symbol: 'VENICE', name: 'Venice Token', emoji: '🦋' },
  { symbol: 'XRP', name: 'Ripple', emoji: '✕' }
];

// Configuraciones editable
const EDITABLE_CONFIG = [
  'REVOLUT_API_KEY',
  'REVOLUT_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TRADING_PAIRS',
  'MAX_TRADE_SIZE',
  'MIN_ORDER',
  'CRON_ENABLED',
  'CRON_SCHEDULE',
  'DRY_RUN',
  'DEBUG_API'
];

async function sendMessage(text, replyMarkup = null) {
  if (!text || !text.trim()) {
    logger.warn('⚠️ Attempted to send empty message');
    return;
  }

  return new Promise((resolve, reject) => {
    const cleanText = text.trim();
    const payload = { chat_id: CHAT_ID, text: cleanText, parse_mode: 'HTML' };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(body));
        else reject(new Error(`HTTP ${res.statusCode}: ${body}`));
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Leer todas las variables del .env
 */
function readEnvFile() {
  try {
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    const env = {};
    content.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const [key, ...valueParts] = line.split('=');
      if (key) env[key.trim()] = (valueParts.join('=')).trim();
    });
    return env;
  } catch (err) {
    logger.error('Error reading .env:', err.message);
    return {};
  }
}

/**
 * Escribir variable en .env
 */
function updateEnvFile(key, value) {
  try {
    let content = fs.readFileSync(ENV_PATH, 'utf-8');
    const regex = new RegExp(`^${key}=.*$`, 'm');
    
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
    
    fs.writeFileSync(ENV_PATH, content, 'utf-8');
    process.env[key] = value;
    logger.info(`✅ Updated ${key} in .env`);
    return true;
  } catch (err) {
    logger.error(`❌ Error updating .env:`, err.message);
    return false;
  }
}

async function answerCallback(callbackQueryId, text) {
  return new Promise((resolve, reject) => {
    const payload = { callback_query_id: callbackQueryId, text, show_alert: false };
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/answerCallbackQuery`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(body));
        else reject(new Error(`HTTP ${res.statusCode}: ${body}`));
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function editMessage(messageId, text, replyMarkup = null) {
  return new Promise((resolve, reject) => {
    const payload = { chat_id: CHAT_ID, message_id: messageId, text, parse_mode: 'HTML' };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/editMessageText`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(body));
        else reject(new Error(`HTTP ${res.statusCode}: ${body}`));
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function handleStart() {
  const text = `🤖 REVOLUT X TRADING AGENT\n\n✨ ¡Bienvenido!\n\n🎯 COMANDOS RÁPIDOS:\n/btc - Bitcoin\n/eth - Ethereum\n/sol - Solana\n/venice - Venice\n/xrp - Ripple\n\n📊 OTROS:\n/trigger - Menú\n/status - Config\n/configuration - Edit Config\n/help - Ayuda\n\n⚡ EMPEZAR:\n1. Escribe /btc\n2. Agent ejecuta\n3. ¡Listo!\n\n✅ Datos REALES`;
  await sendMessage(text);
}

async function handleConfiguration() {
  const envVars = readEnvFile();
  let configText = '⚙️ CONFIGURACIÓN EDITABLE\n\n';
  
  EDITABLE_CONFIG.forEach((key, idx) => {
    const value = envVars[key] || process.env[key] || '(no configurado)';
    const displayValue = key.includes('KEY') || key.includes('TOKEN') 
      ? value.substring(0, 10) + '...' 
      : value;
    configText += `${idx + 1}. ${key}: ${displayValue}\n`;
  });

  configText += `\n📝 INSTRUCCIONES:
1️⃣  Responde con el NÚMERO de la variable
2️⃣  Escribe el nuevo valor
3️⃣  Se actualizará inmediatamente

Ejemplo: "3" luego "sk-ant-api03-xxx"`;

  configState.isConfigurating = true;
  await sendMessage(configText);
}

async function handleConfigurationInput(userInput) {
  if (!configState.isConfigurating) return;

  const input = userInput.trim();

  // Si ya seleccionó una variable, el siguiente input es el valor
  if (configState.selectedConfig) {
    const key = configState.selectedConfig;
    const value = input;
    
    const success = updateEnvFile(key, value);
    if (success) {
      await sendMessage(`✅ ${key} actualizado correctamente.\n\nNuevo valor: ${value}\n\n👉 /configuration para cambiar otro\n👉 /help para ver otros comandos`);
    } else {
      await sendMessage(`❌ Error al guardar ${key}. Intenta de nuevo.`);
    }
    
    configState.isConfigurating = false;
    configState.selectedConfig = null;
    return;
  }

  // Si no ha seleccionado variable, esperamos un número
  const idx = parseInt(input) - 1;
  if (isNaN(idx) || idx < 0 || idx >= EDITABLE_CONFIG.length) {
    await sendMessage('❌ Número inválido. Por favor responde con un número del 1 al 13.');
    return;
  }

  configState.selectedConfig = EDITABLE_CONFIG[idx];
  await sendMessage(`✏️ Variable seleccionada: ${configState.selectedConfig}\n\n📝 Escribe el nuevo valor:`);
}

async function handleTrigger(messageId) {
  const text = `💰 SELECCIONA UNA CRIPTOMONEDA\n\n/btc - Bitcoin\n/eth - Ethereum\n/sol - Solana\n/venice - Venice Token\n/xrp - Ripple\n\nEscribe un comando para empezar`;
  await sendMessage(text);
}

async function handleCoinSelect(callbackQueryId, messageId, coinIndex) {
  const coin = COINS[coinIndex];
  if (!coin) return;

  await answerCallback(callbackQueryId, `✅ ${coin.emoji} ${coin.symbol} seleccionado. Procesando...`);

  const originalPairs = process.env.TRADING_PAIRS;
  process.env.TRADING_PAIRS = `${coin.symbol}/USD`;

  try {
    await editMessage(messageId, `
⏳ PROCESANDO ${coin.emoji} ${coin.symbol}

Paso 1/4: 📊 Fetching datos de CoinGecko...
Paso 2/4: ⏳ Analizando indicadores...
Paso 3/4: ⏳ Consultando Claude AI...
Paso 4/4: ⏳ Ejecutando decisión...

Por favor espera...
    `);

    await runAgentCycle('telegram');

    await editMessage(messageId, `
✅ CICLO COMPLETADO - ${coin.emoji} ${coin.symbol}

El análisis ha terminado correctamente.
Verifica el portal de Revolut X para ver el resultado de la orden.

Próximos pasos:
• /trigger para otra moneda
• /status para ver configuración
• /help para más opciones
    `);
    logger.info(`✅ Telegram trigger completed for ${coin.symbol}`);
  } catch (err) {
    logger.error(`❌ Telegram trigger failed for ${coin.symbol}`, err.message);
    await editMessage(messageId, `
❌ ERROR AL PROCESAR ${coin.emoji} ${coin.symbol}

Motivo:
${err.message}

Intenta de nuevo con /trigger
    `);
  }

  process.env.TRADING_PAIRS = originalPairs;
}

async function handleCoinCommand(messageId, symbol, coinIndex) {
  const coin = COINS[coinIndex];
  if (!coin) {
    await sendMessage('❌ Coin not found. Try /help');
    return;
  }

  const originalPairs = process.env.TRADING_PAIRS;
  process.env.TRADING_PAIRS = `${symbol}/USD`;

  try {
    await sendMessage(`⏳ Analyzing ${coin.emoji} ${symbol}...\n\n📊 Fetching CoinGecko data\n⏳ Computing indicators\n⏳ Consulting Claude AI\n⏳ Executing decision`);

    // runAgentCycle() will send formatted message via notify()
    await runAgentCycle('telegram');

    // No additional message here - executor.js already sent formatted result via notify()
    logger.info(`✅ Telegram command completed for ${symbol}`);
  } catch (err) {
    logger.error(`❌ Telegram command failed for ${symbol}`, err.message);
    await sendMessage(`❌ Error processing ${coin.emoji} ${symbol}\n\n🔴 ${err.message}\n\nTry again: /${symbol.toLowerCase()}`);
  }

  process.env.TRADING_PAIRS = originalPairs;
}

async function handleStatus() {
  const dryRun = process.env.DRY_RUN === 'true' ? '🔒 DRY-RUN' : '🔴 REAL';
  const text = `📊 ESTADO ACTUAL\n\n🎯 Pares: ${process.env.TRADING_PAIRS}\n💰 Max: ${(parseFloat(process.env.MAX_TRADE_SIZE) * 100).toFixed(1)}%\n💵 Min: $${process.env.MIN_ORDER}\n⏰ Cron: ${process.env.CRON_SCHEDULE}\n\n✅ CoinGecko: REAL\n✅ Claude AI: ACTIVO\n${dryRun}`;
  await sendMessage(text);
}

async function handleHelp() {
  const text = `❓ AYUDA - COMANDOS\n\n🎯 OPERAR:\n/btc - Bitcoin\n/eth - Ethereum\n/sol - Solana\n/venice - Venice\n/xrp - Ripple\n\n📊 INFO:\n/trigger - Menú\n/status - Config\n/configuration - ⚙️ Edit variables\n/help - Ayuda\n\n⚡ CÓMO:\n1️⃣ Escribe /btc\n2️⃣ Agent analiza\n3️⃣ Ejecuta orden\n\n✅ Datos: REALES\n✅ AI: Claude`;
  await sendMessage(text);
}

async function getUpdates(offset = 0) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`,
      method: 'GET'
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(body).result || []);
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function processUpdates() {
  try {
    const updates = await getUpdates(UPDATE_OFFSET.value || 0);

    if (updates.length === 0) {
      // No updates, wait a bit before retrying
      return;
    }

    for (const update of updates) {
      UPDATE_OFFSET.value = update.update_id + 1;

      // Text messages (commands)
      if (update.message?.text) {
        const text = update.message.text.toLowerCase();
        const messageId = update.message.message_id;

        if (text === '/start') await handleStart();
        else if (text === '/trigger') await handleTrigger();
        else if (text === '/status') await handleStatus();
        else if (text === '/configuration') await handleConfiguration();
        else if (text === '/help') await handleHelp();
        
        // Direct coin commands
        else if (text === '/btc') await handleCoinCommand(messageId, 'BTC', 0);
        else if (text === '/eth') await handleCoinCommand(messageId, 'ETH', 1);
        else if (text === '/sol') await handleCoinCommand(messageId, 'SOL', 2);
        else if (text === '/venice') await handleCoinCommand(messageId, 'VENICE', 3);
        else if (text === '/xrp') await handleCoinCommand(messageId, 'XRP', 4);
        
        // Configuration input handling
        else if (configState.isConfigurating) await handleConfigurationInput(update.message.text);
        
        else await sendMessage('❓ Comando no reconocido. Usa /help para ver comandos disponibles.');
      }

      // Button callbacks
      if (update.callback_query) {
        const { id: callbackId, data, message } = update.callback_query;
        
        if (data.startsWith('trade_')) {
          const coinIndex = parseInt(data.split('_')[1]);
          await handleCoinSelect(callbackId, message.message_id, coinIndex);
        }
      }
    }
  } catch (err) {
    // Silently handle 409 conflicts (normal with long polling)
    if (err.message.includes('409')) {
      return; // Skip logging for 409 errors
    }
    logger.error('Error processing Telegram updates:', err.message);
  }
}

export async function startTelegramBot() {
  if (!BOT_TOKEN || !CHAT_ID) {
    logger.warn('⚠️ Telegram bot not configured. Skipping telegram bot initialization.');
    logger.warn('   Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env to enable.');
    return;
  }

  logger.info('🤖 Starting Telegram bot polling...');
  
  // Send startup message
  await sendMessage('✅ Trading Bot Started\n\nBienvenido. Escribe /start para ver comandos.').catch(() => {});

  // Long polling (3 seconds between polls to avoid 409 conflicts)
  setInterval(processUpdates, 3000);
}

export default startTelegramBot;
