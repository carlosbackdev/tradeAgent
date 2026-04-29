/**
 * agent/analyzer service
 */

import { config } from '../../config/config.js';
import { buildEntryRiskFactors, buildEntrySupportFactors } from './entry-factors.js';

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

  const normalizedPositionLifecycle = {};
  const entryRiskFactorsBySymbol = {};

  for (const [sym, lc] of Object.entries(context.positionLifecycle || {})) {
    const qty = Number(lc?.total_qty || 0);
    const estimatedUsdValue = Number(lc?.estimated_usd_value || 0);
    const hasOpenPosition = qty > 0 && estimatedUsdValue > 0;

    normalizedPositionLifecycle[sym] = hasOpenPosition ? {
      ...lc,
      positionRiskFactors: lc.risk_factors || []
    } : {
      ...lc,
      active: false,
      phase: 'NO_POSITION',
      current_roi_pct: 0,
      max_unrealized_roi_pct: 0,
      profit_retracement_pct: 0,
      total_qty: 0,
      avg_entry_price: 0,
      estimated_usd_value: 0,
      risk_factors: [],
      positionRiskFactors: []
    };
  }

  const entrySupportFactorsBySymbol = {};
  for (const sym of Object.keys(normalizedIndicatorsBySymbol)) {
    entryRiskFactorsBySymbol[sym] = buildEntryRiskFactors({
      indicators: normalizedIndicatorsBySymbol[sym],
      crossTfConfluence: context.crossTfConfluence?.[sym]
    });
    entrySupportFactorsBySymbol[sym] = buildEntrySupportFactors({
      indicators: normalizedIndicatorsBySymbol[sym],
      crossTfConfluence: context.crossTfConfluence?.[sym]
    });
  }

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
      rendimiento: context.rendimiento !== undefined ? context.rendimiento : null,
      positionLifecycle: normalizedPositionLifecycle,
      otherOpenPositions: context.otherOpenPositions || [],
      totalManagedOpenPositions: context.totalManagedOpenPositions ?? 0,
      totalManagedCryptoUsd: context.totalManagedCryptoUsd ?? 0,
      highRiskOpenPositionsCount: context.highRiskOpenPositionsCount ?? 0,
      lastSellSummary: context.lastSellSummary || null,
      lastBuySummary: context.lastBuySummary || null,
      tradingStats: context.tradingStats || null,
      recentTradingSummary: context.recentTradingSummary || null,
      currentPrice: context.currentPrice ?? null,
      lastPrice: context.lastPrice ?? null,
      priceChangeSinceLastAnalysisPct: context.priceChangeSinceLastAnalysisPct ?? 0,
      managedPositions: context.tradingStats?.openPositions || [],
      recentOtherSymbolsOpenBuy: context.crossSymbolRecentOpenBuy || null,
      nextAnalysis: 'Next analysis in ' + context.NextAnalysis + ' minutes',
    },
    decisionContext: {
      indicators: normalizedIndicatorsBySymbol,
      higherTimeframe: context.higherTimeframe || null,
      crossTfConfluence: context.crossTfConfluence || null,
      entryRiskFactors: entryRiskFactorsBySymbol,
      entrySupportFactors: entrySupportFactorsBySymbol,
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
      volumeContext: raw.volumeContext || null,
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
