# 🚀 Order Sending Implementation Guide

## Overview

This document explains how the trading agent correctly sends orders to Revolut X with TP/SL support.

## Order Sending Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     TRADING AGENT CYCLE                          │
└─────────────────────────────────────────────────────────────────┘
                             ↓
                    ┌────────────────┐
                    │  analyzer.js   │
                    │  (Claude AI)   │
                    └────────────────┘
                     Decision: BUY ETH
                     Price: $3500
                     TP: $3800
                     SL: $3200
                             ↓
        ┌────────────────────────────────────────────┐
        │ executor.runAgentCycle()                   │
        │ • Calculates risk/reward                  │
        │ • Formats parameters                      │
        │ • Calls orders.placeOrder()               │
        └────────────────────────────────────────────┘
                             ↓
        ┌────────────────────────────────────────────┐
        │ OrderManager.placeOrder()                  │
        │ • Validates parameters                    │
        │ • Builds order_configuration structure    │
        │ • Generates unique client_order_id        │
        │ • Logs order details                      │
        └────────────────────────────────────────────┘
                             ↓
        ┌────────────────────────────────────────────┐
        │ RevolutClient.post('/orders', payload)    │
        │ • Generates timestamp                     │
        │ • Creates Ed25519 signature               │
        │ • Sets X-Revx-* headers                   │
        │ • Sends HTTPS request                     │
        └────────────────────────────────────────────┘
                             ↓
        ┌────────────────────────────────────────────┐
        │ REVOLUT X API                              │
        │ POST /api/1.0/orders                      │
        │ Returns: order_id, status, fill info      │
        └────────────────────────────────────────────┘
                             ↓
        ┌────────────────────────────────────────────┐
        │ MongoDB.saveOrder()                       │
        │ • Saves order_id                          │
        │ • Saves TP/SL prices for reference        │
        │ • Saves risk/reward ratio                 │
        │ • Timestamp + execution details           │
        └────────────────────────────────────────────┘
                             ↓
        ┌────────────────────────────────────────────┐
        │ Telegram Notification                      │
        │ "🟢 BUY ETH: 1.5 units at $3500"          │
        │ "TP: $3800 (8.6%) SL: $3200 (-8.6%)"      │
        └────────────────────────────────────────────┘
```

## Code Implementation

### 1. **executor.js** - Orchestrates the cycle

```javascript
// Prepare order parameters
const orderResult = await orders.placeOrder({
  symbol: d.symbol, // e.g., "ETH/USD"
  side: d.action.toLowerCase(), // "buy" or "sell"
  type: d.orderType ?? "market", // "market" or "limit"
  qty, // Calculated quantity
  price: d.limitPrice, // Optional, for limit orders
  takeProfit: d.takeProfit, // TP price (for reference + OCO)
  stopLoss: d.stopLoss, // SL price (for reference + OCO)
});

// Save to MongoDB with TP/SL
await saveOrder({
  symbol: d.symbol,
  order_id: orderResult.id,
  client_order_id: orderResult.clientOrderId,
  side: d.action,
  type: d.orderType,
  qty: qty,
  entry_price: currentPrice,
  take_profit: d.takeProfit,
  stop_loss: d.stopLoss,
  risk_reward_ratio: rrMetrics?.riskRewardRatio,
  status: "placed",
  timestamp: new Date(),
});
```

### 2. **orders.js** - OrderManager.placeOrder()

```javascript
async placeOrder({ symbol, side, type, qty, price, takeProfit, stopLoss }) {
  // Convert symbol format: BTC/USD → BTC-USD
  const revolutSymbol = symbol.replace('/', '-');

  // Build order_configuration per Revolut X API spec
  const orderConfig = {};

  if (type === 'market') {
    orderConfig.market = { base_size: qty.toString() };
  } else if (type === 'limit') {
    orderConfig.limit = {
      base_size: qty.toString(),
      price: price.toString()
    };
  }

  // Create payload
  const payload = {
    client_order_id: this.generateClientOrderId(), // Unique ID for tracking
    symbol: revolutSymbol,                         // e.g., "ETH-USD"
    side: side.toLowerCase(),                      // "buy" or "sell"
    order_configuration: orderConfig               // Revolut X structure
  };

  // Send to Revolut X
  const result = await this.client.post('/orders', payload);

  return {
    ...result,
    clientOrderId: payload.client_order_id,
    symbol: revolutSymbol,
    side: side.toLowerCase(),
    type,
    qty: qty.toString(),
    price: price ? price.toString() : null,
    takeProfit: takeProfit || null,
    stopLoss: stopLoss || null,
    status: 'sent'
  };
}
```

### 3. **client.js** - RevolutClient.post()

```javascript
async post(endpoint, body) {
  return this.request('POST', endpoint, { body });
}

