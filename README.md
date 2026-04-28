# tradeAgent 🤖

> Autonomous crypto portfolio trading agent powered by Agentic AI, operating on Revolut X.  
> Multi-user architecture through Telegram — each user runs an isolated trading instance with private credentials, strategy, cron schedule, portfolio state and trading history.

---

## What is this

`tradeAgent` is an autonomous crypto trading agent that connects:

- Real-time market data from Revolut X
- Technical indicators
- Portfolio state
- Open orders
- FIFO position tracking
- Realized and unrealized P&L
- AI-based decision making
- Telegram control panel
- MongoDB persistence

The goal is not only to decide **BUY**, **SELL** or **HOLD**, but to behave as a `portfolio-aware autonomous agent.`

It understands:

- Available fiat balance
- Current crypto exposure
- Open positions managed by the bot
- Open limit orders on the exchange
- Recent executed orders
- Previous decisions
- Current unrealized performance
- Realized P&L
- Recent buys in other symbols
- Risk limits configured by the user

The project is designed around **multi-user isolation**.  
A single deployed bot can serve multiple invited users, but every user has their own:

- Revolut X credentials
- AI provider credentials
- Trading pairs
- Cron interval
- Strategy configuration
- Positions
- Decisions
- Orders
- Portfolio snapshots
- Trading statistics

---

## Architecture

````

## Architecture

```txt
┌─────────────────────────────────────────────────────────────────────┐
│                              TELEGRAM                                │
│                                                                     │
│  User A          User B          User N           Admin              │
│  /btc /cron      /eth /stats     /sol ...         /invite /users     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         multi-user-bot.js                            │
│                                                                     │
│  Long-polling loop                                                   │
│  Routes each update to the correct UserSession                       │
│  Handles onboarding, menus, callbacks and admin commands             │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                            UserSession                               │
│                                                                     │
│  One isolated runtime session per active user                        │
│  Own config                                                          │
│  Own cron task                                                       │
│  Own Telegram handlers                                               │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Agent Cycle                                  │
│                                                                     │
│  1. Fetch balances, market data and open orders                      │
│  2. Compute indicators                                               │
│  3. Build portfolio-aware context                                    │
│  4. Check forced take-profit / stop-loss                             │
│  5. Analyze pending limit orders                                     │
│  6. Call AI model or fallback chain                                  │
│  7. Validate decision with execution guards                          │
│  8. Place / cancel / skip orders                                     │
│  9. Save decisions, orders and portfolio snapshot                    │
│ 10. Notify user through Telegram                                     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
   Revolut X API           MongoDB 7              AI Provider
   Market / Orders         Users / Orders         Anthropic
   Balances / Ticker       Decisions / FIFO       OpenAI
   Candles / Auth          Stats / Snapshots      Gemini
                                                  DeepSeek
                                                  Groq

````

---

## The Agent — How it thinks

Each trading cycle follows this decision pipeline:

```
Candles (OHLCV) from Revolut X
         │
         ▼
  Extract close prices
         │
         ▼
  Compute indicator suite
  ├── RSI(14)
  ├── MACD(12, 26, 9)
  ├── Bollinger Bands(20, 2σ)
  ├── EMA(12) / EMA(26)
  ├── SMA(20)
  ├── Derived signals  (RSI_OVERSOLD, MACD_BULLISH_CROSS, EMA_GOLDEN_CROSS...)
  └── Confluence score (bullishCount vs bearishCount → BUY_SIGNAL | SELL_SIGNAL | NEUTRAL)
         │
         ▼
  FIFO position state from MongoDB
  ├── Open lots with entry price, remaining qty, cost
  ├── Weighted unrealized P&L (rendimiento %)
  └── Recent sell history for this symbol
         │
         ▼
  Forced exit check
  ├── rendimiento ≥ TAKE_PROFIT_PCT  → force SELL (bypass AI model)
  └── rendimiento ≤ -STOP_LOSS_PCT  → force SELL (bypass AI model)
         │
         ▼
  Assemble AI Model context JSON
  (indicators + confluence + balances + open lots + previous decisions
   + open orders + trading stats + candle changes + ATR + volume)
         │
         ▼
  Agent AI decides
  → action (BUY / SELL / HOLD)
  → positionPct (fraction of balance, scaled by confidence)
  → orderType (market / limit)
  → takeProfit / stopLoss prices
  → confidence score
  → reasoning (Spanish) + risks (Spanish)
         │
         ▼
  Execution guards
  ├── confidence < threshold → HOLD (no order)
  ├── usdAmount < MIN_ORDER  → skip
  ├── BUY:  cap at 99.5% of USD balance
  └── SELL: cap at 99.5% of coin balance
         │
         ▼
  OrderManager → Revolut X API
