/**
 * workflow/sizing/order-sizing.js
 * Centralized order sizing policy for BUY/SELL execution quantities.
 */

import { getAvailableUsdReal, getAvailableCoinReal } from '../available-balance.js';

const DEFAULT_SELL_SIZE_BUFFER = 0.999;
const BASE_SIZE_DECIMALS = 8;

export function normalizePositionPct(rawValue) {
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= 1) return n * 100;
  return n;
}

export function roundBaseSizeDown(value, decimals = BASE_SIZE_DECIMALS) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const factor = 10 ** Number(decimals);
  return Math.floor(n * factor) / factor;
}

export function applySellSafetyBuffer(baseAmount, sellSizeBuffer = DEFAULT_SELL_SIZE_BUFFER) {
  const amount = Number(baseAmount);
  const buffer = Number(sellSizeBuffer);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (!Number.isFinite(buffer) || buffer <= 0 || buffer >= 1) return amount;
  return amount * buffer;
}

export function estimateUsdValue(baseAmount, price) {
  const base = Number(baseAmount);
  const p = Number(price);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(p) || p <= 0) return 0;
  return Number((base * p).toFixed(2));
}

export function buildBuySizeFromUsd({
  usdBalance,
  positionPct,
  maxTradeSizePct
}) {
  const maxPct = normalizePositionPct(maxTradeSizePct || 0);
  const requestedPct = normalizePositionPct(positionPct);
  const effectivePositionPct = requestedPct > 0 ? clamp(requestedPct, 0, maxPct) : 0;
  const positionPctDecimal = effectivePositionPct / 100;
  const balance = Number(usdBalance || 0);

  return {
    effectivePositionPct,
    positionPctDecimal,
    usdAmount: Number((Math.max(0, balance) * positionPctDecimal).toFixed(2))
  };
}

export function buildSellSizeFromPositionPct({
  sellableCrypto,
  positionPct,
  currentPrice,
  sellSizeBuffer = DEFAULT_SELL_SIZE_BUFFER
}) {
  const requestedPct = normalizePositionPct(positionPct);
  const effectivePositionPct = requestedPct > 0 ? clamp(requestedPct, 0, 100) : 0;
  const positionPctDecimal = effectivePositionPct / 100;
  const sellable = Number(sellableCrypto || 0);

  const rawQtyToSell = Math.max(0, sellable) * positionPctDecimal;
  const qtyWithBuffer = applySellSafetyBuffer(rawQtyToSell, sellSizeBuffer);
  const baseAmount = roundBaseSizeDown(qtyWithBuffer, BASE_SIZE_DECIMALS);
  const usdEstimate = estimateUsdValue(baseAmount, currentPrice);

  return {
    effectivePositionPct,
    positionPctDecimal,
    baseAmount,
    usdAmount: usdEstimate
  };
}

export function buildExecutableOrderSize({
  decision,
  balanceArray,
  openOrders,
  realAvailableBalances,
  indicators,
  managedPositions = [],
  maxTradeSizePct = 25,
  sellSizeBuffer = DEFAULT_SELL_SIZE_BUFFER
}) {
  const action = String(decision?.action || 'HOLD').toUpperCase();
  const normalizedSymbol = String(decision?.symbol || '').replace('/', '-').toUpperCase();
  const baseCurrency = normalizedSymbol.split('-')[0];

  const rawPositionPct = normalizePositionPct(decision?.positionPct ?? 0);
  if (rawPositionPct > 0) {
    if (action === 'BUY') {
      const usdBalance = Number(
        realAvailableBalances?.availableByCurrency?.USD ??
        getAvailableUsdReal(balanceArray, openOrders)
      );

      const buySize = buildBuySizeFromUsd({
        usdBalance,
        positionPct: rawPositionPct,
        maxTradeSizePct
      });

      return {
        ...buySize,
        action,
        baseAmount: null,
        usdAvailable: usdBalance,
        sellableCrypto: null,
        currentPrice: Number(indicators?.[normalizedSymbol]?.currentPrice || 0),
        baseCurrency
      };
    }

    if (action === 'SELL') {
      const currentPrice = Number(indicators?.[normalizedSymbol]?.currentPrice || 0);
      if (currentPrice <= 0) {
        throw new Error(`No current price for ${decision?.symbol}`);
      }

      const managedPos = managedPositions.find((p) => String(p?.symbol || '').startsWith(baseCurrency + '-'));
      const coinManagedBalance = Number(managedPos?.qty || 0);
      const coinAvailableReal = Number(
        realAvailableBalances?.availableByCurrency?.[baseCurrency] ??
        getAvailableCoinReal(balanceArray, openOrders, normalizedSymbol)
      );

      const sellableCrypto = Math.min(coinManagedBalance, coinAvailableReal);
      const sellSize = buildSellSizeFromPositionPct({
        sellableCrypto,
        positionPct: rawPositionPct,
        currentPrice,
        sellSizeBuffer
      });

      return {
        ...sellSize,
        action,
        coinAvailableReal,
        sellableCrypto,
        currentPrice,
        baseCurrency
      };
    }
  }

  const legacyUsdAmount = parseFloat(decision?.usdAmount);
  if (action === 'SELL' && (!Number.isFinite(legacyUsdAmount) || legacyUsdAmount <= 0)) {
    const currentPrice = Number(indicators?.[normalizedSymbol]?.currentPrice || 0);
    if (currentPrice <= 0) {
      throw new Error(`No current price for ${decision?.symbol}`);
    }

    const managedPos = managedPositions.find((p) => String(p?.symbol || '').startsWith(baseCurrency + '-'));
    const coinManagedBalance = Number(managedPos?.qty || 0);
    const coinAvailableReal = Number(
      realAvailableBalances?.availableByCurrency?.[baseCurrency] ??
      getAvailableCoinReal(balanceArray, openOrders, normalizedSymbol)
    );
    const sellableCrypto = Math.min(coinManagedBalance, coinAvailableReal);
    const baseAmount = roundBaseSizeDown(
      applySellSafetyBuffer(sellableCrypto, sellSizeBuffer),
      BASE_SIZE_DECIMALS
    );

    return {
      action,
      effectivePositionPct: 100,
      positionPctDecimal: 1,
      usdAmount: estimateUsdValue(baseAmount, currentPrice),
      baseAmount,
      coinAvailableReal,
      sellableCrypto,
      currentPrice,
      baseCurrency
    };
  }

  return {
    action,
    effectivePositionPct: rawPositionPct,
    positionPctDecimal: rawPositionPct > 0 ? rawPositionPct / 100 : 0,
    usdAmount: Number.isFinite(legacyUsdAmount) ? Number(legacyUsdAmount.toFixed(2)) : 0,
    baseAmount: Number.isFinite(Number(decision?.baseAmount)) ? roundBaseSizeDown(decision.baseAmount, BASE_SIZE_DECIMALS) : null,
    sellableCrypto: null,
    currentPrice: Number(indicators?.[normalizedSymbol]?.currentPrice || 0),
    baseCurrency
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
