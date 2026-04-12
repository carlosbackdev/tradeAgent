# 🤖 Revolut X Trading Agent

Autonomous crypto trading agent powered by **Claude AI**. Analyzes market data with technical indicators (RSI, MACD, Bollinger Bands, EMAs), makes trading decisions, executes orders on Revolut X, and sends real-time Telegram notifications.

## 🏗️ Architecture

```
src/
├── index.js            # Entry point + cron scheduler
├── agent/
│   ├── analyzer.js     # Claude API — decision engine
│   ├── executor.js     # Orchestrates one full cycle
│   └── indicators.js   # RSI, MACD, BB, EMA computation
├── revolut/
│   ├── client.js       # Ed25519-signed HTTP client
│   ├── market.js       # Ticker, orderbook, balances
│   └── orders.js       # Place/cancel orders
├── notifications/
│   └── telegram.js     # Telegram Bot alerts
└── utils/
    ├── config.js       # Configuration & validation
    ├── formatter.js    # HTML message formatting
    └── logger.js       # Structured logging

scripts/
├── generate-keys.js    # Generate Ed25519 key pair
└── README_SETUP.md     # Detailed setup instructions

keys/
├── private.pem         # Private key (NEVER commit)
└── public.pem          # Public key
```

## 📊 Agent Cycle (every N minutes)

```
Fetch prices + orderbook + balances
        ↓
Compute RSI, MACD, Bollinger, EMAs
        ↓
Send full context to Claude
        ↓
Parse decision: BUY / SELL / HOLD
        ↓
Execute order if confidence ≥ 55%
        ↓
Notify via Telegram
```

## ✅ Prerequisites

