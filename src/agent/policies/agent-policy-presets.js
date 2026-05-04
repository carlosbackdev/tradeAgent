export const AGENT_POLICY_PRESETS = {
  daily_trader: {
    id: 'daily_trader_30 min',
    name: 'Daily Trader',
    emoji: '⚡',
    description: 'Trading casi diario. Mas reactivo y flexible.',
    horizon: 'Intraday / pocos dias',
    personalityProfile: 'moderate',
    visionProfile: 'short',
    baseInterval: 30,
    higherInterval: 240,
    minHoldMinutesAfterBuy: 240,
    buyConfidenceMin: 48,
    sellConfidenceMin: 43,
    minProfitToSellPct: 0.4,
    minProfitToDefensiveSellPct: 0.25,
    maxNormalSellPct: 70,
    maxDefensiveSellPct: 60,
    defensiveSellRequiresProfit: false,
    allowLossSellOnlyOnHardStop: false,
    minRiskFactorsForDefensiveSell: 2,
    minRiskFactorsForLossSell: 3,
    allowStarterBuy: true,
    allowDca: false,
    profitProtectionMode: 'fast',
    behavior: {
      buy: 'Permite entradas mas rapidas si hay confluencia tecnica suficiente.',
      sell: 'Puede vender parcialmente si el momentum se deteriora.',
      hold: 'Mantiene si la senal no tiene suficiente confianza.'
    }
  },

  swing_balanced: {
    id: 'swing_balanced',
    name: 'Swing Balanced',
    emoji: '📈',
    description: 'Operativa de dias o semanas. Menos ruido, mas confirmacion.',
    horizon: 'Dias / semanas',
    personalityProfile: 'moderate',
    visionProfile: 'medium',
    baseInterval: 240,
    higherInterval: 1440,
    minHoldMinutesAfterBuy: 1440,
    buyConfidenceMin: 55,
    sellConfidenceMin: 52,
    minProfitToSellPct: 1.5,
    minProfitToDefensiveSellPct: 1.0,
    maxNormalSellPct: 45,
    maxDefensiveSellPct: 30,
    defensiveSellRequiresProfit: true,
    allowLossSellOnlyOnHardStop: true,
    minRiskFactorsForDefensiveSell: 3,
    minRiskFactorsForLossSell: 4,
    allowStarterBuy: true,
    allowDca: true,
    profitProtectionMode: 'balanced',
    behavior: {
      buy: 'Busca confirmacion en 4h y 1D antes de aumentar exposicion.',
      sell: 'Prefiere ventas parciales si varios factores se deterioran.',
      hold: 'Mantiene posiciones cuando no hay invalidacion clara.'
    }
  },

  long_accumulation: {
    id: 'long_accumulation',
    name: 'Long Accumulation',
    emoji: '🐢',
    description: 'Acumulacion lenta a largo plazo. Evita ventas impulsivas.',
    horizon: 'Meses / anos',
    personalityProfile: 'conservative',
    visionProfile: 'long',
    baseInterval: 1440,
    higherInterval: null,
    minHoldMinutesAfterBuy: 10080,
    buyConfidenceMin: 68,
    sellConfidenceMin: 65,
    minProfitToSellPct: 4.0,
    minProfitToDefensiveSellPct: 2.5,
    maxNormalSellPct: 25,
    maxDefensiveSellPct: 15,
    defensiveSellRequiresProfit: true,
    allowLossSellOnlyOnHardStop: true,
    minRiskFactorsForDefensiveSell: 4,
    minRiskFactorsForLossSell: 5,
    allowStarterBuy: false,
    allowDca: true,
    profitProtectionMode: 'slow',
    behavior: {
      buy: 'Prefiere acumulacion lenta solo con confirmacion fuerte.',
      sell: 'Evita vender por ruido de corto plazo; solo vende por invalidacion seria.',
      hold: 'HOLD es la accion por defecto si la tesis de largo plazo sigue viva.'
    }
  },

  capital_protection: {
    id: 'capital_protection',
    name: 'Capital Protection',
    emoji: '🛡️',
    description: 'Modo defensivo. Prioriza liquidez y proteccion del capital.',
    horizon: 'Defensivo',
    personalityProfile: 'conservative',
    visionProfile: 'medium',
    baseInterval: 240,
    higherInterval: 1440,
    minHoldMinutesAfterBuy: 2880,
    buyConfidenceMin: 72,
    sellConfidenceMin: 58,
    minProfitToSellPct: 0.75,
    minProfitToDefensiveSellPct: 0.25,
    maxNormalSellPct: 50,
    maxDefensiveSellPct: 35,
    defensiveSellRequiresProfit: false,
    allowLossSellOnlyOnHardStop: false,
    minRiskFactorsForDefensiveSell: 2,
    minRiskFactorsForLossSell: 3,
    allowStarterBuy: false,
    allowDca: false,
    profitProtectionMode: 'defensive',
    behavior: {
      buy: 'Compra solo con senales muy claras.',
      sell: 'Reduce exposicion si el mercado se deteriora.',
      hold: 'Mantiene liquidez si no hay oportunidad clara.'
    }
  },

  short_term_moderate_30m: {
    id: 'short_term_moderate_30m',
    name: 'Short Term Moderate 30m',
    emoji: '⚖️',
    description: 'Trading corto moderado con velas de 30m y confirmacion en 4h. Similar al modo legacy short + moderate.',
    horizon: 'Corto plazo / intradia a pocos dias',
    personalityProfile: 'moderate',
    visionProfile: 'short',
    baseInterval: 30,
    higherInterval: 240,
    minHoldMinutesAfterBuy: 240,
    buyConfidenceMin: 50,
    sellConfidenceMin: 45,
    minProfitToSellPct: 1.0,
    minProfitToDefensiveSellPct: 0.6,
    maxNormalSellPct: 60,
    maxDefensiveSellPct: 40,
    defensiveSellRequiresProfit: true,
    allowLossSellOnlyOnHardStop: true,
    minRiskFactorsForDefensiveSell: 2,
    minRiskFactorsForLossSell: 3,
    allowStarterBuy: true,
    allowDca: false,
    profitProtectionMode: 'moderate_fast',
    behavior: {
      buy: 'Busca entradas de corto plazo con confirmacion suficiente en 30m y sin contradiccion fuerte en 4h.',
      sell: 'Protege beneficios sin vender demasiado pronto; evita ventas pequenas salvo deterioro tecnico claro.',
      hold: 'Mantiene si la tesis sigue valida y la estructura de 30m/4h no se ha deteriorado claramente.'
    }
  },

  scalp_15m_aggressive: {
    id: 'scalp_15m_aggressive',
    name: 'Scalp 15m Aggressive',
    emoji: '🔥',
    description: 'Trading muy agresivo para cron de 15m. Busca entradas rapidas y salidas parciales frecuentes.',
    horizon: 'Minutos / intradia rapido',
    personalityProfile: 'aggressive',
    visionProfile: 'short',
    baseInterval: 15,
    higherInterval: 60,
    minHoldMinutesAfterBuy: 60,
    buyConfidenceMin: 46,
    sellConfidenceMin: 40,
    minProfitToSellPct: 0.25,
    minProfitToDefensiveSellPct: 0.15,
    maxNormalSellPct: 80,
    maxDefensiveSellPct: 65,
    defensiveSellRequiresProfit: false,
    allowLossSellOnlyOnHardStop: false,
    minRiskFactorsForDefensiveSell: 2,
    minRiskFactorsForLossSell: 3,
    allowStarterBuy: true,
    allowDca: false,
    profitProtectionMode: 'very_fast',
    behavior: {
      buy: 'Permite entradas rapidas con confirmacion tecnica de corto plazo y ejecucion favorable.',
      sell: 'Puede tomar beneficios pequenos y recortar rapido si el momentum se deteriora.',
      hold: 'Mantiene poco tiempo si la senal pierde fuerza o el mercado se queda sin continuidad.'
    }
  },

  hourly_aggressive: {
    id: 'hourly_aggressive',
    name: 'Hourly Aggressive',
    emoji: '⚡',
    description: 'Trading agresivo para cron de 1h. Busca operaciones intradia con algo mas de confirmacion.',
    horizon: 'Intradia / 1-2 dias',
    personalityProfile: 'aggressive',
    visionProfile: 'short',
    baseInterval: 60,
    higherInterval: 240,
    minHoldMinutesAfterBuy: 180,
    buyConfidenceMin: 50,
    sellConfidenceMin: 44,
    minProfitToSellPct: 0.6,
    minProfitToDefensiveSellPct: 0.35,
    maxNormalSellPct: 70,
    maxDefensiveSellPct: 55,
    defensiveSellRequiresProfit: false,
    allowLossSellOnlyOnHardStop: false,
    minRiskFactorsForDefensiveSell: 2,
    minRiskFactorsForLossSell: 3,
    allowStarterBuy: true,
    allowDca: false,
    profitProtectionMode: 'fast',
    behavior: {
      buy: 'Busca entradas agresivas cuando 1h mejora y 4h no contradice con fuerza.',
      sell: 'Protege beneficios pronto si el impulso intradia se debilita.',
      hold: 'Mantiene si la estructura de 1h sigue sana y 4h no muestra invalidacion clara.'
    }
  },

  daily_weekly_aggressive: {
    id: 'daily_weekly_aggressive',
    name: 'Daily Weekly Aggressive',
    emoji: '🚀',
    description: 'Trading diario-semanal agresivo. Busca movimientos de varios dias con objetivo aproximado de 3-5%.',
    horizon: 'Dias / hasta 1 semana',
    personalityProfile: 'aggressive',
    visionProfile: 'medium',
    baseInterval: 120,
    higherInterval: 240,
    minHoldMinutesAfterBuy: 360,
    buyConfidenceMin: 54,
    sellConfidenceMin: 48,
    minProfitToSellPct: 2.0,
    minProfitToDefensiveSellPct: 1.0,
    maxNormalSellPct: 60,
    maxDefensiveSellPct: 40,
    defensiveSellRequiresProfit: true,
    allowLossSellOnlyOnHardStop: true,
    minRiskFactorsForDefensiveSell: 3,
    minRiskFactorsForLossSell: 4,
    allowStarterBuy: true,
    allowDca: true,
    profitProtectionMode: 'target_3_5_fast',
    behavior: {
      buy: 'Busca entradas agresivas con confirmacion en 1h/2h y apoyo suficiente en 4h.',
      sell: 'Intenta capturar movimientos de 3-5%, evitando vender demasiado pronto salvo deterioro claro.',
      hold: 'Mantiene mientras la estructura de corto-medio plazo siga valida y el objetivo 3-5% siga siendo razonable.'
    }
  },

  daily_weekly_balanced_3_5: {
    id: 'daily_weekly_balanced_3_5',
    name: 'Daily Weekly 3-5%',
    emoji: '📊',
    description: 'Trading diario-semanal equilibrado. Busca operaciones con objetivo aproximado de 3-5%.',
    horizon: 'Dias / semanas cortas',
    personalityProfile: 'moderate',
    visionProfile: 'medium',
    baseInterval: 240,
    higherInterval: 1440,
    minHoldMinutesAfterBuy: 720,
    buyConfidenceMin: 58,
    sellConfidenceMin: 54,
    minProfitToSellPct: 3.0,
    minProfitToDefensiveSellPct: 1.5,
    maxNormalSellPct: 50,
    maxDefensiveSellPct: 30,
    defensiveSellRequiresProfit: true,
    allowLossSellOnlyOnHardStop: true,
    minRiskFactorsForDefensiveSell: 3,
    minRiskFactorsForLossSell: 4,
    allowStarterBuy: true,
    allowDca: true,
    profitProtectionMode: 'target_3_5_balanced',
    behavior: {
      buy: 'Busca entradas con buena confirmacion en 4h y apoyo del timeframe diario.',
      sell: 'Evita ventas pequenas; prioriza capturar movimientos cercanos al 3-5% o proteger beneficio si hay deterioro real.',
      hold: 'Mantiene posiciones mientras el setup siga valido aunque haya ruido intradia.'
    }
  },
};


