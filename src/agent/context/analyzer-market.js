/**
 * agent/analyzer service
 */

import { config } from '../../config/config.js';

export function buildAnalyzerMessage(context, question = '', tradingConfig = null, coin = null) {
  const activeTradingConfig = tradingConfig || config.trading;
  const usableBalances = JSON.parse(JSON.stringify(context.balances || {}));

  const openOrders = Array.isArray(context.openOrders) ? context.openOrders : [];
  const marketData = context.pairs || [];
  const normalizedIndicatorsBySymbol = normalizeIndicatorsBySymbol(context.indicators || {});
  const regimeSummaryBySymbol = buildRegimeSummaryBySymbol(marketData);
  const atrBySymbol = buildAtrBySymbol(marketData);
  const marketBySymbol = buildMarketBySymbol(marketData);
  const recentMarketContextBySymbol = buildRecentMarketContextBySymbol(marketData);

  const analysisData = {
    timestamp: new Date().toISOString(),
    symbol: coin,
    exchangeTruth: {
      balances: usableBalances,
      openOrders,
      marketBySymbol,
    },
    botState: {
      openLots: context.openLots || [],
      recentSells: context.recentSells || [],
      lastExecutedOrder: context.lastExecutedOrder || null,
      rendimiento: context.rendimiento !== undefined ? context.rendimiento : null,
      tradingStats: context.tradingStats || null,
      currentPrice: context.currentPrice ?? null,
      lastPrice: context.lastPrice ?? null,
      priceChangeSinceLastAnalysisPct: context.priceChangeSinceLastAnalysisPct ?? 0,
      managedPositions: context.tradingStats?.openPositions || [],
      crossSymbolRecentOpenBuy: context.crossSymbolRecentOpenBuy || null,
      nextAnalysis: 'Next analysis in ' + context.NextAnalysis + ' minutes',
    },
    decisionContext: {
      indicators: normalizedIndicatorsBySymbol,
      higherTimeframe: context.higherTimeframe || null,
      regimeSummary: regimeSummaryBySymbol,
      atrContext: atrBySymbol,
      recentMarketContext: recentMarketContextBySymbol,
      previousDecisions: context.previousDecisions || {},
      priceChangeSinceLastAnalysisPct: context.priceChangeSinceLastAnalysisPct ?? 0,
      currentPrice: context.currentPrice ?? null,
      lastPrice: context.lastPrice ?? null,
    },
  };

  if (question != '') {
    analysisData.question = 'User extra question: ' + question;
  }

  return JSON.stringify(analysisData, null, 2);
}

function normalizeIndicatorsBySymbol(indicators) {
  const normalized = {};

  for (const [symbol, raw] of Object.entries(indicators || {})) {
    normalized[symbol] = {
      currentPrice: toNumber(raw.currentPrice, 0),
      rsi14: toNumber(raw.rsi14),
      sma20: toNumber(raw.sma20),
      ema12: toNumber(raw.ema12),
      ema26: toNumber(raw.ema26),
      macd: {
        line: toNumber(raw.macdLine),
        signal: toNumber(raw.macdSignal),
        histogram: toNumber(raw.macdHistogram),
      },
      bollinger: {
        upper: toNumber(raw.bbUpper),
        middle: toNumber(raw.bbMiddle ?? raw.bbMid),
        lower: toNumber(raw.bbLower),
        widthPct: parsePercent(raw.bbWidth),
        positionPct: parsePercent(raw.bbPosition),
      },
      confluence: raw.confluence || null,
      signals: Array.isArray(raw.signals) ? raw.signals : [],
      aliases: {
        macdLine: raw.macdLine,
        macdSignal: raw.macdSignal,
        macdHistogram: raw.macdHistogram,
        bbUpper: raw.bbUpper,
        bbMiddle: raw.bbMiddle,
        bbLower: raw.bbLower,
      },
    };
  }

  return normalized;
}

function buildRegimeSummaryBySymbol(marketData) {
  const out = {};
  for (const pair of marketData || []) {
    const symbol = String(pair.symbol || '').replace('/', '-');
    out[symbol] = pair.regimeSummary || null;
  }
  return out;
}

function buildAtrBySymbol(marketData) {
  const out = {};
  for (const pair of marketData || []) {
    const symbol = String(pair.symbol || '').replace('/', '-');
    out[symbol] = pair.atr || null;
  }
  return out;
}

function buildMarketBySymbol(marketData) {
  const out = {};
  for (const pair of marketData || []) {
    const symbol = String(pair.symbol || '').replace('/', '-');
    out[symbol] = {
      ticker: pair.ticker || null,
      currentPrice: toNumber(pair.ticker?.last),
      orderBookTop: pair.orderBookTop || null,
      fetchedAt: pair.fetchedAt || null,
    };
  }
  return out;
}

function buildRecentMarketContextBySymbol(marketData) {
  const out = {};
  for (const pair of marketData || []) {
    const symbol = String(pair.symbol || '').replace('/', '-');
    out[symbol] = {
      timeframeMinutes: pair.recentClosesContext?.timeframeMinutes || null,
      allCandles: pair.recentClosesContext?.allCandles || null,
      last30: pair.recentClosesContext?.last30 || null,
      atr: pair.atr || null,
      regimeSummary: pair.regimeSummary || null,
    };
  }
  return out;
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parsePercent(value) {
  if (value === null || value === undefined) return null;
  const clean = String(value).replace('%', '');
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}