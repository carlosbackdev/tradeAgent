# 🚀 Detailed Setup Guide

This guide walks you through setting up the Revolut X Trading Agent step-by-step.

## Prerequisites Check

Before starting, verify you have:

```bash
# Check Node.js version (need ≥20)
node --version
# Expected output: v20.x.x or higher

# Check npm is installed
npm --version
# Expected output: 9.x.x or higher
```

If Node.js is not installed, download it from [nodejs.org](https://nodejs.org/).

## Step-by-Step Setup

### 1. Clone Repository & Install Dependencies

```bash
# Clone the repo (or download as ZIP)
git clone https://github.com/YOUR_USER/revolut-trading-agent
cd revolut-trading-agent

# Install all dependencies
npm install
# Takes ~30-60 seconds
```

**What was installed:**

- `@anthropic-ai/sdk` — Claude AI integration
- `node-cron` — Scheduling
- `technicalindicators` — Technical analysis
- `dotenv` — Environment configuration

### 2. Generate Ed25519 Cryptographic Keys

```bash
npm run gen-keys
```

**Output:**

```
✅ Key pair generated:
   Private: /path/to/keys/private.pem  (chmod 600 — DO NOT COMMIT)
   Public:  /path/to/keys/public.pem

📋 Paste the contents of public.pem into Revolut X when creating your API key:
────────────────────────────────────────────────────────
-----BEGIN PUBLIC KEY-----
MFAwEAYHKoZIzj0CAQYFK4EEAAoDQgAE...
-----END PUBLIC KEY-----
```

⚠️ **IMPORTANT:**

- `keys/private.pem` — **NEVER share this file. It's your secret key.**
- `keys/public.pem` — You'll need to upload this to Revolut X
- Both files are already added to `.gitignore` for safety

### 3. Set Up Revolut X API Access

1. Log in to [Revolut X](https://trading.revolut.com)
2. Click your **Profile** (top right)
3. Navigate to **Settings → API Keys**
4. Click **Create API Key**
5. Paste the entire contents of `keys/public.pem` into the text field
6. Click **Create**
7. **Save the 64-character API key** — you'll need it next

Example API key: `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d`

### 4. Set Up Telegram Notifications

#### Create a Telegram Bot

1. Open Telegram and message **@BotFather**
2. Send `/newbot`
3. Follow the prompts:
   - **Name:** e.g., "MyTradeAgent"
   - **Username:** e.g., "my_trade_agent_bot" (must end with `_bot`)
4. @BotFather gives you a **bot token** — save it:
   ```
   Use this token to access the HTTP API:
   123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh
   ```

#### Get Your Chat ID

1. Start a chat with your newly created bot
2. Send it any message (e.g., `/start`)
3. Visit this URL in your browser (replace `BOT_TOKEN`):
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
   ```
4. Look for `"chat":{"id":987654321}` — that's your **chat_id**

### 5. Create & Configure Environment File

```bash
# Copy the example template
cp .env.example .env

# Edit the file with your credentials
# Windows: notepad .env
# macOS/Linux: nano .env
```

**Fill in these required values:**

```bash
# From Revolut X API keys page
REVOLUT_API_KEY=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d
REVOLUT_PRIVATE_KEY_PATH=./keys/private.pem
REVOLUT_BASE_URL=https://trading.revolut.com/api

# From Anthropic Console (anthropic.com)
ANTHROPIC_API_KEY=sk-ant-v0-...your-key...

# From Telegram setup above
TELEGRAM_BOT_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh
TELEGRAM_CHAT_ID=987654321

# Trading configuration
TRADING_PAIRS=BTC/USD,ETH/USD
MAX_TRADE_SIZE=0.10
MIN_ORDER=50
CRON_SCHEDULE=*/15 * * * *

# Optional (for testing)
DRY_RUN=false
LOG_LEVEL=info
```

**Verify your .env file:**

```bash
# On Windows PowerShell
cat .env | Select-String "^[A-Z]"

# On macOS/Linux
grep "^[A-Z]" .env | head -n 10
```

### 6. Test the Setup

```bash
# Test with dry-run mode (no real trades)
npm run test:dry
```

Expected output:

```
═══════════════════════════════════════════════
  🤖 Revolut X Trading Agent
═══════════════════════════════════════════════
  Pairs:     BTC/USD,ETH/USD
  Schedule:  */15 * * * *
  Dry run:   true
  Mode:      single run
═══════════════════════════════════════════════

[2024-04-12T10:30:45.123Z] ℹ️  INFO: 🤖 Agent cycle started (trigger: manual)
[2024-04-12T10:30:46.456Z] ℹ️  INFO: 📊 Fetching data for 2 pair(s): BTC/USD, ETH/USD
...
[DRY RUN] Would place order: {
  symbol: 'BTC/USD',
  side: 'buy',
  ...
}
✅ Manual cycle completed successfully
```

If you see `[DRY RUN]` messages, the agent is working! ✅

### 7. Run the Agent

#### Daemon Mode (Recommended)

```bash
npm start
```

The agent will run continuously on your schedule:

```
⏰ Scheduled to run every: */15 * * * *
✅ Cron daemon started. Press Ctrl+C to stop.

[2024-04-12T10:30:00] 🤖 Agent cycle started (trigger: cron)
[2024-04-12T10:30:02] ✅ Cycle complete: 1 executed, 2 skipped, 0 errors (2.1s)

[2024-04-12T10:45:00] 🤖 Agent cycle started (trigger: cron)
...
```

#### Stop the Agent

Press `Ctrl+C` in the terminal.

## 🔧 Troubleshooting

### "Missing required env vars"

```
❌ Configuration Error: Missing required env vars: REVOLUT_API_KEY
```

**Solution:**

1. Check `.env` file exists: `ls -la .env`
2. Verify all variables are filled in: `cat .env | grep "^[A-Z]"`
3. Restart the agent after editing

### "Private key not found"

```
Private key not found at: ./keys/private.pem
```

**Solution:**

```bash
npm run gen-keys
```

### "Revolut API authentication failed" (401 error)

**Possible causes:**

- Wrong API key (check it matches Revolut X exactly)
- Wrong private key (mismatch between public.pem you uploaded and private.pem you're using)
- Clock skew (server time vs client time too different)

**Solution:**

```bash
# Regenerate keys and update Revolut X API key
rm keys/*.pem
npm run gen-keys

# Upload new keys/public.pem to Revolut X
# Update REVOLUT_API_KEY in .env
```

### "No Telegram notifications received"

**Check:**

1. Bot token is correct (from @BotFather)
2. Chat ID is correct (from getUpdates endpoint)
3. You started a chat with your bot (send any message first)
4. Test notification manually:
   ```bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" \
     -d "chat_id=<CHAT_ID>&text=Test"
   ```

### Agent runs but no trades

**Check:**

1. Is confidence ≥ 55%? (Claude needs to be fairly confident)
2. Is order size ≥ `MIN_ORDER`? (try lowering if testing)
3. Check the logs: are indicators being computed?
4. Run with `LOG_LEVEL=debug` for verbose output:
   ```bash
   LOG_LEVEL=debug npm run test:dry
   ```

### Claude API rate limit

```
Error: Rate limit exceeded...
```

**Solution:**

- Increase `CRON_SCHEDULE` interval (e.g., `*/30 * * * *` instead of `*/15 * * * *`)
- Reduce `TRADING_PAIRS` to fewer coins
- Check your Anthropic API plan limits

## 📊 Monitoring

### View Real-Time Logs

```bash
# Run with verbose debugging
LOG_LEVEL=debug npm start

# Or just warnings and errors
LOG_LEVEL=warn npm start
```

### Check Telegram for Alerts

Each cycle sends a summary:

- ✅ Executed trades (with qty & reasoning)
- ⏭️ Skipped decisions (why they were skipped)
- ❌ Any errors that occurred
- 📊 Performance (elapsed time, cycle count)

### Monitor Trades in Revolut X

1. Log in to [Revolut X](https://trading.revolut.com)
2. Go to **Orders** tab to see active orders
3. Go to **Fills** tab to see completed trades
4. Go to **Portfolio** to see your position

## 🎯 Next Steps

Once the agent is running:

1. **Review trades** — Check Revolut X daily to verify the agent is trading as expected
2. **Adjust settings** — Start conservative, gradually increase position sizes
3. **Monitor performance** — Track profit/loss, win rate, etc.
4. **Tune strategy** — Adjust `MAX_TRADE_SIZE`, `CRON_SCHEDULE`, or `TRADING_PAIRS`

## 📚 Advanced Customization

### Custom Trading Pairs

```bash
# Trade just Bitcoin
TRADING_PAIRS=BTC/USD

# Trade more pairs
TRADING_PAIRS=BTC/USD,ETH/USD,SOL/USD,XRP/USD
```

### Custom Schedule

```bash
# Every 5 minutes (aggressive)
CRON_SCHEDULE="*/5 * * * *"

# Every hour (conservative)
CRON_SCHEDULE="0 * * * *"

# At 9am and 5pm on weekdays only
CRON_SCHEDULE="0 9,17 * * 1-5"

# During market hours (9am-5pm EST converted to UTC)
CRON_SCHEDULE="0 13-21 * * 1-5"
```

### Position Sizing

```bash
# Deploy max 5% per trade (conservative)
MAX_TRADE_SIZE=0.05

# Deploy max 20% per trade (aggressive)
MAX_TRADE_SIZE=0.20
```

## 🔐 Security Best Practices

✅ **DO:**

- Keep `.env` and `keys/private.pem` secret
- Use `.gitignore` to prevent accidental commits
- Rotate API keys periodically
- Use strong passwords for Revolut & Anthropic
- Enable 2FA on all accounts

❌ **DO NOT:**

- Share your API keys
- Share your private key
- Commit `.env` to git
- Run with untested settings
- Trade with money you can't lose

## 🆘 Still Having Issues?

1. Check the full README.md for more info
2. Review logs with `LOG_LEVEL=debug`
3. Test each component manually:

   ```bash
   # Test API connection
   node -e "import('./src/revolut/client.js').then(m => new m.RevolutClient())"

   # Test Claude connection
   node -e "import('./src/agent/analyzer.js')"
   ```

4. Check Revolut X and Anthropic status pages

Happy trading! 🚀