- **Node.js** ≥ 20 ([Download](https://nodejs.org/))
- **Revolut X** account with API access enabled
- **Anthropic API key** ([Get here](https://console.anthropic.com/))
- **Telegram Bot** (created via [@BotFather](https://t.me/BotFather))

## 🚀 Quick Start (5 minutes)

### 1️⃣ Clone & Install Dependencies

```bash
# Clone the repository
git clone https://github.com/YOUR_USER/revolut-trading-agent
cd revolut-trading-agent

# Install Node.js packages
npm install
```

### 2️⃣ Generate API Keys

```bash
npm run gen-keys
```

This creates:

- `keys/private.pem` — **KEEP SECRET** (never commit)
- `keys/public.pem` — Use in Revolut X

### 3️⃣ Configure Revolut X

1. Log in to [Revolut X](https://trading.revolut.com)
2. Navigate to **Profile → API Keys → Create API Key**
3. Paste the contents of `keys/public.pem`
4. Save the resulting **64-character API key**

### 4️⃣ Create Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`
2. Follow the prompts to create your bot
3. Save the **bot token**
4. Start a chat with your bot
5. Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
6. Find your **chat_id** in the response

### 5️⃣ Configure Environment

```bash
# Copy the example file
cp .env.example .env

# Edit .env with your credentials
# On Windows: notepad .env
# On macOS/Linux: nano .env (or vim)
```

**Optional variables:**

```bash
DRY_RUN=true              # Test without real trades
LOG_LEVEL=debug           # Verbose logging
DEBUG_API=true            # Log API requests
```

## ▶️ Running the Agent

### Start the daemon (continuous cron)

```bash
npm start
```

This will run indefinitely, executing trades on your schedule.

### Manual trigger (test once)

```bash
npm run trigger
```

Executes one cycle immediately and exits.

### Dry-run mode (no real trades)

```bash
npm run test:dry
```

Simulates trades without actually placing orders.

### Development mode (auto-reload)

```bash
npm run dev
```

Restarts on file changes (useful for debugging).

## 📋 Configuration Examples

### Aggressive trading (every 5 minutes)

```bash
CRON_SCHEDULE="*/5 * * * *"
MAX_TRADE_SIZE=0.15
MIN_ORDER=25
```

### Conservative daytime trading (business hours only)

```bash
CRON_SCHEDULE="0 9-17 * * 1-5"  # 9am-5pm weekdays
MAX_TRADE_SIZE=0.05
MIN_ORDER=100
```

### Lazy overnight (once an hour)

```bash
CRON_SCHEDULE="0 * * * *"
MAX_TRADE_SIZE=0.20
MIN_ORDER=50
```

## 🧠 How Claude Makes Decisions

The agent sends **all market data** to Claude:

- **Price & Volume**: Current ticker, order book depth, recent trades
- **Technical Indicators**: RSI (oversold/overbought), MACD (momentum), Bollinger Bands (volatility), EMAs (trend)
- **Portfolio State**: Current balances, open orders, trade history
- **Config Constraints**: Position size limits, order minimums

Claude responds with:

```json
{
  "decisions": [
    {
      "symbol": "BTC/USD",
      "action": "BUY",
      "confidence": 72,
      "usdAmount": 150,
      "reasoning": "RSI oversold, MACD bullish, price at lower BB..."
    }
  ]
}
```

The agent only executes if:

1. Confidence ≥ 55%
2. Order amount ≥ `MIN_ORDER`
3. Position size ≤ `MAX_TRADE_SIZE` of portfolio

## ⚠️ Risk Management

**IMPORTANT:** This agent trades with real money. Always:

✅ **DO:**

- Start with `DRY_RUN=true` to test
- Use small position sizes (`MAX_TRADE_SIZE=0.05` initially)
- Monitor the Telegram notifications
- Review trades in Revolut X regularly

❌ **DO NOT:**

- Run with large position sizes until confident
- Commit `.env` or `keys/private.pem` to git
- Share your API key or private key
- Trade with money you can't afford to lose

## 🔧 Troubleshooting

### Missing env variables

```
❌ Missing required env vars: REVOLUT_API_KEY, ANTHROPIC_API_KEY
```

**Solution:** Check `.env` file exists and all variables are filled in.

```bash
# Check what's missing
cat .env | grep -v "^#" | grep "^" | cut -d= -f1 | sort
```

### Private key not found

```
Private key not found at: ./keys/private.pem
```

**Solution:** Generate keys first:

```bash
npm run gen-keys
```

### Revolut API authentication failed

```
Revolut API 401: Unauthorized
```

**Causes:**

- Wrong API key (check Revolut X settings)
- Wrong private key path
- Key pair mismatch (regenerate if unsure)

**Solution:**

```bash
rm keys/*.pem
npm run gen-keys
# Update your API key in Revolut X
```

### Claude API rate limited

```
Rate limit exceeded...
```

**Solution:** Increase `CRON_SCHEDULE` interval (run less frequently):

```bash
# Change from every 15 min to every 30 min
CRON_SCHEDULE="*/30 * * * *"
```

### No Telegram notifications

Check:

1. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are correct
2. You started a chat with your bot
3. The bot has permission to send messages

## 📈 Monitoring & Logs

The agent logs to console:

```
[2024-04-12T10:30:45.123Z] 🤖 Agent cycle started (trigger: cron)
[2024-04-12T10:30:46.456Z] ℹ️  INFO: Fetching market data...
[2024-04-12T10:30:48.789Z] 🔍 DEBUG: RSI: 28, MACD: bullish
[2024-04-12T10:30:50.012Z] ✅ Order executed: BTC/USD BUY 0.005
```

**Log levels:**

```bash
LOG_LEVEL=debug    # Verbose (development)
LOG_LEVEL=info     # Standard (default)
LOG_LEVEL=warn     # Warnings + errors only
LOG_LEVEL=error    # Errors only
```

## 🔒 Security Checklist

- [ ] `.env` is in `.gitignore`
- [ ] `keys/private.pem` is in `.gitignore`
- [ ] Never share your API keys or private key
- [ ] Use strong, unique bot token
- [ ] Rotate API keys periodically
- [ ] Test with small orders first
- [ ] Monitor trades regularly

## 🤝 Contributing

Contributions welcome! Areas to improve:

- [ ] Better error recovery & retry logic
- [ ] Persistent order history (database)
- [ ] Advanced position sizing (Kelly criterion)
- [ ] More indicators (Stochastic, ADX, ATR)
- [ ] Backtesting framework
- [ ] Web dashboard for monitoring
- [ ] Support for more exchanges

## 📝 License

MIT

## ⚠️ Disclaimer

**This software is provided as-is.** Trading crypto involves risk:

- Past performance ≠ future results
- Markets can move unexpectedly
- Always use risk management
- Start small, test thoroughly
- **I am not liable for losses**

Trade responsibly. 🎯

| `DRY_RUN` | **Start with `true`** until you trust the agent |

### 6. Run

```bash
# Start as daemon (cron-based)
npm start

# Single manual trigger (great for testing)
npm run trigger

# Development with auto-reload
npm run dev
```

## Safety

- **Always start with `DRY_RUN=true`** — the agent will log and notify decisions without executing
- Claude requires confidence ≥ 55% before a trade fires
- Orders below `MIN_ORDER` are skipped
- The `.gitignore` excludes `.env` and `keys/` — double-check before pushing

## 🗄️ MongoDB Integration (Español)

El agente incluye integración con **MongoDB** para persistencia de datos. Todos los datos se almacenan automáticamente.

### Base de Datos

Tres colecciones principales:

1. **`decisions`** - Cada decisión que Claude toma (BUY, SELL, HOLD)
   - `symbol`, `action`, `confidence`, `reasoning`, `risks`, `created_at`

2. **`orders`** - Órdenes ejecutadas en Revolut
   - `symbol`, `side`, `qty`, `price`, `status`, `revolut_order_id`, `decision_id`

3. **`portfolio_snapshots`** - Estado del portfolio tras cada ciclo
   - `balances` (objeto con todos los saldos), `created_at`

### Configuración

```bash
# .env
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB=revolut-trading-agent
```

**Opciones:**

- Local: `mongodb://localhost:27017`
- Docker: `mongodb://mongodb:27017`
- Atlas: `mongodb+srv://user:pass@cluster.mongodb.net`

### Uso

El agente automáticamente:

- Conecta a MongoDB al iniciar cada ciclo
- Guarda decisiones de Claude
- Guarda órdenes ejecutadas
- Guarda snapshots del portfolio
- Se desconecta al finalizar

No requiere configuración adicional. Para más detalles, consulta [`MONGODB_RESUMEN.md`](MONGODB_RESUMEN.md).

### Beneficios

✅ Contexto histórico para análisis
✅ Auditoría completa de decisiones y órdenes
✅ Cálculo de P&L real
✅ Base para backtesting futuro
✅ Dashboard de desempeño (futuro)

## Deployment options

| Option                      | Notes                                           |
| --------------------------- | ----------------------------------------------- |
| VPS (DigitalOcean, Hetzner) | `pm2 start src/index.js` for process management |
| Railway / Render            | Set env vars in dashboard, deploy directly      |
| GitHub Actions              | Use `workflow_dispatch` or a scheduled workflow |
| Raspberry Pi                | Runs fine on ARM, low power                     |
| Docker + MongoDB            | Ver `MONGODB_RESUMEN.md` para docker-compose    |
