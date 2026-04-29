import { connectDB } from '../client.js';
import { normalizeSymbol, resolvePositionQty, toNullableNumber } from './shared.js';

export async function getActivePositionLifecycleStates(chatId = null, { excludeSymbol = null, limit = 10 } = {}) {
  const db = await connectDB();
  const lifecycleCollection = db.collection('position_lifecycle');

  const query = { active: true };
  if (chatId) query.chat_id = String(chatId);
  if (excludeSymbol) query.symbol = { $ne: normalizeSymbol(excludeSymbol) };

  return lifecycleCollection
    .find(query)
    .sort({ updated_at: -1 })
    .limit(Math.max(1, Number(limit) || 10))
    .toArray();
}

export async function getPositionLifecycleState(symbol, chatId = null) {
  const db = await connectDB();
  const lifecycleCollection = db.collection('position_lifecycle');
  const normalized = normalizeSymbol(symbol);

  const query = { symbol: normalized };
  if (chatId) query.chat_id = String(chatId);

  const doc = await lifecycleCollection.findOne(query);
  return doc || null;
}

export async function updatePositionLifecycleState({
  symbol,
  chatId = null,
  positionSummary = null,
  currentPrice = null,
  minOrderUsd = 0
}) {
  const db = await connectDB();
  const lifecycleCollection = db.collection('position_lifecycle');
  const normalized = normalizeSymbol(symbol);
  const now = new Date();

  const query = { symbol: normalized };
  if (chatId) query.chat_id = String(chatId);

  const existing = await lifecycleCollection.findOne(query);
  const safeSummary = positionSummary || {};

  const totalQty = resolvePositionQty(safeSummary);
  const avgEntryPrice = toNullableNumber(safeSummary?.avgEntryPrice, 0);
  const currentRoi = toNullableNumber(safeSummary?.unrealizedRoiPct, 0);
  const effectiveCurrentPrice = toNullableNumber(currentPrice, 0);
  const estimatedUsdValue = Number((Math.max(0, totalQty) * Math.max(0, effectiveCurrentPrice)).toFixed(2));
  const isBelowMinOrder = Number(minOrderUsd) > 0 && estimatedUsdValue > 0 && estimatedUsdValue < Number(minOrderUsd);
  const isResidual = isBelowMinOrder || (estimatedUsdValue > 0 && estimatedUsdValue < 15);
  const previousMaxRoi = toNullableNumber(existing?.max_unrealized_roi_pct, currentRoi);
  const maxRoiSeen = Math.max(previousMaxRoi ?? currentRoi, currentRoi);
  const profitRetracementPct = Number((maxRoiSeen - currentRoi).toFixed(4));

  let phase = 'IN_POSITION';
  const active = totalQty > 0;

  if (!active) {
    phase = 'NO_POSITION';
  } else if (isBelowMinOrder) {
    phase = 'RESIDUAL_DUST';
  } else if (maxRoiSeen >= 1.5 && currentRoi <= (maxRoiSeen - 0.8)) {
    phase = 'PROFIT_RETRACEMENT';
  } else if (currentRoi > 0) {
    phase = 'IN_PROFIT';
  } else if (currentRoi < 0) {
    phase = 'IN_DRAWDOWN';
  }

  const mergedRiskFactors = Array.isArray(existing?.risk_factors) ? existing.risk_factors : [];

  const nextState = {
    chat_id: chatId ? String(chatId) : null,
    symbol: normalized,
    active,
    phase,
    current_roi_pct: Number(currentRoi.toFixed(4)),
    max_unrealized_roi_pct: Number(maxRoiSeen.toFixed(4)),
    profit_retracement_pct: Number(profitRetracementPct.toFixed(4)),
    total_qty: Number(totalQty.toFixed(8)),
    avg_entry_price: Number(avgEntryPrice.toFixed(8)),
    current_price: Number(effectiveCurrentPrice.toFixed(8)),
    estimated_usd_value: estimatedUsdValue,
    is_residual: isResidual,
    is_below_min_order: isBelowMinOrder,
    last_action: existing?.last_action || null,
    last_defensive_sell_at: existing?.last_defensive_sell_at || null,
    last_exit_at: existing?.last_exit_at || null,
    cooldown_until: existing?.cooldown_until || null,
    risk_factors: mergedRiskFactors,
    updated_at: now,
  };

  await lifecycleCollection.updateOne(
    query,
    {
      $set: nextState,
      $setOnInsert: { created_at: now },
    },
    { upsert: true }
  );

  return {
    ...nextState,
    created_at: existing?.created_at || now,
  };
}

export async function markLifecycleAfterSell({
  symbol,
  chatId = null,
  actionType = 'SELL',
  cooldownMinutes = 360,
  riskFactors = null,
  phase = null
}) {
  const db = await connectDB();
  const lifecycleCollection = db.collection('position_lifecycle');
  const normalized = normalizeSymbol(symbol);
  const now = new Date();
  const safeCooldownMinutes = Math.max(0, Number(cooldownMinutes) || 0);
  const cooldownUntil = safeCooldownMinutes > 0
    ? new Date(now.getTime() + (safeCooldownMinutes * 60 * 1000))
    : null;

  const query = { symbol: normalized };
  if (chatId) query.chat_id = String(chatId);

  const existing = await lifecycleCollection.findOne(query);
  const isDefensive = String(actionType || '').toUpperCase().includes('DEFENSIVE');
  const updateSet = {
    chat_id: chatId ? String(chatId) : null,
    symbol: normalized,
    last_action: actionType,
    updated_at: now,
    cooldown_until: cooldownUntil,
  };

  if (phase) {
    updateSet.phase = phase;
  }
  if (Array.isArray(riskFactors)) {
    updateSet.risk_factors = riskFactors;
  }
  if (isDefensive) {
    updateSet.last_defensive_sell_at = now;
  } else {
    updateSet.last_exit_at = now;
  }

  await lifecycleCollection.updateOne(
    query,
    {
      $set: updateSet,
      $setOnInsert: { created_at: now },
    },
    { upsert: true }
  );

  return {
    ...existing,
    ...updateSet,
    created_at: existing?.created_at || now,
  };
}