```

---

# Main features

## Multi-user Telegram bot

The bot supports multiple users from a single deployment.

Each user can:

- Configure their own Revolut X API key
- Configure their own private Ed25519 key
- Configure their own AI provider API key
- Select trading pairs
- Start manual analysis
- Enable or disable cron
- Change strategy parameters
- Check trading stats
- Ask the agent questions

## Autonomous portfolio-aware decision engine

The agent no longer acts only as a simple BUY / SELL predictor.

It receives a full context with:

- Real exchange balances
- Bot-managed positions
- Available USD balance
- Crypto exposure
- Open orders
- Open FIFO lots
- Realized P&L
- Unrealized P&L
- Recent market movement
- Technical indicators
- Previous decisions
- Recent executed orders
- Recent open buy from other symbols
- Configured max trade size
- Minimum order
- Take-profit and stop-loss rules

This makes the agent more consistent as a real autonomous portfolio manager.

## FIFO position tracking

Executed buys are stored as open lots.

When a sell is executed, the system consumes the oldest lots first using FIFO logic.

This allows the bot to calculate:

- Remaining quantity
- Remaining cost basis
- Average entry price
- Realized P&L
- Realized ROI
- Unrealized P&L
- Open position summary

```javascript
openLots: [
  {
    symbol: "BTC-USD",
    remaining_qty: 0.0012,
    entry_price: 75600,
    remaining_cost_usd: 90.72,
    lot_status: "open",
  },
];
```

When a sell closes part or all of the position, the matching buy lots are updated and the sell order stores the FIFO matches.

## Real trading statistics

The bot stores all decisions and executed orders in MongoDB.

From this, it calculates:

- Total decisions
- Total executed orders
- Total buys
- Total sells
- Execution rate
- Realized P&L
- Realized ROI
- Total invested
- Winning trades
- Losing trades
- Closed trades
- Win rate
- Open positions
- Manual positions detected from exchange balances
- Accumulated performance

This makes /stats much more useful than a simple list of orders.

## Open order management

For each open order, it can decide:

- **Keep the order**
- **Cancel the order**
- **Buy more**

Cancelled orders are marked as cancelled, so they are not incorrectly treated as active trading history.

## Portfolio guard

The workflow includes portfolio protection logic.

The agent does not blindly trade the full balance. It applies execution guards such as:

- Maximum trade size, Minimum order size
- Confidence threshold
- Available balance checks
- Sell quantity capped by available crypto
- Buy amount capped by available USD
- Avoiding orders when balance is insufficient
- Avoiding duplicated exposure when recent buys exist in other symbols

## AI provider support

The project is designed to support multiple AI providers.

**Supported provider model Ai groups**:

```
anthropic
openai
gemini
deepseek
groq
```

## Fallback chain

The bot can use a fallback chain of up to 3 providers.

```
Recomended use two models free and one to api pay key
```

If the first model fails because of rate limit, quota or network error, the agent can automatically try the next provider.

## The Agent — How it thinks

```txt
User trigger or cron
        │
        ▼
Fetch exchange truth
        │
        ├── balances
        ├── open orders
        ├── ticker
        ├── candles
        └── order book top
        │
        ▼
Compute indicators
        │
        ├── RSI 14
        ├── MACD 12/26/9
        ├── Bollinger Bands
        ├── EMA 12 / EMA 26
        ├── SMA 20
        ├── ATR
        └── confluence score
        │
        ▼
Build portfolio context
        │
        ├── fiat balance
        ├── crypto exposure
        ├── bot-managed positions
        ├── open FIFO lots
        ├── previous decisions
        ├── recent executed order
        ├── recent buy from other symbol
        ├── realized P&L
        └── unrealized P&L
        │
        ▼
