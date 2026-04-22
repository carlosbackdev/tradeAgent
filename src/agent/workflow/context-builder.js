/**
 * workflow/context-builder.js
 * Builds the analyzer context for Claude with relevant data
 */

import { getTradingPerformance } from '../../services/mongo/mongo-service.js';
import { logger } from '../../utils/logger.js';

export async function buildAnalyzerContext(balances, openOrders, indicators, coin, snapshots, dbConnected = false, chatId = null, priceMap = {}, realAvailableBalances = null) {
  // Build trading stats FIRST using actual physical balances to cap any inconsistencies
  const tradingStats = dbConnected ? await getTradingPerformance(chatId, balances) : null;

  // Extract relevant balances, masking crypto with bot-managed positions (Option B)
  const managedPositions = tradingStats?.openPositions || [];
  const relevantBalances = extractRelevantBalances(balances, indicators, priceMap, managedPositions, realAvailableBalances);

  // Extract open orders array (handle both formats)
  const openOrdersArray = Array.isArray(openOrders?.data)
    ? openOrders.data
    : (Array.isArray(openOrders) ? openOrders : []);

  // Build compact pairs
  const compactPairs = snapshots.map(snapshot => {
    const candlesArray = snapshot.candles?.candles || [];
    const last30Candles = candlesArray.slice(-30);
    
    const changesPercent = last30Candles
      .reduce((arr, candle, idx, all) => {
        if (idx === 0) arr.push(0);
        else {
          const changePct = ((candle.close - all[idx - 1].close) / all[idx - 1].close) * 100;
          arr.push(parseFloat(changePct.toFixed(3)));
        }
        return arr;
      }, []);

    // ── ALL CANDLES: Total change and duration ──
    let allCandlesData = {
      count: candlesArray.length,
      firstVelaTime: null,
      lastVelaTime: null,
      totalChangePct: 0,
      durationRange: '—',
    };

    if (candlesArray.length >= 2) {
      const firstClose = candlesArray[0].close;
      const lastClose = candlesArray[candlesArray.length - 1].close;
      allCandlesData.totalChangePct = parseFloat(((lastClose - firstClose) / firstClose * 100).toFixed(3));
      
      const firstTime = candlesArray[0].timestamp;
      const lastTime = candlesArray[candlesArray.length - 1].timestamp;
      allCandlesData.firstVelaTime = new Date(firstTime).toISOString();
      allCandlesData.lastVelaTime = new Date(lastTime).toISOString();
      
      const durationMinutes = Math.round((lastTime - firstTime) / 1000 / 60);
      if (durationMinutes < 60) {
        allCandlesData.durationRange = `${durationMinutes} min`;
      } else if (durationMinutes < 1440) {
        allCandlesData.durationRange = `${(durationMinutes / 60).toFixed(1)} horas`;
      } else {
        allCandlesData.durationRange = `${(durationMinutes / 1440).toFixed(1)} días`;
      }
    }

    // ── LAST 30 CANDLES: Total change and duration ──
    let last30Data = {
      firstVelaTime: null,
      lastVelaTime: null,
      totalChangePct: 0,
      durationRange: '—',
      changesPercent,
      volatilityATR: null,
      recentVolumes: [],
      avgVolume5: null,
    };

    if (last30Candles.length >= 2) {
      const firstClose = last30Candles[0].close;
      const lastClose = last30Candles[last30Candles.length - 1].close;
      last30Data.totalChangePct = parseFloat(((lastClose - firstClose) / firstClose * 100).toFixed(3));
      
      const firstTime = last30Candles[0].timestamp;
      const lastTime = last30Candles[last30Candles.length - 1].timestamp;
      last30Data.firstVelaTime = new Date(firstTime).toISOString();
      last30Data.lastVelaTime = new Date(lastTime).toISOString();
      
      const durationMinutes = Math.round((lastTime - firstTime) / 1000 / 60);
      if (durationMinutes < 60) {
        last30Data.durationRange = `${durationMinutes} min`;
      } else if (durationMinutes < 1440) {
        last30Data.durationRange = `${(durationMinutes / 60).toFixed(1)} horas`;
      } else {
        last30Data.durationRange = `${(durationMinutes / 1440).toFixed(1)} días`;
      }
      
      // Calculate ATR for volatility
      last30Data.volatilityATR = calculateATR(last30Candles);
      
      // Get volumes from last 5 candles
      const last5Candles = last30Candles.slice(-5);
      last30Data.recentVolumes = last5Candles.map(c => c.volume || 0);
      if (last5Candles.length > 0) {
        const sumVolumes = last30Data.recentVolumes.reduce((a, b) => a + b, 0);
        last30Data.avgVolume5 = parseFloat((sumVolumes / last5Candles.length).toFixed(0));
      }
    }

    return {
      symbol: snapshot.symbol,
      ticker: snapshot.ticker,
      orderBookTop: {
        bestBid: snapshot.orderBook?.bids?.[0] || null,
        bestAsk: snapshot.orderBook?.asks?.[0] || null,
        bidDepth: snapshot.orderBook?.bids?.length || 0,
        askDepth: snapshot.orderBook?.asks?.length || 0,
      },
      recentClosesContext: {
        timeframeMinutes: snapshot.candles?.interval || 5,
        allCandles: allCandlesData,
        last30: last30Data,
      },
      fetchedAt: snapshot.fetchedAt,
    };
  });

  const tradingStatsForClaude = tradingStats ? {
    winRate: tradingStats.winRate,
    winningTrades: tradingStats.winningTrades,
    losingTrades: tradingStats.losingTrades,
    closedTrades: tradingStats.closedTrades,
    accumulatedRendimiento: tradingStats.accumulatedRendimiento,
    openPositions: (tradingStats.openPositions || []).filter(p => p.totalCost >= 1),
  } : null;

  const analyzerContext = {
    balances: relevantBalances,
    openOrders: openOrdersArray,
    pairs: compactPairs,
    indicators,
    previousDecisions: {}, // Placeholder, filled in executor if needed
    lastExecutedOrder: null, // Placeholder, filled in executor if needed
    rendimiento: null, // Placeholder, filled in executor if needed
    tradingStats: tradingStatsForClaude
  };

  return analyzerContext;
}

