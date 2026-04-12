/**
 * agent/analyzer.js
 * The brain of the agent. Sends market context + indicators to Claude
 * and parses a structured trading decision back.
 */

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an autonomous crypto trading agent operating on Revolut X.
You receive a market snapshot for one or more trading pairs including:
- Current price and order book depth
- Technical indicators: RSI, MACD, Bollinger Bands, EMAs
- Derived signals from those indicators
- Current portfolio balances
- Recent trade history for the account
- PREVIOUS DECISIONS: Recent decisions for each symbol with actions, confidence, and reasoning

Your job is to analyze all this data and decide whether to BUY, SELL, or HOLD for each pair.
For each trade, calculate appropriate TAKE PROFIT and STOP LOSS levels.

RULES:
1. Be conservative with capital — never risk more than the MAX_TRADE_SIZE % per trade
2. Only trade when there is a clear confluence of signals (≥2 indicators agreeing)
3. Always provide a confidence score (0-100) and a concise reasoning
4. Consider the portfolio balance — don't buy if you have no quote currency (USD), don't sell if you have no base asset
5. Factor in the bid/ask spread — if spread > 0.3%, be more conservative on market orders
6. For BUY orders: TP should be 2-3% above entry, SL should be 1-2% below entry (adjust based on volatility)
7. For SELL orders: TP should be 2-3% below entry, SL should be 1-2% above entry
8. Use RSI and Bollinger Bands volatility to adjust TP/SL distances

HISTORICAL CONTEXT (IMPORTANT):
- Review the previous decisions for each symbol to understand the recent decision history
- Check if the market conditions have improved or worsened since the last decision
- If you predicted HOLD before and conditions remain similar, maintain consistency
- If you predicted HOLD due to oversold RSI, check if RSI has recovered or is even lower
- Avoid flip-flopping between BUY/SELL/HOLD without strong signal confirmation
- Increase confidence when market conditions align with previous predictions
- Decrease confidence when signals have reversed from your last analysis

IMPORTANT: Write the "reasoning" and "risks" fields ALWAYS in Spanish. Keep all other fields in English.

RESPONSE FORMAT (strict JSON, no markdown, no extra text):
{
  "decisions": [
    {
      "symbol": "BTC/USD",
      "action": "BUY" | "SELL" | "HOLD",
      "orderType": "market" | "limit",
      "limitPrice": null | "65000.00",
      "usdAmount": 150.00,
      "takeProfit": "67000.00",
      "stopLoss": "63500.00",
      "confidence": 72,
      "reasoning": "RSI en 28 (sobreventa), cruz alcista MACD, precio tocando Banda de Bollinger inferior. Fuerte confluencia para un rebote. Desplegando 10% del USD disponible.",
      "risks": "High volatility, could wick lower. TP at +3%, SL at -2%."
    }
  ],
  "marketSummary": "Brief overall market assessment in 1-2 sentences."
}

If action is HOLD, set usdAmount to 0, orderType to null, takeProfit to null, and stopLoss to null.
`;

/**
 * @param {Object} context — assembled by executor.js
 * @returns {Object} parsed decision from Claude
 */
export async function analyzeMarket(context) {
  const userMessage = `
Current UTC time: ${new Date().toISOString()}

PORTFOLIO BALANCES:
${JSON.stringify(context.balances, null, 2)}

OPEN ORDERS:
${JSON.stringify(context.openOrders, null, 2)}

MARKET SNAPSHOTS:
${JSON.stringify(context.snapshots, null, 2)}

TECHNICAL INDICATORS:
${JSON.stringify(context.indicators, null, 2)}

PREVIOUS DECISIONS (Recent History):
${context.previousDecisionsBySymbol && Object.keys(context.previousDecisionsBySymbol).length > 0
  ? Object.entries(context.previousDecisionsBySymbol)
      .map(([symbol, decisions]) => 
        `${symbol}:\n${decisions.map((d, i) => 
          `  ${i + 1}. [${d.timestamp}] ${d.action} (confidence: ${d.confidence}%) - ${d.reasoning.substring(0, 80)}...`
        ).join('\n')}`
      ).join('\n\n')
  : 'No previous decisions recorded - this is the first analysis.'}

CONFIG CONSTRAINTS:
- MAX_TRADE_SIZE: ${process.env.MAX_TRADE_SIZE} (fraction of portfolio per trade)
- MIN_ORDER: ${process.env.MIN_ORDER}
- DRY_RUN: ${process.env.DRY_RUN}

Analyze the above and return your JSON decision. Consider the previous decision history:
- Are the conditions improving since the last decision?
- Did your prediction come true (e.g., if you predicted oversold, did price bounce)?
- Adjust your confidence based on pattern consistency.
`;

  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-5',
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = response.content[0].text.trim();

  try {
    return JSON.parse(raw);
  } catch {
    // Claude occasionally wraps in ```json — strip fences as fallback
    const cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(cleaned);
  }
}
