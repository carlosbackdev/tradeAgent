/**
 * utils/formatter.js
 * Format decision results and execution info for Telegram notifications with premium aesthetics.
 */

import { isFallbackChainEnabled, getFallbackChain } from '../agent/services/fallback-chain.js';

const TOTAL_STEPS = 5;

export function formatDecision({ decision, execResults, elapsed, triggerReason }) {
  let msg = `╔════════════════════════╗\n`;
  msg += `      📊 <b>TRADING REPORT</b>\n`;
  msg += `╚════════════════════════╝\n`;
  msg += `⏱️ <b>Duración:</b> ${elapsed}s | 🎯 <b>Trigger:</b> ${triggerReason.toUpperCase()}\n`;
  if (decision.usedModel) {
    msg += `🧠 <b>Modelo:</b> <code>${escapeHTML(decision.usedModel)}</code>\n`;
  }
  msg += `\n`;

  msg += `🌍 <b>RESUMEN DEL MERCADO</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `<code>${escapeHTML(decision.marketSummary)}</code>\n\n`;

  msg += `⚡ <b>DECISIONES</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;

  if (execResults.length === 0) {
    msg += `<i>No se ejecutaron operaciones en este ciclo.</i>\n`;
  } else {
    for (const result of execResults) {
      const emoji = result.action === 'BUY' ? '🟢' : result.action === 'SELL' ? '🔴' : '⚪';
      msg += `${emoji} <b>${result.symbol}</b>\n`;
      msg += `  • <b>Acción:</b> ${result.action.toUpperCase()}\n`;
      msg += `  • <b>Confianza:</b> ${result.confidence}%\n`;

      if (result.status === 'executed' && result.usdAmount) {
        msg += `  • <b>Monto:</b> $${Number(result.usdAmount).toFixed(2)}\n`;
      } else if (result.positionPct > 0) {
        msg += `  • <b>Tamaño:</b> ${(result.positionPct * 100).toFixed(0)}% del balance\n`;
      }

      if (result.rendimiento != null) {
        const sign = result.rendimiento >= 0 ? '+' : '';
        msg += `  📈 <b>Rendimiento:</b> ${sign}${result.rendimiento.toFixed(2)}%\n`;
      }

      if (result.status === 'executed') {
        const qtyDisplay = result.orderResult?.qty || result.qty || 'pte.';
        msg += `  ✅ <b>Estado:</b> EJECUTADO (${qtyDisplay})\n`;
      } else if (result.status === 'skipped') {
        msg += `  ⏭️ <b>Estado:</b> SKIPPED (${escapeHTML(result.reason)})\n`;
      } else if (result.status === 'error') {
        msg += `  ❌ <b>Estado:</b> ERROR (${escapeHTML(result.error)})\n`;
      }

      msg += `\n💡 <b>RAZONAMIENTO</b>\n`;
      msg += `<pre>${escapeHTML(result.reasoning)}</pre>\n`;
      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    }
  }

  return msg;
}

export function formatOpenOrdersMessage({ symbol, results }) {
  let msg = `╔════════════════════════╗\n`;
  msg += `      📋 <b>OPEN ORDERS</b>\n`;
  msg += `╚════════════════════════╝\n`;
  msg += `Símbolo: <b>${escapeHTML(symbol)}</b>\n\n`;

  if (results.cancelledOrders?.length > 0) {
    for (const order of results.cancelledOrders) {
      msg += `🔴 <b>CANCELACIÓN</b> (ID: ${escapeHTML(String(order.id || '').slice(0, 8))}...)\n`;
      msg += `  • <b>Confianza:</b> ${order.confidence}%\n`;
      msg += `  • <b>Motivo:</b> <code>${escapeHTML(order.reason)}</code>\n\n`;
    }
  }

  if (results.keptOrders?.length > 0) {
    for (const order of results.keptOrders) {
      msg += `🟡 <b>MANTENER</b> (ID: ${escapeHTML(String(order.id || '').slice(0, 8))}...)\n`;
      msg += `  • <b>Confianza:</b> ${order.confidence}%\n`;
      msg += `  • <b>Motivo:</b> <code>${escapeHTML(order.reason)}</code>\n\n`;
    }
  } else if ((results.kept || 0) > 0) {
    msg += `⏳ Manteniendo <b>${results.kept}</b> orden(es) abierta(s) sin cambios.\n\n`;
  }

  if (results.buyMoreOrders?.length > 0) {
    for (const order of results.buyMoreOrders) {
      msg += `🟢 <b>COMPRA ADICIONAL</b> (Cant: ${order.quantity})\n`;
      msg += `  • ID: ${escapeHTML(String(order.id || '').slice(0, 8))}...\n`;
      msg += `  • <b>Motivo:</b> <code>${escapeHTML(order.reason)}</code>\n\n`;
    }
  }

  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `✅ <b>Procesadas:</b> ${results.cancelled || 0} canceladas, ${results.buy_more_count || 0} compras adicionales, ${results.kept || 0} mantenidas`;

  return msg;
}

