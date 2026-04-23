# tradeAgent 🤖

> Autonomous crypto trading agent powered by Claude AI, operating on Revolut X.  
> Multi-user architecture via Telegram — each user runs their own isolated trading instance with private credentials, strategy and trade history.

---

## What is this

tradeAgent is a production-ready autonomous trading system that connects real-time market data, computed technical indicators, and an LLM decision engine to execute crypto orders on Revolut X. It operates entirely through Telegram — no web dashboard, no CLI required for end users.

The system is designed around **multi-tenancy**: a single deployed bot instance serves multiple invited users, each with their own API keys, configuration, positions and P&L — completely isolated from one another in MongoDB.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           TELEGRAM                                   │
│  User A        User B         User N         Admin                   │
│  /btc /cron    /eth /status   /sol ...        /invite /users         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       multi-user-bot.js                              │
│  Long-polling loop · Routes each update to the correct UserSession   │
│  Onboarding wizard (4 steps) · Admin commands                        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  one UserSession per active user
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          UserSession                                 │
│  Isolated cron task · TelegramHandlers · userConfig (from MongoDB)   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  runAgentCycle(coin, userConfig)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Agent Cycle — executor.js                       │
│                                                                      │
│   0  Connect MongoDB                                                 │
│   1  Fetch market data ──────────────────────────► Revolut X API     │
│   2  Compute indicators (RSI, MACD, BB, EMA)                         │
│   3  Check forced SL / TP from open FIFO lots                        │
│   4  Build full Claude context                                       │
│  4b  Handle open limit orders (keep / cancel / buy_more)             │
│   5  Call Claude AI ─────────────────────────────► Anthropic API     │
│   6  Save decisions to MongoDB                                       │
│   7  Execute orders ─────────────────────────────► Revolut X API     │
│   8  Notify via Telegram                                             │
│   9  Save portfolio snapshot to MongoDB                              │
└─────────────────────────────────────────────────────────────────────┘
```

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
  ├── rendimiento ≥ TAKE_PROFIT_PCT  → force SELL (bypass Claude)
  └── rendimiento ≤ -STOP_LOSS_PCT  → force SELL (bypass Claude)
         │
         ▼
  Assemble Claude context JSON
  (indicators + confluence + balances + open lots + previous decisions
   + open orders + trading stats + candle changes + ATR + volume)
         │
         ▼
  Claude AI decides
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

## Technical Indicators — What they are and why

### RSI — Relative Strength Index (period 14)

Measures how fast and how much price has moved recently, normalized to 0–100. Values below 30 suggest the asset is oversold (potentially due for a bounce), above 70 suggest overbought (potentially due for a pullback).

The agent uses RSI in two ways: as a raw value Claude can reason about, and as a derived signal (`RSI_OVERSOLD`, `RSI_OVERBOUGHT`, `RSI_BEARISH_ZONE`, `RSI_BULLISH_ZONE`) that feeds the confluence score.

### MACD — Moving Average Convergence Divergence (12, 26, 9)

The MACD line is the difference between EMA(12) and EMA(26). The signal line is EMA(9) of the MACD line. The histogram is the difference between both. When the MACD crosses above the signal line, it indicates building momentum to the upside; the opposite signals weakening.

The agent sends three values: `macdLine`, `macdSignal`, `macdHistogram`. It also derives `MACD_BULLISH_CROSS` / `MACD_BEARISH_CROSS` and `MACD_MOMENTUM_INCREASING` / `MACD_MOMENTUM_DECREASING` by comparing the current histogram to the previous one.

### Bollinger Bands (period 20, 2 standard deviations)

Three lines: a 20-period SMA in the middle, and upper/lower bands at ±2σ. When price touches or breaks the lower band, it is statistically far from the mean (potential reversal zone). When bands narrow, volatility is contracting; when they expand, a breakout is likely.

The agent sends `bbUpper`, `bbMiddle`, `bbLower`, `bbWidth` (band width as % of middle), and `bbPosition` — a 0–100% value expressing where price sits within the bands. This last value is particularly useful for Claude as it is intuitive and scale-independent.

### EMA(12) / EMA(26) — Exponential Moving Averages

EMAs weight recent prices more heavily than older ones. The relationship between EMA(12) and EMA(26) reveals trend direction: EMA(12) > EMA(26) is a golden cross (bullish), EMA(12) < EMA(26) is a death cross (bearish). These are derived as signals that also feed the confluence score.

### SMA(20)

A simple 20-period moving average included as a reference for mean price. Sent to Claude but not used in the automated confluence scoring.

### Confluence score — the pre-computed summary

Rather than having Claude infer a sentiment entirely on its own from raw numbers, the system pre-computes a `confluence` object with explicit bullish/bearish signal lists and a `suggestion` field (`BUY_SIGNAL`, `SELL_SIGNAL`, `NEUTRAL`).

```js
// Signals that contribute to bullishCount:
(RSI_oversold,
  MACD_bullish_histogram,
  MACD_bullish_cross,
  EMA_golden_cross,
  BB_oversold_zone,
  BB_price_below_lower);

