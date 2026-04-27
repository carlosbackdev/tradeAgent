/**
 * workflow/available-balance.js
 * Computes real available balances by discounting funds locked in active open orders.
 */

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toUpperSymbol(symbol) {
  return String(symbol || '').replace('/', '-').toUpperCase();
}

function normalizeSide(side) {
  const s = String(side || '').toLowerCase();
  if (s === 'buyi') return 'buy';
  if (s === 'buy') return 'buy';
  if (s === 'sell') return 'sell';
  return s;
}

function isActiveOrder(order) {
  const status = String(order?.status || order?.state || '').toLowerCase();
  if (!status) return true;
  return ![
    'filled',
    'executed',
    'cancelled',
    'canceled',
    'rejected',
    'failed',
    'expired',
    'closed',
  ].includes(status);
}

function getOrderType(order) {
  const directType = String(order?.type || order?.order_type || order?.orderType || '').toLowerCase();
  if (directType) return directType;
  if (order?.order_configuration?.limit || order?.limit) return 'limit';
  if (order?.order_configuration?.market || order?.market) return 'market';
  return '';
}

function getOrderQty(order) {
  return toNumber(
    order?.base_size
    ?? order?.quantity
    ?? order?.qty
    ?? order?.size
    ?? order?.order_configuration?.limit?.base_size
    ?? order?.limit?.base_size,
    0
  );
}

function getOrderPrice(order) {
  return toNumber(
    order?.price
    ?? order?.limit_price
    ?? order?.order_configuration?.limit?.price
    ?? order?.limit?.price,
    0
  );
}

function getOrderQuoteSize(order) {
  return toNumber(
    order?.quote_size
    ?? order?.order_configuration?.limit?.quote_size
    ?? order?.limit?.quote_size,
    0
  );
}

export function calculateReservedFromOpenLimitOrders(openOrders = []) {
  const ordersArray = Array.isArray(openOrders) ? openOrders : [];

  const reserved = {
    usdInOpenBuyLimits: 0,
    usdBySymbol: {},
    cryptoInOpenSellLimitsByCurrency: {},
    cryptoInOpenSellLimitsBySymbol: {},
  };

  for (const order of ordersArray) {
    if (!isActiveOrder(order)) continue;

    const orderType = getOrderType(order);
    if (!orderType) continue;

    const side = normalizeSide(order?.side);
    const normalizedSymbol = toUpperSymbol(order?.symbol);
    if (!normalizedSymbol.includes('-')) continue;

    const [baseCurrency] = normalizedSymbol.split('-');

    if (side === 'buy') {
      const quoteSize = getOrderQuoteSize(order);
      const qty = getOrderQty(order);
      const price = getOrderPrice(order);
      const reservedUsd = quoteSize > 0 ? quoteSize : (qty > 0 && price > 0 ? qty * price : 0);

      if (reservedUsd > 0) {
        reserved.usdInOpenBuyLimits += reservedUsd;
        reserved.usdBySymbol[normalizedSymbol] = toNumber(reserved.usdBySymbol[normalizedSymbol]) + reservedUsd;
      }
    }

    if (side === 'sell') {
      const qty = getOrderQty(order);
      if (qty > 0) {
        reserved.cryptoInOpenSellLimitsByCurrency[baseCurrency] = toNumber(reserved.cryptoInOpenSellLimitsByCurrency[baseCurrency]) + qty;
        reserved.cryptoInOpenSellLimitsBySymbol[normalizedSymbol] = toNumber(reserved.cryptoInOpenSellLimitsBySymbol[normalizedSymbol]) + qty;
      }
    }
  }

  reserved.usdInOpenBuyLimits = Number(reserved.usdInOpenBuyLimits.toFixed(2));

  for (const symbol of Object.keys(reserved.usdBySymbol)) {
    reserved.usdBySymbol[symbol] = Number(reserved.usdBySymbol[symbol].toFixed(2));
  }

  for (const currency of Object.keys(reserved.cryptoInOpenSellLimitsByCurrency)) {
    reserved.cryptoInOpenSellLimitsByCurrency[currency] = Number(reserved.cryptoInOpenSellLimitsByCurrency[currency].toFixed(8));
  }

  for (const symbol of Object.keys(reserved.cryptoInOpenSellLimitsBySymbol)) {
    reserved.cryptoInOpenSellLimitsBySymbol[symbol] = Number(reserved.cryptoInOpenSellLimitsBySymbol[symbol].toFixed(8));
  }

  return reserved;
}

export function buildRealAvailableBalances(balanceArray = [], openOrders = []) {
  const balances = Array.isArray(balanceArray) ? balanceArray : [];
  const reserved = calculateReservedFromOpenLimitOrders(openOrders);

  const totalsByCurrency = {};
  for (const bal of balances) {
    const currency = String(bal?.currency || '').toUpperCase();
    if (!currency) continue;
    totalsByCurrency[currency] = toNumber(bal?.total, 0);
  }

  const availableByCurrency = {};
  for (const [currency, total] of Object.entries(totalsByCurrency)) {
    if (currency === 'USD') {
      availableByCurrency.USD = Number(Math.max(0, total - reserved.usdInOpenBuyLimits).toFixed(2));
      continue;
    }

    const reservedCrypto = toNumber(reserved.cryptoInOpenSellLimitsByCurrency[currency], 0);
    availableByCurrency[currency] = Number(Math.max(0, total - reservedCrypto).toFixed(8));
  }

  return {
    totalsByCurrency,
    reserved,
    availableByCurrency,
  };
}

export function getAvailableUsdReal(balanceArray = [], openOrders = []) {
  const summary = buildRealAvailableBalances(balanceArray, openOrders);
  return toNumber(summary.availableByCurrency.USD, 0);
}

export function getAvailableCoinReal(balanceArray = [], openOrders = [], symbol = '') {
  const normalized = toUpperSymbol(symbol);
  const baseCurrency = normalized.split('-')[0];
  const summary = buildRealAvailableBalances(balanceArray, openOrders);
  return toNumber(summary.availableByCurrency[baseCurrency], 0);
}
