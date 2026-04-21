/**
 * src/index.js
 * Entry point. Supports two modes:
 *
 *  MULTI_USER_MODE=true  → Multi-user bot (admin invites users, each configures their own keys)
 *  MULTI_USER_MODE=false → Single-user bot (original behavior, env vars = config)
 */

import 'dotenv/config';
import readline from 'readline';
import { runAgentCycle } from './agent/executor.js';
import { notify } from './telegram/handles.js';
import { config, validateConfig } from './config/config.js';
import { logger } from './utils/logger.js';

const MULTI_USER = process.env.MULTI_USER_MODE === 'true';

async function main() {
  const isManualTrigger = process.argv.includes('--trigger');
  const isDryRun = config.debug.dryRun;

  console.log('═══════════════════════════════════════════════════');
  console.log('  🤖 Revolut X Trading Agent');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Modo:     ${MULTI_USER ? '👥 Multi-usuario' : '👤 Single-usuario'}`);
  console.log(`  Node.js:  ${process.version}`);

  // ── Multi-user mode ─────────────────────────────────────────────
  if (MULTI_USER) {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.error('❌ TELEGRAM_BOT_TOKEN es requerido en modo multi-usuario');
      process.exit(1);
    }
    if (!process.env.ADMIN_TELEGRAM_ID) {
      console.warn('⚠️  ADMIN_TELEGRAM_ID no configurado — comandos de admin desactivados');
    }

    console.log(`  Admin ID: ${process.env.ADMIN_TELEGRAM_ID || '(no configurado)'}`);
    console.log('═══════════════════════════════════════════════════\n');

    const { startMultiUserBot } = await import('./multi-user-bot.js');
    await startMultiUserBot();

    console.log('\n✅ Multi-user bot en marcha.');
    console.log('   Comandos de admin desde Telegram:');
    console.log('   /invite @usuario   — Invitar un nuevo usuario');
    console.log('   /users             — Ver todos los usuarios');
    console.log('   /revoke @usuario   — Suspender acceso');
    console.log('   /admin_status      — Estado del bot\n');
  }

  // ── Single-user mode (original behavior) ───────────────────────
  else {
    try {
      validateConfig();
    } catch (err) {
      console.error('❌ Configuration Error:', err.message);
      process.exit(1);
    }

    console.log(`  Pairs:    ${config.trading.pairs.join(',')}`);
    console.log(`  Dry run:  ${isDryRun}`);
    console.log('═══════════════════════════════════════════════════\n');

    if (isManualTrigger) {
      try {
        const coin = await selectCoin();
        logger.info(`🎯 Manual trigger: ${coin}`);
        await runAgentCycle('manual', coin);
        logger.info('✅ Manual cycle completed');
        process.exit(0);
      } catch (err) {
        logger.error('❌ Manual trigger failed:', err.message);
        await notify(`🚨 Manual trigger failed: ${err.message}`).catch(() => {});
        process.exit(1);
      }
    }

    const { startTelegramBot } = await import('./telegram-bot.js');
    await startTelegramBot();
    console.log('✅ Single-user bot running.\n');
  }

  process.on('SIGINT', () => { console.log('\n👋 Shutting down...'); process.exit(0); });
  process.on('SIGTERM', () => { console.log('\n👋 Terminating...'); process.exit(0); });
  process.on('uncaughtException', err => { logger.error('🔥 Uncaught:', err.message); process.exit(1); });
  process.on('unhandledRejection', err => { logger.error('🔥 Unhandled:', `${err}`); process.exit(1); });
}

main().catch(err => { console.error('🔥 Fatal:', err); process.exit(1); });

function selectCoin() {
  return new Promise(resolve => {
    const coins = [
      { symbol: 'BTC-USD', emoji: '₿' },
      { symbol: 'ETH-USD', emoji: '◇' },
      { symbol: 'SOL-USD', emoji: '◎' },
      { symbol: 'VVV-USD', emoji: '🦋' },
      { symbol: 'XRP-USD', emoji: '✕' },
    ];
    console.log('\n╔══════════════════════════════════╗');
    console.log('║   SELECCIONA CRIPTOMONEDA         ║');
    console.log('╚══════════════════════════════════╝\n');
    coins.forEach((c, i) => console.log(`  ${i + 1}. ${c.emoji}  ${c.symbol}`));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('\nNúmero (1-5): ', answer => {
      rl.close();
      const idx = parseInt(answer) - 1;
      resolve((coins[idx] || coins[0]).symbol);
    });
  });
}
