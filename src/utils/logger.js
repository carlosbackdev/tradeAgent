/**
 * src/utils/logger.js
 * Simple structured logging utility.
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const levelNames = Object.keys(LOG_LEVELS);
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

function timestamp() {
  return new Date().toISOString();
}

function shouldLog(level) {
  return LOG_LEVELS[level] >= currentLevel;
}

export const logger = {
  debug: (msg, data) => {
    if (shouldLog('debug')) {
      console.log(`[${timestamp()}] 🔍 DEBUG: ${msg}`, data || '');
    }
  },
  info: (msg, data) => {
    if (shouldLog('info')) {
      console.log(`[${timestamp()}] ℹ️  INFO: ${msg}`, data || '');
    }
  },
  warn: (msg, data) => {
    if (shouldLog('warn')) {
      console.warn(`[${timestamp()}] ⚠️  WARN: ${msg}`, data || '');
    }
  },
  error: (msg, error) => {
    if (shouldLog('error')) {
      console.error(`[${timestamp()}] ❌ ERROR: ${msg}`, error || '');
    }
  },
};