export function formatInitMessage({ userConfig, username, cronStatus, mode, pairs }) {
  const display = username ? ' <b>@' + escapeHTML(username) + '</b>' : '';
  const cronDesc = cronStatus.enabled ? `✅ <code>${CronParse(cronStatus.schedule)}</code>` : '⏸️ <i>desactivado</i>';
  const pairsList = Array.isArray(pairs) && pairs.length > 0 ? pairs.join(', ') : '<i>no configurados</i>';

  let msg = `═══ 🤖 <b>REVOLUT X AGENT</b> ═══\n\n`;
  msg += `¡Hola${display}! Bienvenido a tu centro de mando.\n\n`;
  msg += `<i>Analizo el mercado, gestiono tu cartera y ejecuto operaciones automáticas con precisión quirúrgica.</i>\n\n`;

  msg += `⚙️ <b>SISTEMA</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `⏰ <b>Cronómetro de Ciclos:</b> ${cronDesc}\n`;
  msg += `💰 <b>Modo:</b> ${mode}\n`;
  msg += `📈 <b>Seguimiento:</b> <code>${pairsList}</code>\n\n`;

  if (isFallbackChainEnabled(userConfig)) {
    const chain = getFallbackChain(userConfig);
    const models = chain.map(c => c.model).join(' → ');
    msg += `🔗 <b>Fallback Chain:</b> ✅ ACTIVO\n`;
    msg += `🧠 <b>Cascada:</b> <code>${models}</code>\n\n`;
  } else {
    msg += `🤖 <b>Proveedor AI:</b> ${userConfig.llm.provider}\n`;
    msg += `🧠 <b>Modelo AI:</b> ${userConfig.llm.model}\n\n`;
  }

  msg += `✅ <i>Gestiona tu agente mediante el menú:</i>`;
  return msg;
}

export function formatStatsMessage({ stats, performance, invested, openPositions, manualPositions = [] }) {
  let msg = `═══ 📊 <b>ESTADÍSTICAS AGENTE</b> ═══\n\n`;

  msg += `📈 <b>ACTIVIDAD</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🤔 <b>Decisiones:</b> ${stats.totalDecisions}\n`;
  msg += `📦 <b>Órdenes:</b> ${stats.totalOrders} (🛒 ${stats.totalBuys} | 🤝 ${stats.totalSells})\n`;
  msg += `⚙️ <b>Eficiencia:</b> ${stats.executionRatio}%\n\n`;

  msg += `💰 <b>RENDIMIENTO REALIZADO</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💵 <b>PnL:</b> ${performance.pnlUsd} USD\n`;
  msg += `📈 <b>ROI:</b> ${performance.roi}% \n`;
  msg += `💹 <b>Inversión:</b> $${invested}\n`;
  msg += `⚪ <b>Rendimiento:</b> ${performance.totalRendimiento}%\n\n`;

  msg += `🏆 <b>RÉCORD</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `✅ <b>Ganancia:</b> ${stats.winningTrades} | ❌ <b>Pérdida:</b> ${stats.losingTrades}\n`;
  msg += `📊 <b>Cerradas:</b> ${stats.closedTrades} | 🎯 <b>Win Rate:</b> ${stats.winRate}\n\n`;

  msg += `📂 <b>POSICIONES (GESTIONADAS)</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  if (!openPositions || openPositions.length === 0) {
    msg += `<i>No hay posiciones abiertas por el agente en este momento.</i>\n`;
  } else {
    for (const pos of openPositions) {
      msg += `  • <b>${pos.symbol}:</b> ${pos.qty} @ $${pos.price} (coste $${pos.cost})\n`;
    }
  }

  if (manualPositions && manualPositions.length > 0) {
    msg += `\n💼 <b>BILLETERA MANUAL (Reservada)</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    for (const pos of manualPositions) {
      msg += `  • <b>${pos.symbol}:</b> ${pos.qty} (No gestionadas por el bot)\n`;
    }
  }

  return msg;
}

