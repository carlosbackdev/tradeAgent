/**
 * src/index.js
 * Entry point for Multi-User Trading Agent.
 * Runs one master bot that spawns user-specific sessions and cycles.
 */

import 'dotenv/config';
import { logger } from './utils/logger.js';
import { startMultiUserBot } from './multi-user-bot.js';

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  🤖 Revolut X Trading Agent — Multi-User Mode');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Node.js:  ${process.version}`);
  console.log(`  Admin ID: ${process.env.ADMIN_TELEGRAM_ID || '(no configurado)'}`);
  console.log('═══════════════════════════════════════════════════\n');

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN es requerido para iniciar el bot');
    process.exit(1);
  }

  try {
    await startMultiUserBot();
    
    console.log('\n✅ Multi-user bot en marcha.');
    console.log('   Comandos de admin: /invite, /users, /revoke, /admin_status\n');
  } catch (err) {
    logger.error('🔥 Failed to start multi-user bot:', err.message);
    process.exit(1);
  }

  // Graceful shutdown
  process.on('SIGINT', () => { logger.info('👋 Shutting down...'); process.exit(0); });
  process.on('SIGTERM', () => { logger.info('👋 Terminating...'); process.exit(0); });
  process.on('uncaughtException', err => { logger.error('🔥 Uncaught:', err.message); process.exit(1); });
  process.on('unhandledRejection', err => { logger.error('🔥 Unhandled:', `${err}`); process.exit(1); });
}

main().catch(err => {
  console.error('🔥 Fatal error during startup:', err);
  process.exit(1);
});