// Signals that contribute to bearishCount:
(RSI_overbought,
  MACD_bearish_histogram,
  MACD_bearish_cross,
  EMA_death_cross,
  BB_overbought_zone,
  BB_price_above_upper);

// suggestion = BUY_SIGNAL if bullishCount >= 2 AND bullishCount > bearishCount
//            = SELL_SIGNAL if bearishCount >= 2 AND bearishCount > bearishCount
//            = NEUTRAL otherwise
```

The system prompt instructs Claude to use the confluence suggestion as a _foundation_ but apply its own judgment to the final action and confidence — avoiding over-reliance on a single pre-computed label while still providing deterministic signal structure.

---

## What Claude receives — Full context breakdown

Every cycle Claude receives a single JSON message containing:

```jsonc
{
  "timestamp": "2025-04-22T10:00:00Z",

  // Portfolio state (with 1% safety buffer applied)
  "balances": {
    "fiat": { "USD": 487.50 },
    "crypto": { "BTC": { "amount": 0.00185, "estimatedUsdValue": 152.20 } },
    "summary": { "totalPortfolioUSD": 639.70, "availableForTrading": 487.50 }
  },

  // Open limit orders currently on the exchange
  "openOrders": [],

  // Per-pair market snapshot
  "marketData": [{
    "symbol": "BTC-USD",
    "ticker": { "bid": 81200, "ask": 81250, "mid": 81225, "last": 81240 },
    "orderBookTop": { "bestBid": {...}, "bestAsk": {...}, "bidDepth": 10, "askDepth": 10 },
    "recentClosesContext": {
      "timeframeMinutes": 60,
      "allCandles": { "count": 200, "totalChangePct": 3.2, "durationRange": "8.3 días" },
      "last30": {
        "totalChangePct": 1.1,
        "durationRange": "30.0 horas",
        "changesPercent": [0, 0.12, -0.08, ...],   // candle-by-candle % changes
        "volatilityATR": 312.4,                      // Average True Range
        "recentVolumes": [12.4, 9.8, 11.2, 10.5, 13.1],
        "avgVolume5": 11.4
      }
    }
  }],

  // Full computed indicators
  "indicators": {
    "BTC-USD": {
      "currentPrice": 81240,
      "rsi14": "58.34",
      "sma20": "80100.00",
      "ema12": "81050.00",
      "ema26": "80200.00",
      "macdLine": "850.0000",
      "macdSignal": "720.0000",
      "macdHistogram": "130.0000",
      "bbUpper": "83500.00",
      "bbMiddle": "80100.00",
      "bbLower": "76700.00",
      "bbWidth": "8.48%",
      "bbPosition": "67.4%",
      "signals": ["RSI_BULLISH_ZONE", "MACD_BULLISH_CROSS", "MACD_MOMENTUM_INCREASING", "EMA_GOLDEN_CROSS"],
      "confluence": {
        "bullishCount": 3,
        "bearishCount": 0,
        "bullishSignals": ["MACD_bullish_histogram", "MACD_bullish_cross", "EMA_golden_cross"],
        "bearishSignals": [],
        "suggestion": "BUY_SIGNAL"
      }
    }
  },

  // Last 3 decisions for this symbol (avoids flip-flopping)
  "previousDecisions": {
    "BTC-USD": [
      { "timestamp": "...", "action": "BUY", "confidence": 72, "reasoning": "..." }
    ]
  },

  // FIFO open buy lots (real position state)
  "openLots": [
    { "price": 79500, "remaining_qty": 0.00185, "remaining_cost_usd": 147.08, "created_at": "..." }
  ],

  // Recent sells to provide exit context
  "recentSells": [],

  // Weighted unrealized P&L across all open lots
  "rendimiento": 2.19,

  // Hard constraints
  "constraints": {
    "MAX_TRADE_SIZE": 25,
    "MIN_ORDER": 50,
    "DRY_RUN": false,
    "TAKE_PROFIT_PCT": 5,
    "STOP_LOSS_PCT": 3
  }
}
```

---

## Indicator quality — honest analysis

### What works well

The indicator set covers the three classic dimensions: **momentum** (RSI, MACD), **trend** (EMA cross), and **volatility/mean reversion** (Bollinger Bands). For an LLM-based agent this is a well-balanced combination because:

- Each indicator measures something qualitatively different, so they are relatively uncorrelated
- The confluence pre-computation gives Claude a structured signal to anchor reasoning, reducing the chance of hallucinated patterns
- `bbPosition` (0–100% within the bands) is particularly well-suited for a language model — it is scale-independent, intuitive, and immediately actionable
- Sending `macdHistogram` from both the current and previous candle (via `MACD_MOMENTUM_INCREASING/DECREASING`) adds directional momentum context that the raw MACD line alone doesn't provide
- ATR is included as a volatility measure, which helps Claude decide whether to widen TP/SL in high-volatility conditions
- The `changesPercent` array (candle-by-candle % changes for the last 30 candles) gives Claude a readable sequence of recent price action without sending raw OHLCV arrays, which would be expensive in tokens

### What could be improved

**No volume-weighted indicators.** Volume is sent (`recentVolumes`, `avgVolume5`) but not processed into anything like VWAP or On-Balance Volume. A strong MACD signal with declining volume is a warning sign that the system currently leaves for Claude to infer implicitly.

**RSI thresholds are fixed.** The confluence logic triggers at RSI < 35 for oversold and > 65 for overbought. In strongly trending markets, RSI can stay in overbought territory for extended periods without a reversal. A dynamic threshold (e.g., based on the RSI's own recent range) would reduce false signals.

**No higher timeframe context.** The agent analyzes a single timeframe defined by `INDICATORS_CANDLES_INTERVAL`. A practical improvement would be to send a second set of indicators for a higher timeframe (e.g., if the user uses 15-min candles, also send 4-hour indicators) so Claude can align short-term entries with the macro trend.

**SMA(20) is redundant alongside BB middle.** Since Bollinger Bands use SMA(20) as the middle band, both `sma20` and `bbMiddle` carry identical information. One of them can be removed to reduce token consumption.

**Confluence scoring is binary per signal.** Each signal contributes exactly 1 to the count regardless of magnitude. RSI at 25 (deep oversold) and RSI at 34 (barely oversold) both add 1 bullish point. Weighted scoring — where extreme RSI values contribute more — would give the confluence a more accurate picture of signal strength.

### How the context is passed to Claude

The design choice to **pre-process** market data before sending it to Claude is correct and important. Sending raw OHLCV arrays would consume tokens with redundant information and make the prompt brittle. The current approach sends:

- Processed scalar indicators (not time series)
- Pre-derived signal labels (not just raw numbers)
- A pre-computed confluence summary with an explicit `suggestion`
- Scale-independent derived metrics (`bbPosition`, `bbWidth`, `changesPercent`)
- Human-readable duration strings (`"30.0 horas"`, `"8.3 días"`)

This reduces the cognitive burden on Claude and keeps the prompt compact. The system prompt then instructs Claude to use the `suggestion` as a _foundation_ while applying its own judgment — a good balance between deterministic guardrails and LLM flexibility. Requiring strict JSON output and doing a robust fallback parse (`parseClaudeJsonResponse`) is the right approach for production reliability.

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

| Order type | `order_configuration` key | Size field                         |
| ---------- | ------------------------- | ---------------------------------- |
| Market     | `market`                  | `quote_size` (USD amount)          |
| Limit      | `limit`                   | `base_size` (crypto qty) + `price` |

Both `client_order_id` (UUID v4) and symbol format (`BTC-USD`, not `BTC/USD`) are strict requirements. The `OrderManager` handles both automatically.

---

## FIFO Position Tracking

Open positions are tracked in an `open_lots` collection rather than inferred from order history at query time. When a BUY executes, a lot record is inserted with `lot_status: 'open'`. When a SELL executes, `applySellToOpenLots()` consumes lots in chronological order (oldest first), computing realized P&L per lot and updating `remaining_qty`.

This gives Claude accurate position context on every cycle:

```js
openLots: [
  { price: 79500, remaining_qty: 0.00185, remaining_cost_usd: 147.08 },
  { price: 81000, remaining_qty: 0.0006, remaining_cost_usd: 48.6 },
];
// → avgEntryPrice = (147.08 + 48.60) / (0.00185 + 0.00060) = 79,869
// → rendimiento   = (currentPrice - avgEntryPrice) / avgEntryPrice × 100
```

This weighted average approach means Claude sees a realistic cost basis even after multiple partial buys at different prices — not just the last order price.

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
│   │   │   ├── analyzer-market.js      # Builds Claude user message
│   │   │   ├── open-order-analyzer.js  # Claude analysis for pending orders
│   │   │   └── prompts/
│   │   │       ├── trading-system-prompt.js
│   │   │       └── open-orders-system-prompt.js
│   │   └── workflow/
│   │       ├── market-fetch.js         # Balances, orders, candles
│   │       ├── context-builder.js      # Assembles full Claude context
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

---

## Environment Variables

Infrastructure-level only. Per-user trading credentials are stored in MongoDB and configured via Telegram.

```dotenv
# ── Telegram ─────────────────────────────────────
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=
ADMIN_TELEGRAM_ID=          # Your Telegram ID

# ── MongoDB ──────────────────────────────────────
MONGODB_URI=mongodb://admin:pass@mongodb:27017/trading_db?authSource=admin
MONGODB_DB=revolut-trading-agent
MONGO_ROOT_USERNAME=admin
MONGO_ROOT_PASSWORD=

# ── Admin fallback (optional) ────────────────────
REVOLUT_API_KEY=
REVOLUT_BASE_URL=https://revx.revolut.com
REVOLUT_PRIVATE_KEY_PATH=./keys/private.pem
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-haiku-4-5
TRADING_PAIRS=BTC-USD
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

---

## License

MIT

---

## Disclaimer

This software is provided as-is. Crypto trading involves significant financial risk. The agent makes autonomous decisions with real money when `DRY_RUN=false`. Always start with small position sizes and monitor closely. The authors are not liable for trading losses.
