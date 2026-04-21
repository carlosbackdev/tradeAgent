
import 'dotenv/config';
const files = [
  '../src/utils/logger.js',
  '../src/config/config.js',
  '../src/utils/mongodb.js',
  '../src/revolut/client.js',
  '../src/agent/executor.js',
  '../src/telegram/telegram-handlers.js',
  '../src/telegram/commands.js',
  '../src/users/user-registry.js',
  '../src/users/user-config.js',
  '../src/users/onboarding-wizard.js',
  '../src/users/user-session.js',
  '../src/multi-user-bot.js'
];

async function check() {
  for (const f of files) {
    console.log(`Checking ${f}...`);
    try {
      await import(f);
      console.log(`✅ ${f} is OK`);
    } catch (err) {
      console.error(`❌ ${f} FAILED:`);
      console.error(err);
      process.exit(1);
    }
  }
}

check();
