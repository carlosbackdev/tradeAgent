#!/bin/bash

# Quick Reference Commands for Revolut X Trading Agent

# ═══════════════════════════════════════════════════════════

# INITIAL SETUP

# ═══════════════════════════════════════════════════════════

# 1. Install dependencies (run this first)

npm install

# 2. Generate cryptographic keys

npm run gen-keys

# 3. Create and configure environment file

cp .env.example .env

# Then edit .env with your API keys

# ═══════════════════════════════════════════════════════════

# VERIFICATION & TESTING

# ═══════════════════════════════════════════════════════════

# Verify everything is set up correctly

npm run verify

# Test with dry-run (no real trades)

npm run test:dry

# Run one cycle manually and exit

npm run trigger

# ═══════════════════════════════════════════════════════════

# RUNNING THE AGENT

# ═══════════════════════════════════════════════════════════

# Start daemon (continuous trading on schedule)

npm start

# Development mode (auto-reload on file changes)

npm run dev

# ═══════════════════════════════════════════════════════════

# DEBUGGING & MONITORING

# ═══════════════════════════════════════════════════════════

# Run with debug logging

LOG_LEVEL=debug npm start

# Run with API request logging

DEBUG_API=true npm run test:dry

# Run with debug + API logging

LOG_LEVEL=debug DEBUG_API=true npm run test:dry

# Verbose output

LOG_LEVEL=debug npm run trigger

# ═══════════════════════════════════════════════════════════

# CONFIGURATION

# ═══════════════════════════════════════════════════════════

# Test with dry-run disabled but still safe

DRY_RUN=true npm run trigger

# Run every 30 minutes instead of 15

CRON*SCHEDULE="*/30 \_ \* \* \*" npm start

# Trade only 2% per trade (conservative)

MAX_TRADE_SIZE=0.02 npm run trigger

# ═══════════════════════════════════════════════════════════

# KEY MANAGEMENT

# ═══════════════════════════════════════════════════════════

# Regenerate keys (use if compromised)

npm run gen-keys

# View your public key (to upload to Revolut X)

cat keys/public.pem

# Check if keys exist

ls -la keys/

# ═══════════════════════════════════════════════════════════

# ENVIRONMENT FILE MANAGEMENT

# ═══════════════════════════════════════════════════════════

# View your current configuration (careful with secrets!)

cat .env

# Check for missing variables

grep "^[A-Z]" .env | wc -l

# ═══════════════════════════════════════════════════════════

# MONITORING & LOGS

# ═══════════════════════════════════════════════════════════

# Save logs to a file

npm start > trading.log 2>&1 &

# View logs in real-time (if running in background)

tail -f trading.log

# View last 50 lines of logs

tail -n 50 trading.log

# Count number of executed trades in logs

grep "✅.\*Order executed" trading.log | wc -l

# ═══════════════════════════════════════════════════════════

# MAINTENANCE

# ═══════════════════════════════════════════════════════════

# Update all dependencies

npm update

# Check for outdated packages

npm outdated

# Check for security vulnerabilities

npm audit

# Fix security issues automatically

npm audit fix

# Clean up old dependencies

rm -rf node_modules package-lock.json
npm install

# ═══════════════════════════════════════════════════════════

# TROUBLESHOOTING

# ═══════════════════════════════════════════════════════════

# Check Node.js version (need ≥20)

node --version

# Check npm version

npm --version

# Verify setup completely

npm run verify

# Test API connection

NODE_OPTIONS=--loader=dotenv/config node -e "import('./src/revolut/client.js').then(m => new m.RevolutClient()).then(() => console.log('✅ API Connection OK')).catch(e => console.error('❌', e.message))"

# Test Claude connection

NODE_OPTIONS=--loader=dotenv/config node -e "import('./src/agent/analyzer.js').then(() => console.log('✅ Claude Connection OK')).catch(e => console.error('❌', e.message))"

# ═══════════════════════════════════════════════════════════

# STOP & RESTART

# ═══════════════════════════════════════════════════════════

# Stop the agent (if running in foreground)

Ctrl+C

# Find and kill the process (if running in background)

# On Linux/Mac:

pkill -f "node src/index.js"

# On Windows PowerShell:

Get-Process node | Where-Object {$\_.CommandLine -like "_src/index.js_"} | Stop-Process