export function getAgentPolicyPreset(policyId) {
  if (!policyId) return null;
  return AGENT_POLICY_PRESETS[policyId] || null;
}

export function hasActiveAgentPolicy(tradingConfig = {}) {
  return Boolean(getAgentPolicyPreset(tradingConfig.agentPolicyPreset));
}

export function resolveAgentPolicy(tradingConfig = {}) {
  return getAgentPolicyPreset(tradingConfig.agentPolicyPreset);
}

export function buildStrategyPolicyContext(tradingConfig = {}) {
  const policy = resolveAgentPolicy(tradingConfig);
  if (!policy) return null;

  return {
    id: policy.id,
    name: policy.name,
    emoji: policy.emoji,
    description: policy.description,
    horizon: policy.horizon,
    baseInterval: policy.baseInterval,
    higherInterval: policy.higherInterval,
    buyConfidenceMin: policy.buyConfidenceMin,
    sellConfidenceMin: policy.sellConfidenceMin,
    minHoldMinutesAfterBuy: policy.minHoldMinutesAfterBuy,
    minProfitToSellPct: policy.minProfitToSellPct,
    minProfitToDefensiveSellPct: policy.minProfitToDefensiveSellPct,
    maxNormalSellPct: policy.maxNormalSellPct,
    maxDefensiveSellPct: policy.maxDefensiveSellPct,
    defensiveSellRequiresProfit: policy.defensiveSellRequiresProfit,
    allowLossSellOnlyOnHardStop: policy.allowLossSellOnlyOnHardStop,
    minRiskFactorsForDefensiveSell: policy.minRiskFactorsForDefensiveSell,
    minRiskFactorsForLossSell: policy.minRiskFactorsForLossSell,
    profitProtectionMode: policy.profitProtectionMode,
    allowStarterBuy: policy.allowStarterBuy,
    allowDca: policy.allowDca,
    behavior: policy.behavior
  };
}