Risk and forced exit checks
        │
        ├── take profit
        ├── stop loss
        ├── confidence threshold
        ├── max trade size
        └── min order
        │
        ▼
AI decision
        │
        ├── BUY
        ├── SELL
        └── HOLD
        │
        ▼
Execution
        │
        ├── market order
        ├── limit order
        ├── cancel open order
        └── skip safely
        │
        ▼

```

## Project structure

```txt
tradeAgent/
├── src/
│   ├── index.js
│   ├── multi-user-bot.js
│   │
│   ├── agent/
│   │   ├── executor.js
│   │   ├── context/
│   │   │   ├── analyzer-market.js
│   │   │   ├── indicators.js
│   │   │   ├── open-order-analyzer.js
│   │   │   ├── formatters/
│   │   │   │   └── build-open-orders-analyzer.js
│   │   │   └── prompts/
│   │   │       ├── confidence-threshold.js
│   │   │       ├── trading-system-prompt.js
│   │   │       └── open-orders-system-prompt.js
│   │   │
│   │   ├── entities/
│   │   │   ├── coins.js
│   │   │   └── models.js
│   │   │
│   │   ├── job/
│   │   │   └── client-agent-main.js
│   │   │
│   │   ├── services/
│   │   │   ├── clientAgent.js
│   │   │   ├── fallback-chain.js
│   │   │   └── functions/
│   │   │       └── json-parser.js
│   │   │
│   │   └── workflow/
│   │       ├── available-balance.js
│   │       ├── context-builder.js
│   │       ├── decision-engine.js
│   │       ├── market-fetch.js
│   │       ├── open-orders-manager.js
│   │       ├── order-executor.js
│   │       └── portfolio-guard.js
│   │
│   ├── config/
│   │   └── config.js
│   │
│   ├── revolut/
│   │   ├── client.js
│   │   ├── market.js
│   │   └── orders.js
│   │
│   ├── services/
│   │   └── mongo/
│   │       ├── client.js
│   │       └── mongo-service.js
│   │
│   ├── telegram/
│   │   ├── admin/
│   │   │   ├── admin-handlers.js
│   │   │   └── fallback-chain-handler.js
│   │   ├── entities/
│   │   │   └── cronPresets.js
│   │   ├── response/
│   │   │   └── callback-handler.js
│   │   ├── commands.js
│   │   ├── handles.js
│   │   ├── telegram.js
│   │   ├── telegram-handlers.js
│   │   └── utils.js
│   │
│   ├── users/
│   │   ├── onboarding-wizard.js
│   │   ├── user-config.js
│   │   ├── user-registry.js
│   │   └── user-session.js
│   │
│   └── utils/
│       ├── cron-formatter.js
│       ├── formatter.js
│       └── logger.js
│
├── scripts/
│   ├── generate-keys.js
│   └── setup-admin.js
│
├── scratch/
│   └── check-syntax.js
│
├── SETUP_GUIDE.md
├── USAGE_GUIDE.md
├── Dockerfile
├── docker-compose.yml
└── .env
```

## Technical Indicators — What they are and why

### RSI — Relative Strength Index (period 14)

Measures how fast and how much price has moved recently, normalized to 0–100. Values below 30 suggest the asset is oversold (potentially due for a bounce), above 70 suggest overbought (potentially due for a pullback).

The agent uses RSI in two ways: as a raw value can reason about, and as a derived signal `RSI_OVERSOLD, RSI_OVERBOUGHT, RSI_BEARISH_ZONE, RSI_BULLISH_ZONE` that feeds the confluence score.

### MACD — Moving Average Convergence Divergence (12, 26, 9)

The MACD line is the difference between EMA(12) and EMA(26). The signal line is EMA(9) of the MACD line. The histogram is the difference between both. When the MACD crosses above the signal line, it indicates building momentum to the upside; the opposite signals weakening.

The agent sends three values: `macdLine, macdSignal, macdHistogram, MACD_BULLISH_CROSS, MACD_BEARISH_CROSS, MACD_MOMENTUM_INCREASING, MACD_MOMENTUM_DECREASING` by comparing the current histogram to the previous one.

### Bollinger Bands (period 20, 2 standard deviations)

Used to detect volatility, mean reversion and breakout zones.

The agent receives: `bbUpper,bbMiddle, bbLower, bbWidth bbPosition`

### EMA(12) / EMA(26) — Exponential Moving Averages

Used to detect short-term trend.

Typical interpretation:

```
EMA 12 above EMA 26: bullish structure
EMA 12 below EMA 26: bearish structure
```

### ATR

Used to estimate volatility.

The bot also derives:
ATR as percentage of price
Volatility regime: low, medium or high
Move significance: small, normal or large

### Confluence score — the pre-computed summary

The bot pre-computes a deterministic confluence summary.

```js
{
  "bullishCount": 3,
  "bearishCount": 1,
  "bullishSignals": [
    "MACD_bullish_histogram",
    "MACD_bullish_cross",
    "EMA_golden_cross"
  ],
  "bearishSignals": [
    "RSI_overbought"
  ],
  "suggestion": "BUY_SIGNAL"
}
```

model uses this as a base, but it is not forced to follow it blindly.

---

## What Agent AI receives — Full context breakdown

Every cycle Agent AI receives a single JSON message containing:

```jsonc
{
  "exchangeTruth": {
    "balances": {
      "fiat": {
        "USD": 90.6,
      },
      "crypto": {},
      "summary": {
        "totalUSD": 90.6,
        "totalCryptoUSD": 0,
        "totalPortfolioUSD": 90.6,
        "availableForTrading": 90.6,
        "cashPercentage": 100,
        "cryptoPercentage": 0,
      },
    },
    "openOrders": [],
    "marketBySymbol": {
      "BTC-USD": {
        "ticker": {
          "bid": 76888.05,
          "ask": 76898.24,
          "mid": 76893.14,
          "last": 76872.91,
        },
        "currentPrice": 76872.91,
        "orderBookTop": {
          "bestBid": {},
          "bestAsk": {},
        },
      },
    },
  },
  "botState": {
    "openLots": [],
    "recentSells": [],
    "lastExecutedOrder": null,
    "rendimiento": null,
    "rendimientoAcumulado": 0,
    "tradingStats": {
      "totalDecisions": 62,
      "totalOrders": 3,
      "totalBuys": 2,
      "totalSells": 1,
      "executionRate": "4.8%",
      "totalRealizedPnL": 0.92,
      "roiRealized": "0.50%",
      "winningTrades": 1,
      "losingTrades": 0,
      "closedTrades": 1,
      "winRate": "100.0%",
      "openPositions": [],
    },
    "managedPositions": [],
  },
  "decisionContext": {
    "indicators": {
      "BTC-USD": {
        "currentPrice": 76872.91,
        "rsi14": 52.1,
        "ema12": 76920,
        "ema26": 77010,
        "macdHistogram": -15.2,
        "bbPosition": "45.3%",
        "confluence": {
          "suggestion": "NEUTRAL",
        },
      },
    },
    "regimeSummary": {
      "BTC-USD": {
        "trend_regime": "neutral",
        "momentum_regime": "mixed",
        "volatility_regime": "low",
        "market_structure": "range",
        "signal_quality": "mixed",
      },
    },
    "atrContext": {
      "BTC-USD": {
        "atr_value": 312.4,
        "atr_pct_of_price": 0.406,
        "volatility_regime": "low",
        "move_significance": "normal",
      },
    },
    "recentMarketContext": {
      "BTC-USD": {
        "timeframeMinutes": 60,
        "allCandles": {
          "count": 200,
          "totalChangePct": 3.2,
          "durationRange": "8.3 días",
        },
        "last30": {
          "totalChangePct": 1.1,
          "durationRange": "30.0 horas",
          "changesPercent": [0, 0.12, -0.08],
          "volatilityATR": 312.4,
          "recentVolumes": [12.4, 9.8, 11.2],
          "avgVolume5": 11,
        },
      },
    },
    "previousDecisions": {},
    "priceChangeSinceLastAnalysisPct": 0,
  },
  "constraints": {
    "MAX_TRADE_SIZE": 10,
    "MIN_ORDER": 50,
    "DRY_RUN": false,
    "TAKE_PROFIT_PCT": 0,
    "STOP_LOSS_PCT": 0,
  },
}
```

---

## Indicator quality — honest analysis

### What works well

The indicator set covers the three classic dimensions: **momentum** (RSI, MACD), **trend** (EMA cross), and **volatility/mean reversion** (Bollinger Bands). For an LLM-based agent this is a well-balanced combination because:

### How the context is passed to Agent AI

The design choice to **pre-process** market data before sending it to Agent AI is correct and important. Sending raw OHLCV arrays would consume tokens with redundant information and make the prompt brittle. The current approach sends:

---

## Revolut X Integration

### Authentication

Every request is signed with Ed25519. The signature covers the timestamp, HTTP method, URL path, query string, and request body — preventing replay attacks and request tampering.

```
signature = Ed25519.sign(
  privateKey,
  message = timestamp + METHOD + /api/1.0/endpoint + queryString + body
)