function calculateATR(candles, period = 14) {
  if (candles.length < period) return null;
  
  const trueRanges = [];
  for (let i = 0; i < candles.length; i++) {
    const current = candles[i];
    const previous = i > 0 ? candles[i - 1] : null;
    
    let tr = current.high - current.low; // H - L
    if (previous) {
      tr = Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      );
    }
    trueRanges.push(tr);
  }
  
  // Calculate SMA of TR for the period
  const relevantTR = trueRanges.slice(-period);
  const atr = relevantTR.reduce((a, b) => a + b, 0) / period;
  return parseFloat(atr.toFixed(4));
}

function extractRelevantBalances(balances, indicators = {}, priceMap = {}, managedPositions = [], realAvailableBalances = null) {
  if (!balances) return {};

  const structured = {
    crypto: {},
    fiat: {},
    summary: {}
  };

  const fiatCurrencies = ['USD', 'EUR', 'GBP'];
  const balanceArray = Array.isArray(balances) ? balances : (balances?.data || []);

  let totalCryptoUSD = 0;
  let totalUSD = 0;
  const availableMap = realAvailableBalances?.availableByCurrency || {};

  for (const b of balanceArray) {
    const total = Number(b.total || 0);

    if (total === 0) continue;

    if (fiatCurrencies.includes(b.currency)) {
      // USD uses real available amount (total minus reserved in open BUY limits)
      const fiatAmount = b.currency === 'USD'
        ? Number(availableMap.USD ?? total)
        : total;
      structured.fiat[b.currency] = fiatAmount;
      if (b.currency === 'USD') totalUSD = fiatAmount;
    } else {
      // Option B masking: only include crypto if the bot manages it
      const managedPos = managedPositions.find(p => p.symbol.startsWith(b.currency + '-'));
      const botQty = managedPos ? managedPos.qty : 0;

      // Sellable qty is capped by real available balance (excludes qty reserved in SELL limit orders)
      const realAvailableQty = Number(availableMap[b.currency] ?? botQty);
      const sellableQty = Math.min(botQty, realAvailableQty);

      if (sellableQty <= 0) continue;

      const pairKey = Object.keys(indicators).find(k => k.startsWith(b.currency + '-'));
      const currentPrice = pairKey ? indicators[pairKey].currentPrice : (priceMap[b.currency] || 0);
      const estimatedUsdValue = currentPrice ? parseFloat((sellableQty * currentPrice).toFixed(2)) : null;

      if (estimatedUsdValue !== null && estimatedUsdValue < 1) continue;

      structured.crypto[b.currency] = {
        amount: sellableQty,
        estimatedUsdValue
      };
      if (estimatedUsdValue) totalCryptoUSD += estimatedUsdValue;
    }
  }

  // Build portfolio summary
  const totalPortfolioUSD = totalUSD + totalCryptoUSD;
  structured.summary = {
    totalUSD: parseFloat(totalUSD.toFixed(2)),
    totalCryptoUSD: parseFloat(totalCryptoUSD.toFixed(2)),
    totalPortfolioUSD: parseFloat(totalPortfolioUSD.toFixed(2)),
    availableForTrading: parseFloat(totalUSD.toFixed(2)),
    cashPercentage: totalPortfolioUSD > 0 ? parseFloat((totalUSD / totalPortfolioUSD * 100).toFixed(2)) : 0,
    cryptoPercentage: totalPortfolioUSD > 0 ? parseFloat((totalCryptoUSD / totalPortfolioUSD * 100).toFixed(2)) : 0
  };
  
  return structured;
}
