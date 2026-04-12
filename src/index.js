/**
 * src/index.js
 * Entry point. Sets up the cron scheduler and handles manual triggers.
 *
 * Run modes:
 *   node src/index.js              → start cron daemon
 *   node src/index.js --trigger    → choose coin and run one cycle
 */

import 'dotenv/config';
import cron from 'node-cron';
import readline from 'readline';
import { runAgentCycle } from './agent/executor.js';
import { notify } from './notifications/telegram.js';
import { validateConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
import { startTelegramBot } from './telegram-bot.js';

async function main() {
  try {
    // Validate configuration
    validateConfig();
  } catch (err) {
    console.error('❌ Configuration Error:', err.message);
    console.error('\n📋 Make sure .env file exists and is properly configured.');
    console.error('   Run: cp .env.example .env');
    process.exit(1);
  }

  const isManualTrigger = process.argv.includes('--trigger');
  const isCronEnabled = process.env.CRON_ENABLED === 'true';
  const schedule = process.env.CRON_SCHEDULE;
  const isDryRun = process.env.DRY_RUN === 'true';

  console.log('═══════════════════════════════════════════════');
  console.log('  🤖 Revolut X Trading Agent');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Pairs:     ${process.env.TRADING_PAIRS}`);
  console.log(`  Schedule:  ${isCronEnabled ? schedule : 'DISABLED'}`);
  console.log(`  Cron:      ${isCronEnabled ? 'ENABLED' : 'DISABLED'}`);
  console.log(`  Dry run:   ${isDryRun}`);
  console.log(`  Mode:      ${isManualTrigger ? 'single run' : (isCronEnabled ? 'daemon (timed)' : 'daemon (Telegram only)')}`);
  console.log(`  Node.js:   ${process.version}`);
  console.log('═══════════════════════════════════════════════\n');

  // ── Single manual trigger with coin selection ─────────────────
  if (isManualTrigger) {
    try {
      const selectedCoin = await selectCoin();
      logger.info(`🎯 Manual trigger mode with ${selectedCoin}/USD — executing one cycle...`);
      
      // Temporarily override TRADING_PAIRS for this cycle
      const originalPairs = process.env.TRADING_PAIRS;
      process.env.TRADING_PAIRS = `${selectedCoin}/USD`;
      
      await runAgentCycle('manual');
      
      // Restore original pairs
      process.env.TRADING_PAIRS = originalPairs;
      
      logger.info('✅ Manual cycle completed successfully');
      process.exit(0);
    } catch (err) {
      logger.error('❌ Manual trigger failed', err.message);
      await notify(`🚨 Manual trigger failed: ${err.message}`).catch(() => {});
      process.exit(1);
    }
  }

  // ── Daemon mode with cron ─────────────────────────────────────
  if (!isCronEnabled) {
    console.log(`⏰ Cron scheduling: DISABLED (only Telegram /trigger available)\n`);
    
    // Start Telegram bot
    await startTelegramBot();
    
    console.log('✅ Telegram bot started. Waiting for /trigger commands...');
    
    // Just keep the process running for Telegram bot
    process.on('SIGINT', () => {
      console.log('\n👋 Shutting down gracefully...');
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\n👋 Received termination signal...');
      process.exit(0);
    });

    return; // Exit main flow, Telegram bot handles everything
  }

  // ── Cron mode enabled ──────────────────────────────────────────
  console.log(`⏰ Scheduled to run every: ${schedule}\n`);

  // Start Telegram bot
  await startTelegramBot();
  
  console.log('');

  // Validate cron schedule
  if (!cron.validate(schedule)) {
    console.error('❌ Invalid cron schedule:', schedule);
    console.error('   Examples:');
    console.error('     "*/15 * * * *"     → Every 15 minutes');
    console.error('     "0 * * * *"        → Every hour');
    console.error('     "0 9-17 * * 1-5"   → 9am-5pm on weekdays');
    process.exit(1);
  }

  let cycleCount = 0;
  const startupTime = new Date().toISOString();

  cron.schedule(schedule, async () => {
    cycleCount++;
    logger.info(`[Cycle #${cycleCount}] Starting scheduled execution...`);
    
    try {
      await runAgentCycle('cron');
    } catch (err) {
      logger.error(`[Cycle #${cycleCount}] Execution failed`, err.message);
      // Don't exit on error — continue running
    }
  });

  logger.info(`✅ Cron daemon started at ${startupTime}`);
  console.log('✅ Cron daemon started. Press Ctrl+C to stop.\n');

  // Handle shutdown gracefully
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down gracefully...');
    logger.info(`Daemon ran for ${cycleCount} cycles`);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n👋 Received termination signal...');
    logger.info(`Daemon ran for ${cycleCount} cycles`);
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    logger.error('🔥 Uncaught Exception', err.message);
    console.error(err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('🔥 Unhandled Rejection', `${reason}`);
    process.exit(1);
  });
}

main().catch(err => {
  console.error('🔥 Fatal error:', err);
  process.exit(1);
});

/**
 * Interactive coin selector for manual trigger
 */
function selectCoin() {
  return new Promise((resolve) => {
    const coins = [
      { symbol: 'BTC', name: 'Bitcoin', emoji: '₿' },
      { symbol: 'ETH', name: 'Ethereum', emoji: '◇' },
      { symbol: 'SOL', name: 'Solana', emoji: '◎' },
      { symbol: 'VENICE', name: 'Venice Token', emoji: '🦋' },
      { symbol: 'XRP', name: 'Ripple', emoji: '✕' }
    ];

    console.log('\n╔════════════════════════════════════════════╗');
    console.log('║     SELECT CRYPTOCURRENCY TO TRADE         ║');
    console.log('╚════════════════════════════════════════════╝\n');

    coins.forEach((coin, i) => {
      console.log(`  ${i + 1}. ${coin.emoji}  ${coin.symbol.padEnd(8)} - ${coin.name}`);
    });

    console.log('\n');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('🔹 Enter number (1-5): ', (answer) => {
      rl.close();
      const index = parseInt(answer) - 1;
      
      if (index >= 0 && index < coins.length) {
        const selected = coins[index];
        console.log(`\n✅ Selected: ${selected.emoji}  ${selected.symbol} (${selected.name})\n`);
        resolve(selected.symbol);
      } else {
        console.log('\n❌ Invalid selection. Defaulting to BTC\n');
        resolve('BTC');
      }
    });
  });
}