export function formatAskMessage() {
  let msg = `═══ 💬 <b>ASISTENTE IA</b> ═══\n\n`;
  msg += `<i>Selecciona un activo para iniciar una consulta. El agente analizará el contexto real del mercado y responderá a tu pregunta personalizada.</i>\n\n`;
  msg += `👇 <b>¿Sobre qué activo quieres preguntar?</b>`;
  return msg;
}

export function formatConfigMessage(params) {
  let msg = `═══ 🤖 <b>CONFIGURACIÓN AGENTE</b> ═══\n\n`;

  params.forEach((p, i) => {
    if (p.key === "MAX_TRADE_SIZE") {
      msg += `${i + 1}. <b>${p.key}</b>\n   └ <code>${p.value > 1 ? p.value + '%' : p.value * 100 + '%'}</code>\n`;
    } else if (p.key === "TAKE_PROFIT_PCT" || p.key === "STOP_LOSS_PCT") {
      msg += `${i + 1}. <b>${p.key}</b>\n   └ <code>${p.value + '%'}</code>\n`;
    } else if (p.key === "INDICATORS_CANDLES_INTERVAL") {
      msg += `${i + 1}. <b>${p.key}</b>\n   └ <code>${p.value + 'min'}</code>\n`;
    } else {
      msg += `${i + 1}. <b>${p.key}</b>\n   └ <code>${p.value}</code>\n`;
    }
  });

  msg += `\n✍️ <b>MODIFICAR PARÁMETRO</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `<i>Envía: [Número] → [Valor]</i>\n`;
  msg += `Ejemplo: <code>8 → 30</code>\n\n`;
  msg += `<i>Nota: Se recogerá el primer valor detectado y se guardará automáticamente en tu perfil.</i>`;
  return msg;
}

export function formatPromptMessage(key) {
  return `✏️ <b>Escribe el nuevo valor para ${key}:</b>\n\n<i>Se recogerá el primer valor escrito y se guardará automáticamente.</i>`;
}

export function formatStartMessage() {
  let msg = `═══ 📊 <b>TRADING PANEL</b> ═══\n\n`;
  msg += `✅ <b>ANÁLISIS MANUAL</b>\n`;
  msg += `<i>Selecciona un activo para un ciclo de análisis inmediato. El agente evaluará el contexto y tomará la decisión óptima.</i>\n\n`;
  msg += `⏰ <b>AUTOMATIZACIÓN</b>\n`;
  msg += `<i>Usa el botón <b>CRON</b> para programar ciclos periódicos en toda tu lista de seguimiento.</i>\n\n`;
  msg += `👇 <b>SELECCIONA UNA CRIPTO</b>`;
  return msg;
}

export function formatHelpMessage(isAdmin) {
  let msg = `═══ ❓ <b>GUÍA DE COMANDOS</b> ═══\n\n`;

  msg += `⚡ <b>ANÁLISIS MANUAL</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `/btc · /eth · /sol · /vvv · /xrp\n`;
  msg += `<i>Análisis y ejecución inmediata.</i>\n\n`;

  msg += `⏰ <b>CRON AUTOMÁTICO</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `• /cron — Panel de control cron\n`;
  msg += `• /cron_on — Activar ciclos\n`;
  msg += `• /cron_off — Desactivar ciclos\n`;

  msg += `ℹ️ <b>INFORMACIÓN</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `• /start — Abrir el panel de trading\n`;
  msg += `• /status — Ver configuración del agente\n`;
  msg += `• /configuration — Configurar claves API\n`;
  msg += `• /stats — Ver rendimiento y posiciones\n`;
  msg += `• /help — Mostrar esta guía\n`;

  if (isAdmin) {
    msg += `\n👑 <b>ADMINISTRACIÓN</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `• /admin — Panel de control global\n`;
    msg += `• /users — Lista de usuarios registrados\n`;
    msg += `• /invite — Invitar nuevo usuario\n`;
    msg += `• /revoke — Suspender acceso de un usuario\n`;
    msg += `• /admin_status — Estado del servidor\n`;
  }

  return msg;
}

export function formatAgentStatusMessage({ uConfig, cronSt, mode }) {
  const parseCron = CronParse(cronSt.schedule);
  const pairs = uConfig.trading.pairs || [];

  let msg = `═══ 📊 <b>ESTADO DEL AGENTE</b> ═══\n\n`;

  msg += `🎯 <b>OPERATIVA</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📈 <b>Pares:</b> <code>${pairs.join(', ')}</code>\n`;
  msg += `🧐 <b>Estrategia:</b> <code>${uConfig.trading.personalityAgent}</code>\n`;
  msg += `🔮 <b>Visión:</b> <code>${uConfig.trading.visionAgent}</code>\n`;
  msg += `🕯️ <b>Velas a:</b> <code>${uConfig.indicators.candlesInterval} min</code>\n\n`;

  msg += `💰 <b>GESTIÓN DE RIESGO</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💳 <b>Max Trade:</b> ${uConfig.trading.maxTradeSize}%\n`;
  msg += `💵 <b>Min Orden:</b> $${uConfig.trading.minOrderUsd}\n`;
  msg += `🎯 <b>TP:</b> ${uConfig.trading.takeProfitPct}% | 🎯 <b>SL:</b> ${uConfig.trading.stopLossPct}%\n\n`;

  msg += `🤖 <b>TECNOLOGÍA</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;

  if (isFallbackChainEnabled(uConfig)) {
    const chain = getFallbackChain(uConfig);
    const models = chain.map(c => c.model).join(' → ');
    msg += `🔗 <b>Fallback Chain:</b> ✅ ACTIVO\n`;
    msg += `🧠 <b>Cascada:</b> <code>${models}</code>\n\n`;
  } else {
    msg += `🧠 <b>Modelo IA:</b> <code>${uConfig.llm.model}</code>\n`;
  }

  msg += `⏰ <b>Cron:</b> ${cronSt.enabled ? '✅ ACTIVO' : '⏸️ INACTIVO'} (${parseCron})\n`;
  msg += `🏦 <b>Modo:</b> ${mode}`;

  return msg;
}

export function getWelcomeMessage(username) {
  const display = username ? ' @' + escapeHTML(username) : '';
  return `👋 ¡Hola${display}!\n\nHas sido invitado al sistema de trading autónomo.\n\nAntes de empezar, necesito configurar tu cuenta en ${TOTAL_STEPS} pasos rápidos.\n\nPulsa el botón para comenzar:`;
}

export function buildOnboardingStatus(user) {
  const stepNum = user.onboarding_step || 1;
  return `🔧 Configuración en curso: Paso ${stepNum} de ${TOTAL_STEPS}`;
}

export function buildProgressBar(current, total) {
  const size = 10;
  const progress = Math.min(Math.max(current, 0), total);
  const filled = Math.round((progress / total) * size);
  const empty = size - filled;
  return '🟦'.repeat(filled) + '⬜'.repeat(empty) + ` (${current}/${total})`;
}

export function CronParse(expr) {
  if (expr === '*/5 * * * *') return 'cada 5 min';
  if (expr === '*/15 * * * *') return 'cada 15 min';
  if (expr === '*/30 * * * *') return 'cada 30 min';
  if (expr === '0 * * * *') return 'cada hora';
  if (expr === '0 */2 * * *') return 'cada 2 horas';
  if (expr === '0 */3 * * *') return 'cada 3 horas';
  if (expr === '0 */4 * * *') return 'cada 4 horas';
  if (expr === '0 */8 * * *') return 'cada 8 horas';
  if (expr === '0 */12 * * *') return 'cada 12 horas';
  if (expr === '0 0 * * *') return 'cada día (00:00)';
  return expr;
}

export function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}