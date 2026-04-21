/**
 * users/onboarding-wizard.js
 * Simplified 4-step onboarding assistant.
 */

import { updateUserConfig, setOnboardingStep, setUserStatus } from './user-registry.js';
import { logger } from '../utils/logger.js';
import { escapeHTML } from '../utils/formatter.js';

export const TOTAL_STEPS = 4;

const STEPS = {
  1: {
    key: 'REVOLUT_API_KEY',
    prompt: '🔑 <b>Paso 1/4 — Revolut X API Key</b>\n\nEntra a Revolut X → Perfil → API Keys → Crear clave API.\n\nEnvíame la <b>API Key</b> ahora:',
    validate: (v) => v.length > 20,
  },
  2: {
    key: 'REVOLUT_PRIVATE_KEY_PEM',
    prompt: '🔐 <b>Paso 2/4 — Clave privada Ed25519</b>\n\nNecesito tu clave privada (archivo .pem) para firmar las peticiones.\n\nPega el contenido completo del archivo <code>private.pem</code>, incluyendo las líneas:\n<code>-----BEGIN PRIVATE KEY-----</code>\n<code>...</code>\n<code>-----END PRIVATE KEY-----</code>',
    validate: (v) => v.includes('BEGIN PRIVATE KEY') && v.includes('END PRIVATE KEY'),
  },
  3: {
    key: 'ANTHROPIC_API_KEY',
    prompt: '🤖 <b>Paso 3/4 — Anthropic API Key</b>\n\nVe a <a href="https://console.anthropic.com">console.anthropic.com</a> → API Keys → Crear.\n\nEnvíame tu <b>API Key</b> (sk-ant-...):',
    validate: (v) => v.startsWith('sk-ant-') || v.startsWith('sk-'),
  },
  4: {
    key: 'TRADING_PAIRS',
    prompt: '💱 <b>Paso 4/4 — Pares de trading</b>\n\nSelecciona qué criptomonedas quieres que analice el agente.\n\nResponde con los símbolos separados por coma:\nEjemplo: <code>BTC-USD,ETH-USD</code> \n\nOpciones: BTC, ETH, SOL, XRP',
    validate: (v) => v.length >= 3,
  }
};

export function getStep(index) {
  // If index is 0 (start), return step 1
  return STEPS[index || 1];
}

export async function processOnboardingStep(user, text) {
  const currentStepNum = user.onboarding_step || 1;
  const step = STEPS[currentStepNum];

  if (!step) return { error: 'Estado de configuración inválido.' };

  // Validation
  if (!step.validate(text)) {
    return { error: 'Formato inválido.', prompt: step.prompt };
  }

  // Build config update
  const configUpdate = { [step.key]: text.trim() };

  // Apply automatic defaults
  if (currentStepNum === 1) {
    configUpdate['REVOLUT_BASE_URL'] = 'https://revx.revolut.com';
  }
  if (currentStepNum === 4) {
    configUpdate['DRY_RUN'] = 'false'; // Mode REAL by default
    configUpdate['CRON_ENABLED'] = 'true';
    configUpdate['CRON_SCHEDULE'] = '*/15 * * * *';
  }

  const nextStepNum = currentStepNum + 1;
  const isDone = nextStepNum > TOTAL_STEPS;

  try {
    // Save piece of config
    await updateUserConfig(user.telegram_id, configUpdate);
    
    if (isDone) {
      // Activate user
      await setUserStatus(user.telegram_id, 'active');
      return {
        done: true,
        activationMessage: '🎉 *¡Configuración completada exitosamente!*\n\nTu agente ya está operando en mercado real.\n\nUsa /start para abrir el panel de control 🚀'
      };
    } else {
      // Move to next step
      await setOnboardingStep(user.telegram_id, nextStepNum);
      user.onboarding_step = nextStepNum;
      const nextStep = STEPS[nextStepNum];
      return {
        done: false,
        stepNumber: nextStepNum,
        totalSteps: TOTAL_STEPS,
        nextPrompt: nextStep.prompt
      };
    }
  } catch (err) {
    logger.error('Onboarding save error:', err.message);
    return { error: `Error al guardar: ${err.message}` };
  }
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

