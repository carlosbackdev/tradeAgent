/**
 * agent/services/fallback-chain.js
 *
 * Calls the LLM analysis with a waterfall of up to 3 providers.
 * If provider 1 fails (rate-limit, quota, network), it tries provider 2, then 3.
 *
 * This is useful when the first two providers use free-tier models with strict
 * token-rate limits, and the third is a reliable paid fallback.
 *
 * Config shape (stored in user config as FALLBACK_CHAIN_*):
 *   FALLBACK_CHAIN_ENABLED  = 'true' | 'false'
 *   FALLBACK_CHAIN_1        = 'gemini'      (provider name)
 *   FALLBACK_CHAIN_1_MODEL  = 'gemini-2.5-flash'
 *   FALLBACK_CHAIN_2        = 'groq'
 *   FALLBACK_CHAIN_2_MODEL  = 'llama-3.3-70b-versatile'
 *   FALLBACK_CHAIN_3        = 'anthropic'   (reliable paid)
 *   FALLBACK_CHAIN_3_MODEL  = 'claude-haiku-4-5'
 */

import { clientAgentInstance } from '../job/client-agent-main.js';
import { logger } from '../../utils/logger.js';

/**
 * Build a provider-specific llmCfg using the per-provider API key already
 * persisted in the user config (AI_PROVIDER_API_KEY_<PROVIDER>).
 *
 * @param {object} userConfig    - full effectiveConfig object
 * @param {string} provider      - e.g. 'gemini'
 * @param {string} model         - model name for that provider
 * @returns {{ provider, model, apiKey }}
 */
function buildProviderCfg(userConfig, provider, model) {
  const providerKeyName = `AI_PROVIDER_API_KEY_${provider.toUpperCase()}`;
  // getRaw handles per-provider keys transparently
  const apiKey = userConfig.getRaw(providerKeyName)
    || userConfig.getRaw('AI_PROVIDER_API_KEY')
    || '';
  return { provider, model, apiKey };
}

/**
 * Read the ordered fallback chain from user config.
 * Returns an array of up to 3 { provider, model } slots that are configured.
 *
 * @param {object} userConfig
 * @returns {Array<{ provider: string, model: string }>}
 */
export function getFallbackChain(userConfig) {
  const chain = [];
  for (let i = 1; i <= 3; i++) {
    const provider = userConfig.getRaw(`FALLBACK_CHAIN_${i}`) || '';
    const model    = userConfig.getRaw(`FALLBACK_CHAIN_${i}_MODEL`) || '';
    if (provider && model) chain.push({ provider, model });
  }
  return chain;
}

/**
 * Returns true if the fallback chain is enabled and has at least one slot.
 *
 * @param {object} userConfig
 * @returns {boolean}
 */
export function isFallbackChainEnabled(userConfig) {
  const enabled = userConfig.getRaw('FALLBACK_CHAIN_ENABLED');
  return enabled === 'true' && getFallbackChain(userConfig).length > 0;
}

/**
 * Attempt the analysis through the waterfall of providers.
 * Logs each attempt and failure before moving to the next.
 *
 * @param {string} aiPayload       - serialized prompt for the analyzer
 * @param {object} userConfig      - full effectiveConfig (has getRaw, llm, trading…)
 * @param {object} tradingConfig   - effectiveConfig.trading (passed straight to callAgentAnalyzer)
 * @returns {Promise<object>}      - parsed decision object
 */
export async function callAgentWithFallback(aiPayload, userConfig, tradingConfig) {
  const chain = getFallbackChain(userConfig);

  if (chain.length === 0) {
    throw new Error('Fallback chain is enabled but no providers are configured.');
  }

  let lastError = null;

  for (let i = 0; i < chain.length; i++) {
    const { provider, model } = chain[i];
    const slot = i + 1;
    const llmCfg = buildProviderCfg(userConfig, provider, model);

    if (!llmCfg.apiKey || llmCfg.apiKey.length < 10) {
      logger.warn(`⛔ Fallback chain slot ${slot} (${provider}): no API key stored — skipping`);
      continue;
    }

    try {
      logger.info(`🔗 Fallback chain slot ${slot}/${chain.length}: ${provider} / ${model}`);
      const result = await clientAgentInstance.callAgentAnalyzer(aiPayload, llmCfg.apiKey, llmCfg.model, tradingConfig, llmCfg);
      logger.info(`✅ Fallback chain: success on slot ${slot} (${provider})`);
      return result;
    } catch (err) {
      lastError = err;
      logger.warn(`⚠️ Fallback chain slot ${slot} (${provider}) failed: ${err.message}`);
      // Continue to next provider
    }
  }

  throw new Error(
    `All fallback chain providers failed. Last error: ${lastError?.message || 'unknown'}`
  );
}