export function buildStrategyPolicyPromptContext(tradingConfig = {}) {
  const policy = resolveAgentPolicy(tradingConfig);
  if (!policy) return null;

  return {
    id: policy.id,
    name: policy.name,
    horizon: policy.horizon,
    timeframes: {
      base: `${policy.baseInterval}m`,
      higher: policy.higherInterval ? `${policy.higherInterval}m` : null
    },
    confidence: {
      buyMin: Number(policy.buyConfidenceMin),
      sellMin: Number(policy.sellConfidenceMin)
    },
    holding: {
      minHoldAfterBuyMinutes: Number(policy.minHoldMinutesAfterBuy)
    },
    sellRules: {
      minProfitNormalPct: Number(policy.minProfitToSellPct),
      minProfitDefensivePct: Number(policy.minProfitToDefensiveSellPct),
      maxNormalSellPct: Number(policy.maxNormalSellPct),
      maxDefensiveSellPct: Number(policy.maxDefensiveSellPct)
    },
    exposure: {
      allowStarterBuy: Boolean(policy.allowStarterBuy),
      allowDca: Boolean(policy.allowDca)
    },
    profitProtectionMode: policy.profitProtectionMode,
    behavior: {
      buy: policy.behavior?.buy || '',
      sell: policy.behavior?.sell || '',
      hold: policy.behavior?.hold || ''
    }
  };
}