# ═══════════════════════════════════════════════════════════

# USEFUL NPM SCRIPTS SUMMARY

# ═══════════════════════════════════════════════════════════

# npm start → Run daemon (continuous)

# npm run dev → Development (auto-reload)

# npm run trigger → One cycle and exit

# npm run test:dry → Test without real trades

# npm run gen-keys → Generate Ed25519 keys

# npm run verify → Verify configuration

# ═══════════════════════════════════════════════════════════

# ENVIRONMENT VARIABLES QUICK REFERENCE

# ═══════════════════════════════════════════════════════════

# Required:

# REVOLUT_API_KEY 64-char API key from Revolut X

# REVOLUT_PRIVATE_KEY_PATH Path to private key (./keys/private.pem)

# REVOLUT_BASE_URL API endpoint

# ANTHROPIC_API_KEY Claude API key

# TELEGRAM_BOT_TOKEN Bot token from @BotFather

# TELEGRAM_CHAT_ID Your Telegram user ID

# TRADING_PAIRS Pairs to trade (BTC/USD,ETH/USD)

# CRON*SCHEDULE Cron expression (*/15 \_ \* \* \*)

# Optional:

# DRY_RUN=true Don't place real trades

# LOG_LEVEL=debug Verbose logging

# DEBUG_API=true Log API requests

# ═══════════════════════════════════════════════════════════

# COMMON WORKFLOWS

# ═══════════════════════════════════════════════════════════

# 1. First time setup

npm install
npm run gen-keys
cp .env.example .env

# Edit .env with your keys

npm run verify
npm run test:dry

# 2. Daily check before running

npm run verify
npm run test:dry

# 3. Start trading (safe)

npm start

# 4. Emergency stop

Ctrl+C

# 5. Update all packages

npm update
npm audit fix
npm start

# 6. Full diagnostic

npm run verify
LOG_LEVEL=debug npm run test:dry

# ═══════════════════════════════════════════════════════════

# DOCUMENTATION FILES

# ═══════════════════════════════════════════════════════════

# Main documentation:

# README.md - Project overview and usage

# README_SETUP.md - Step-by-step setup guide

# IMPROVEMENTS.md - Future enhancement ideas

# CHANGELOG.md - Version history

# QUICKSTART.txt - Quick reference (this is in that spirit)

# Read them:

cat README.md # Overview
cat README_SETUP.md # Setup instructions
cat IMPROVEMENTS.md # Ideas for the future
cat CHANGELOG.md # What's new

# ═══════════════════════════════════════════════════════════

# ADVANCED USAGE

# ═══════════════════════════════════════════════════════════

# Run with custom trading pairs

TRADING_PAIRS="BTC/USD,ETH/USD,SOL/USD" npm run trigger

# Run more aggressively (every 5 minutes)

CRON*SCHEDULE="*/5 \_ \* \* \*" npm start

# Run only during specific hours (9am-5pm)

CRON_SCHEDULE="0 9-17 \* \* 1-5" npm start

# Deploy max 20% per trade

MAX_TRADE_SIZE=0.20 npm run trigger

# Set minimum order to $100

MIN_ORDER=100 npm run trigger

# ═══════════════════════════════════════════════════════════

# SAFETY CHECKLIST (RUN BEFORE GOING LIVE)

# ═══════════════════════════════════════════════════════════

[ ] npm run verify # Everything set up?
[ ] npm run test:dry # Does dry run work?
[ ] Telegram notifications working?
[ ] .env file is secure (not in git)?
[ ] keys/private.pem is secure (not in git)?
[ ] Position sizes are conservative?
[ ] Monitored for 24 hours?
[ ] Can manually stop the agent?
[ ] Have stop-loss strategy?

# ═══════════════════════════════════════════════════════════

# EMERGENCY COMMANDS

# ═══════════════════════════════════════════════════════════

# Stop all trading immediately

pkill -f "node src/index.js"

# Reset to default configuration

rm .env
cp .env.example .env

# Re-edit with your keys

# Regenerate keys (if compromised)

npm run gen-keys

# Update public key in Revolut X

# Check if any processes are running

ps aux | grep "node"

# ═══════════════════════════════════════════════════════════

# For more help, see: README_SETUP.md

# Happy trading! 🚀
