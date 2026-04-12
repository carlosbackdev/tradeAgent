#!/usr/bin/env node
/**
 * scripts/verify-setup.js
 * Verifies that all dependencies and configuration are correctly set up.
 * Usage: npm run verify
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const checks = [];

function log(symbol, message, detail = '') {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${symbol} ${message}`);
  if (detail) console.log(`         ${detail}`);
}

function checkNodeVersion() {
  const version = process.version.match(/(\d+\.\d+\.\d+)/)[0];
  const major = parseInt(version.split('.')[0]);
  
  if (major >= 20) {
    log('✅', 'Node.js version', `${version} (${major}.x)`);
    checks.push(true);
  } else {
    log('❌', 'Node.js version too old', `${version} (need ≥20.0.0)`);
    checks.push(false);
  }
}

function checkEnvFile() {
  const envPath = path.join(rootDir, '.env');
  
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    log('✅', '.env file exists', `${lines.length} configuration lines`);
    checks.push(true);
  } else {
    log('❌', '.env file not found', 'Run: cp .env.example .env');
    checks.push(false);
  }
}

function checkEnvVariables() {
  const required = [
    'REVOLUT_API_KEY',
    'REVOLUT_PRIVATE_KEY_PATH',
    'REVOLUT_BASE_URL',
    'ANTHROPIC_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'TRADING_PAIRS',
    'CRON_SCHEDULE',
  ];

  const missing = required.filter(v => !process.env[v]);

  if (missing.length === 0) {
    log('✅', 'All required env variables set', `${required.length}/${required.length}`);
    checks.push(true);
  } else {
    log('❌', `Missing ${missing.length} env variables`, missing.join(', '));
    checks.push(false);
  }
}

function checkPrivateKey() {
  const keyPath = path.resolve(process.env.REVOLUT_PRIVATE_KEY_PATH || './keys/private.pem');
  
  if (fs.existsSync(keyPath)) {
    const content = fs.readFileSync(keyPath, 'utf8');
    if (content.includes('PRIVATE KEY')) {
      log('✅', 'Private key exists', `${keyPath}`);
      checks.push(true);
    } else {
      log('❌', 'Private key invalid format', keyPath);
      checks.push(false);
    }
  } else {
    log('❌', 'Private key not found', `Run: npm run gen-keys`);
    checks.push(false);
  }
}

function checkPublicKey() {
  const keyPath = path.resolve('./keys/public.pem');
  
  if (fs.existsSync(keyPath)) {
    const content = fs.readFileSync(keyPath, 'utf8');
    if (content.includes('PUBLIC KEY')) {
      log('✅', 'Public key exists', keyPath);
      checks.push(true);
    } else {
      log('❌', 'Public key invalid format', keyPath);
      checks.push(false);
    }
  } else {
    log('❌', 'Public key not found', `Run: npm run gen-keys`);
    checks.push(false);
  }
}

function checkDependencies() {
  const packageJsonPath = path.join(rootDir, 'package.json');
  const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  
  const required = ['@anthropic-ai/sdk', 'node-cron', 'technicalindicators', 'dotenv'];
  const installed = Object.keys(pkgJson.dependencies);
  
  const missing = required.filter(d => !installed.includes(d));

  if (missing.length === 0) {
    log('✅', 'All dependencies in package.json', required.join(', '));
    checks.push(true);
  } else {
    log('❌', `Missing dependencies: ${missing.join(', ')}`, 'Run: npm install');
    checks.push(false);
  }
}

function checkNodeModules() {
  const nodeModulesPath = path.join(rootDir, 'node_modules');
  
  if (fs.existsSync(nodeModulesPath)) {
    const count = fs.readdirSync(nodeModulesPath).length;
    log('✅', 'node_modules installed', `${count} packages`);
    checks.push(true);
  } else {
    log('❌', 'node_modules not installed', 'Run: npm install');
    checks.push(false);
  }
}

function checkSourceFiles() {
  const required = [
    'src/index.js',
    'src/agent/executor.js',
    'src/agent/analyzer.js',
    'src/agent/indicators.js',
    'src/revolut/client.js',
    'src/revolut/market.js',
    'src/revolut/orders.js',
    'src/notifications/telegram.js',
    'src/utils/formatter.js',
    'src/utils/config.js',
    'src/utils/logger.js',
    'scripts/generate-keys.js',
  ];

  const missing = required.filter(f => !fs.existsSync(path.join(rootDir, f)));

  if (missing.length === 0) {
    log('✅', 'All source files present', `${required.length} files`);
    checks.push(true);
  } else {
    log('❌', `Missing source files: ${missing.join(', ')}`, '');
    checks.push(false);
  }
}

function checkCronSchedule() {
  const schedule = process.env.CRON_SCHEDULE;
  const cronRegex = /^(\*|(\d+)|\d+-\d+|(\d+\/\d+)|\*\/\d+)(\s+(\*|(\d+)|\d+-\d+|(\d+\/\d+)|\*\/\d+)){4}$/;
  
  if (cronRegex.test(schedule)) {
    log('✅', 'Cron schedule valid', schedule);
    checks.push(true);
  } else {
    log('❌', 'Invalid cron schedule', `"${schedule}" (e.g. "*/15 * * * *")`);
    checks.push(false);
  }
}

function printSummary() {
  console.log('\n' + '═'.repeat(50));
  
  const passed = checks.filter(c => c).length;
  const total = checks.length;
  const percentage = Math.round((passed / total) * 100);

  if (passed === total) {
    console.log(`✅ All checks passed! (${passed}/${total})`);
    console.log('\n🚀 You are ready to run: npm start');
  } else {
    console.log(`⚠️  ${total - passed} check(s) failed. (${passed}/${total}, ${percentage}%)`);
    console.log('\n📋 Fix the issues above and run: npm run verify');
  }

  console.log('═'.repeat(50));
  
  process.exit(passed === total ? 0 : 1);
}

// Run all checks
console.log('🔍 Verifying setup...\n');

await Promise.all([
  checkNodeVersion(),
  checkEnvFile(),
  checkDependencies(),
  checkNodeModules(),
  checkSourceFiles(),
].map(p => Promise.resolve(p)));

checkEnvVariables();
checkPrivateKey();
checkPublicKey();
checkCronSchedule();

printSummary();
