/**
 * src/index.js
 * Entry point.
 *
 * Cron is now managed by telegram-bot.js (startCron/stopCron).
 * index.js just starts the bot and handles --trigger for manual use.
 */

import 'dotenv/config';
import readline from 'readline';
import { runAgentCycle } from './agent/executor.js';
import { notify }        from './telegram/handles.js';
import { validateConfig } from './utils/config.js';
import { logger }        from './utils/logger.js';
import { startTelegramBot } from './telegram-bot.js';

async function main() {
  try {
    validateConfig();
  } catch (err) {
    console.error('❌ Configuration Error:', err.message);
    process.exit(1);
  }

  const isManualTrigger = process.argv.includes('--trigger');
  const isDryRun        = process.env.DRY_RUN === 'true';

  console.log('═══════════════════════════════════════════════');
  console.log('  🤖 Revolut X Trading Agent');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Pairs:    ${process.env.TRADING_PAIRS}`);
  console.log(`  Cron:     managed via Telegram /cron`);
  console.log(`  Dry run:  ${isDryRun}`);
  console.log(`  Node.js:  ${process.version}`);
  console.log('═══════════════════════════════════════════════\n');

  // ── Manual trigger (CLI) ──────────────────────────────────────
  if (isManualTrigger) {
    try {
      const coin = await selectCoin();
      logger.info(`🎯 Manual trigger: ${coin}/USD`);

      await runAgentCycle('manual', `${coin}-USD`);

      logger.info('✅ Manual cycle completed');
      process.exit(0);
    } catch (err) {
      logger.error('❌ Manual trigger failed:', err.message);
      await notify(`🚨 Manual trigger failed: ${err.message}`).catch(() => {});
      process.exit(1);
    }
  }

  // ── Daemon mode ───────────────────────────────────────────────
  // Cron is started inside startTelegramBot if CRON_ENABLED=true
  await startTelegramBot();

  console.log('✅ Bot running. Use /cron in Telegram to manage scheduling.\n');
  console.log('   /cron on       — activate with current schedule');
  console.log('   /cron off      — deactivate');
  console.log('   /cron */15 * * * *  — set new schedule\n');

  process.on('SIGINT',  () => { console.log('\n👋 Shutting down...'); process.exit(0); });
  process.on('SIGTERM', () => { console.log('\n👋 Terminating...');   process.exit(0); });

  process.on('uncaughtException',    err => { logger.error('🔥 Uncaught:', err.message); process.exit(1); });
  process.on('unhandledRejection',   err => { logger.error('🔥 Unhandled:', `${err}`);   process.exit(1); });
}

main().catch(err => { console.error('🔥 Fatal:', err); process.exit(1); });

// ─────────────────────────────────────────────────────────────────
function selectCoin() {
  return new Promise(resolve => {
    const coins = [
      { symbol: 'BTC', name: 'Bitcoin',      emoji: '₿'  },
      { symbol: 'ETH', name: 'Ethereum',     emoji: '◇'  },
      { symbol: 'SOL', name: 'Solana',       emoji: '◎'  },
      { symbol: 'VENICE', name: 'Venice Token', emoji: '🦋' },
      { symbol: 'XRP', name: 'Ripple',       emoji: '✕'  },
    ];

    console.log('\n╔══════════════════════════════════╗');
    console.log('║   SELECT CRYPTOCURRENCY           ║');
    console.log('╚══════════════════════════════════╝\n');
    coins.forEach((c, i) => console.log(`  ${i + 1}. ${c.emoji}  ${c.symbol.padEnd(8)} ${c.name}`));
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Enter number (1-5): ', answer => {
      rl.close();
      const idx = parseInt(answer) - 1;
      const selected = coins[idx] || coins[0];
      console.log(`\n✅ Selected: ${selected.emoji} ${selected.symbol}\n`);
      resolve(selected.symbol);
    });
  });
}