Headers:
  X-Revx-Api-Key:    <64-char API key>
  X-Revx-Timestamp:  <unix ms>
  X-Revx-Signature:  <base64 signature>
```

Private keys are stored per-user in MongoDB (as PEM) and written to a temp file (`chmod 600`) at session startup. The key material never appears in logs.

### Clock skew auto-correction

Revolut X rejects requests with timestamps too far from server time (HTTP 409). The client automatically corrects for this:

1. A 409 response includes the server's current timestamp in the error body
2. The client computes `clockOffsetMs = serverTimestamp - Date.now()`
3. All subsequent requests add this offset to their timestamp

This makes the system resilient to NTP drift on the host without any manual intervention.

### Order types and API quirks

```
| Order type | `order_configuration` key | Size field                         |
| ---------- | ------------------------- | ---------------------------------- |
| Market     | `market`                  | `quote_size` (USD amount)          |
| Limit      | `limit`                   | `base_size` (crypto qty) + `price` |
```

---

This weighted average approach means Agent AI sees a realistic cost basis even after multiple partial buys at different prices — not just the last order price.

---

## Project Structure

```
tradeAgent/
├── src/
│   ├── index.js                        # Entry point
│   ├── multi-user-bot.js               # Master bot: routing, onboarding, admin
│   │
│   ├── users/
│   │   ├── user-registry.js            # User accounts, invite system, statuses
│   │   ├── user-config.js              # Per-user config object builder
│   │   ├── user-session.js             # Isolated session + cron per user
│   │   └── onboarding-wizard.js        # 4-step Telegram setup wizard
│   │
│   ├── agent/
│   │   ├── executor.js                 # Full cycle orchestrator
│   │   ├── services/clientAgent.js     # Anthropic SDK wrapper + JSON parser
│   │   ├── context/
│   │   │   ├── indicators.js           # RSI, MACD, BB, EMA computation
│   │   │   ├── analyzer-market.js      # Builds Agent AI user message
│   │   │   ├── open-order-analyzer.js  # Agent AI analysis for pending orders
│   │   │   └── prompts/
│   │   │       ├── trading-system-prompt.js
│   │   │       └── open-orders-system-prompt.js
│   │   └── workflow/
│   │       ├── market-fetch.js         # Balances, orders, candles
│   │       ├── context-builder.js      # Assembles full Agent AI context
│   │       ├── decision-engine.js      # Forced SL/TP check
│   │       ├── order-executor.js       # Validates + places orders
│   │       ├── open-orders-manager.js  # Manages pending limit orders
│   │       └── portfolio-guard.js      # Drawdown circuit breaker
│   │
│   ├── revolut/
│   │   ├── client.js                   # Ed25519 HTTP client + clock skew fix
│   │   ├── market.js                   # Ticker, candles, order book, balances
│   │   └── orders.js                   # Place / cancel orders
│   │
│   ├── telegram/
│   │   ├── telegram-handlers.js        # Full bot UI (menus, config, callbacks)
│   │   ├── commands.js                 # Text command router
│   │   ├── handles.js                  # notify(), notifyError()
│   │   └── entities/cronPresets.js     # Cron schedule presets
│   │
│   ├── config/config.js                # Shared infrastructure config
│   └── utils/
│       ├── mongodb.js                  # All DB ops (decisions, orders, FIFO, P&L)
│       ├── logger.js                   # Structured logger
│       └── formatter.js                # Telegram message formatting
│
├── scripts/
│   ├── generate-keys.js                # Ed25519 key pair generator
│   └── setup-admin.js                  # Bootstrap admin user
│
├── Dockerfile
├── docker-compose.yml
└── .env
```

---

## Tech Stack

```
| Layer          | Technology                                     |
| -------------- | ---------------------------------------------- |
| Runtime        | Node.js ≥ 20 (ESM)                             |
| AI             | Anthropic Claude (`claude-haiku-4-5`)          |
| Exchange       | Revolut X REST API                             |
| Authentication | Ed25519 per-user signatures                    |
| Database       | MongoDB 7                                      |
| Bot            | Telegram Bot API (long-polling, no framework)  |
| Indicators     | `technicalindicators` (RSI, MACD, BB, EMA/SMA) |
| Scheduling     | `node-cron`                                    |
| Infrastructure | Docker + Docker Compose                        |
```

---

## Running locally

```bash
npm install
npm run gen-keys           # Generate Ed25519 keys
node scripts/setup-admin.js
npm run dev                # Auto-reload
```

```bash
docker-compose up -d                    # Start all services
docker-compose logs -f trading-agent    # Follow logs
docker-compose down                     # Stop (data preserved)
```

## User onboarding

Users configure their account from Telegram.

The onboarding wizard asks for:

1. Revolut X API key
2. Revolut X private Ed25519 key
3. AI provider API key
4. Trading pairs

```
BTC-USD,ETH-USD,SOL-USD
```

---

## Strategy configuration

```
| Key                           | Meaning                                       |
| ----------------------------- | --------------------------------------------- |
| `TRADING_PAIRS`               | Symbols the agent can trade                   |
| `MAX_TRADE_SIZE`              | Max percentage of available balance per trade |
| `MIN_ORDER`                   | Minimum USD order size                        |
| `TAKE_PROFIT_PCT`             | Forced take-profit percentage                 |
| `STOP_LOSS_PCT`               | Forced stop-loss percentage                   |
| `VISION_AGENT`                | Agent trading horizon                         |
| `PERSONALITY_AGENT`           | Agent risk profile                            |
| `INDICATORS_CANDLES_INTERVAL` | Candle timeframe in minutes                   |
```

## Agent personality

```
Conservative
- Higher confidence required
- Smaller positions
- More likely to hold
- Better for low-risk use
```

```
Moderate
- Balanced behaviour
- Default option
- Good for swing trading and general use
```

```
Aggressive
- Lower confidence threshold
- More willing to enter
- Higher risk
```

## Agent vision

```
short
INDICATORS_CANDLES_INTERVAL=5
CRON_SCHEDULE=*/15 * * * *
```

```
medium
INDICATORS_CANDLES_INTERVAL=60
CRON_SCHEDULE=0 */2 * * *
```

```
long
INDICATORS_CANDLES_INTERVAL=720
CRON_SCHEDULE=0 */12 * * *
```

### Recommended safe start

```
TRADING_PAIRS=BTC-USD
MAX_TRADE_SIZE=10
MIN_ORDER=50
TAKE_PROFIT_PCT=3
STOP_LOSS_PCT=2
PERSONALITY_AGENT=moderate
VISION_AGENT=medium
INDICATORS_CANDLES_INTERVAL=60
CRON_SCHEDULE=2hour
CRON_ENABLED=true

```

## Known limitations

This project is not a guaranteed profitable system.

- No true market depth strategy
- No professional backtesting engine
- No portfolio optimization model
- No guaranteed slippage control
- No tax reporting
- No advanced risk engine by volatility-adjusted position sizing
- AI output can still be wrong
- Technical indicators can fail in news-driven markets
- Revolut X API availability can affect execution
- Crypto markets are highly volatile

## License

MIT

---

## Disclaimer

This software is provided as-is. Crypto trading involves significant financial risk. The agent makes autonomous decisions with real money when `DRY_RUN=false`. Always start with small position sizes and monitor closely. The authors are not liable for trading losses.