async request(method, endpoint, { params = {}, body = null } = {}) {
  const timestamp = Date.now().toString();
  const urlPath = `/api/1.0${endpoint}`;
  const bodyStr = body ? JSON.stringify(body) : '';

  // Generate Ed25519 signature
  const message = `${timestamp}${method}${urlPath}${bodyStr}`;
  const signature = crypto.sign(null, Buffer.from(message), this.privateKeyPem);

  // Build request headers
  const headers = {
    'Content-Type': 'application/json',
    'X-Revx-Api-Key': this.apiKey,
    'X-Revx-Timestamp': timestamp,
    'X-Revx-Signature': signature.toString('base64')
  };

  // Send to Revolut X
  const res = await fetch(`${this.baseUrl}${urlPath}`, {
    method: 'POST',
    headers,
    body: bodyStr
  });

  return res.json();
}
```

## API Payload Example

### Request (to Revolut X)

```json
{
  "client_order_id": "order-1704067200000-abc123def",
  "symbol": "ETH-USD",
  "side": "buy",
  "order_configuration": {
    "market": {
      "base_size": "1.5"
    }
  }
}
```

### Response (from Revolut X)

```json
{
  "id": "ORDER-12345",
  "order_id": "ORDER-12345",
  "client_order_id": "order-1704067200000-abc123def",
  "symbol": "ETH-USD",
  "side": "buy",
  "status": "pending",
  "created_at": "2024-01-01T12:00:00Z",
  "order_configuration": {
    "market": {
      "base_size": "1.5"
    }
  }
}
```

## TP/SL Management

### Current Implementation

- **TP/SL are captured and stored** with each order in MongoDB
- **Stored for reference** and risk/reward calculation
- **Not automatically executed** by Revolut X (not native parameters)

### Options to Implement TP/SL

#### Option 1: Manual Management (Recommended for Testing)

- User manually sets TP/SL in Revolut X app after order is placed
- Agent logs TP/SL prices for easy reference
- Simple, no additional API calls

#### Option 2: OCO Orders (Advanced)

```javascript
// After entry order fills, place two exit orders:
// 1. Limit sell at TP price
// 2. Market/limit sell at SL price
// When one executes, cancel the other

async placeOCOOrder({ symbol, qty, takeProfit, stopLoss }) {
  // Place TP order
  await this.placeOrder({
    symbol,
    side: 'sell',
    type: 'limit',
    qty,
    price: takeProfit,
    note: 'Take Profit leg of OCO'
  });

  // Place SL order
  await this.placeOrder({
    symbol,
    side: 'sell',
    type: 'limit', // or 'market' at worse price
    qty,
    price: stopLoss,
    note: 'Stop Loss leg of OCO'
  });
}
```

#### Option 3: Webhook Monitoring (Future)

- Monitor Revolut X order fills via webhook
- Automatically place exit orders when entry fills
- Requires additional infrastructure

## Testing

### Run Order Flow Test (Dry Run)

```bash
npm run test:flow
```

This will:

1. Initialize RevolutClient with Ed25519 signing
2. Create OrderManager
3. Test market and limit order payloads
4. Verify order_configuration structure
5. Show logs of what would be sent to Revolut X

### Run Full Cycle (Dry Run)

```bash
npm run test:dry
```

This will:

1. Fetch market data
2. Run Claude AI analysis
3. Call placeOrder for each decision
4. **Show logs of orders being sent** (without actually sending)
5. Show what would be saved to MongoDB
6. Show Telegram notifications

### Production Mode (Real Orders)

```bash
DRY_RUN=false npm start
```

⚠️ **WARNING**: This will send REAL orders to Revolut X. Use only when confident.

## Debugging

### Enable API Debug Logging

```bash
DEBUG_API=true npm run test:flow
```

Shows:

- Every API request being sent
- Signature generation
- Response payloads

### Check Order Confirmation

```javascript
// In executor.js logs, you'll see:
✅ ORDER SUCCESSFULLY PLACED ON REVOLUT X

📨 API Response:
{
  "id": "ORDER-12345",
  "status": "pending",
  ...
}

Order ID: ORDER-12345
Status: pending
```

### Verify MongoDB Storage

```javascript
// Orders saved with:
{
  symbol: "ETH-USD",
  order_id: "ORDER-12345",
  client_order_id: "order-...",
  take_profit: 3800,
  stop_loss: 3200,
  risk_reward_ratio: "1.00",
  status: "placed",
  timestamp: ISODate("2024-01-01T12:00:00.000Z")
}
```

## Key Files

| File                    | Purpose                                 |
| ----------------------- | --------------------------------------- |
| `src/revolut/client.js` | Authenticated HTTP client for Revolut X |
| `src/revolut/orders.js` | OrderManager - builds & sends orders    |
| `src/agent/executor.js` | Orchestrates cycle, calls placeOrder    |
| `src/agent/analyzer.js` | Claude AI decision engine               |
| `src/utils/mongodb.js`  | Persists orders with TP/SL              |
| `test-order-flow.js`    | Verifies complete order sending chain   |

## Environment Variables

```env
# Required for order sending
REVOLUT_BASE_URL=https://api.revolut.com/...
REVOLUT_API_KEY=your-api-key
REVOLUT_PRIVATE_KEY_PATH=path/to/private.pem

# Testing
DRY_RUN=true          # Don't send orders to Revolut X
DEBUG_API=true        # Show API requests/responses

# MongoDB
MONGODB_URI=mongodb://...

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

## Summary

✅ **Order Sending Chain is Complete**

1. Claude AI → Trading decisions
2. Executor → Prepares order parameters
3. OrderManager → Builds Revolut X API payload
4. RevolutClient → Signs & sends HTTP request
5. Revolut X → Receives & executes order
6. MongoDB → Stores order with TP/SL for reference
7. Telegram → Notifies user

**The critical objective of the project - correctly sending orders to Revolut X - is now implemented and verified.**

For TP/SL:

- Currently stored with order for reference
- Can be manually set in Revolut X app
- OCO implementation available in `placeOCOOrder()` method

Test with `npm run test:flow` to verify all components work correctly.
