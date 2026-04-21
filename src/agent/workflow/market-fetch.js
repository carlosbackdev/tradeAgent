/**
 * workflow/market-fetch.js
 * Initializes clients and fetches market data (balances, orders, snapshot)
 */

import { RevolutClient } from '../../revolut/client.js';
import { MarketData } from '../../revolut/market.js';
import { logger } from '../../utils/logger.js';

export async function fetchMarketData(coin, config) {
  if (!coin) throw new Error('No trading pair passed to fetchMarketData');

  logger.info(`📊 Fetching data for: ${coin}`);

  const client = new RevolutClient(config);
  const market = new MarketData(client);

  const [balances, openOrders, snapshot] = await Promise.all([
    market.getBalances(),
    market.getOpenOrders([coin]),
    market.getSnapshot(coin),
  ]).catch(err => {
    throw new Error(`Failed to fetch market data: ${err.message}`);
  });

  const balanceArray = Array.isArray(balances) ? balances : (balances?.data || []);

  // Build a price map for all non-fiat holdings (USD quotes)
  const fiatCurrencies = new Set(['USD', 'EUR', 'GBP']);
  const cryptoHoldings = balanceArray
    .filter(b => !fiatCurrencies.has(b.currency))
    .map(b => String(b.currency || '').trim())
    .filter(Boolean);

  const uniqueCrypto = [...new Set(cryptoHoldings)];
  const priceMap = {};

  await Promise.all(uniqueCrypto.map(async (base) => {
    try {
      const ticker = await market.getTicker(`${base}-USD`);
      if (ticker?.last) priceMap[base] = Number(ticker.last);
    } catch (err) {
      logger.warn(`⚠️ Failed to fetch ticker for ${base}-USD: ${err.message}`);
    }
  }));

  // Ensure openOrders is always an array
  let ordersArray = [];
  if (Array.isArray(openOrders)) {
    ordersArray = openOrders;
  } else if (openOrders?.data && Array.isArray(openOrders.data)) {
    ordersArray = openOrders.data;
  } else if (openOrders?.orders && Array.isArray(openOrders.orders)) {
    ordersArray = openOrders.orders;
  } else {
    logger.warn(`⚠️ Unexpected openOrders format: ${typeof openOrders}. Expected array or object with .data or .orders`);
  }

  const eurBalance = parseFloat(balanceArray.find(b => b.currency === 'EUR')?.total || 0);
  const usdBalance = parseFloat(balanceArray.find(b => b.currency === 'USD')?.total || 0);
  const totalFiat = eurBalance + usdBalance;

  if (totalFiat < config.trading.minOrderUsd) {
    const { notify } = await import('../../telegram/handles.js');
    await notify(`⚠️ Fondos en USD/EUR insuficientes ($${totalFiat.toFixed(2)}) para abrir nuevas posiciones (mínimo $${config.trading.minOrderUsd}). El agente seguirá monitorizando y cerrando ventas si es necesario.`, config.chatId).catch(() => { });
  }

  return {
    client,
    market,
    balances,
    balanceArray,
    openOrders: ordersArray,
    snapshot,
    priceMap,
    eurBalance,
    usdBalance,
    totalFiat,
  };
}
