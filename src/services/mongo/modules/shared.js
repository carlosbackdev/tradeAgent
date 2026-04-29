import { logger } from '../../../utils/logger.js';

export { logger };

export function withActiveOrders(filter = {}) {
  if (filter.status === 'cancelled') return filter;

  const activeClause = { status: { $ne: 'cancelled' } };
  if (Object.prototype.hasOwnProperty.call(filter, 'status')) {
    return { $and: [activeClause, filter] };
  }
  return { ...filter, ...activeClause };
}

export function safeParse(val) {
  const p = parseFloat(val);
  return Number.isNaN(p) ? null : p;
}

export function normalizeSymbol(symbol) {
  return String(symbol || '').replace('/', '-').toUpperCase();
}

export function toNullableNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function resolvePositionQty(positionSummary = {}) {
  return Number(
    positionSummary?.totalOpenQty ??
    positionSummary?.totalQty ??
    positionSummary?.qty ??
    0
  );
}

