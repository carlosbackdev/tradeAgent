/**
 * agent/job/client-agent-main.js
 * Main entry point for LLM analysis, now encapsulated in a class.
 */

import { logger } from '../../utils/logger.js';
import { config } from '../../config/config.js';
import { getSystemPrompt } from '../context/prompts/trading-system-prompt.js';
import { parseLlmJsonResponse } from '../services/functions/json-parser.js';
import { 
  callAnthropic, 
  callOpenAICompat, 
  callGemini 
} from '../services/clientAgent.js';

export class clientAgentMain {
  /**
   * Call the configured LLM provider with a user message + system prompt.
   *
   * @param {string}   userMessage    - The prompt to send
   * @param {string}   [apiKey]       - Override API key (per-user); falls back to config.llm.apiKey
   * @param {string}   [model]        - Override model name; falls back to config.llm.model
   * @param {object}   [tradingConfig]- Trading config used to build default system prompt
   * @param {string}   [systemPrompt] - Override system prompt
   * @param {object}   [llmConfig]    - Full llm config override { provider, apiKey, model }
   * @returns {Promise<Object>}
   */
  async callAiWithCustomPrompt(
    userMessage,
    apiKey = null,
    model = null,
    tradingConfig = null,
    systemPrompt = null,
    llmConfig = null,
  ) {
    const effectiveSystemPrompt = systemPrompt || getSystemPrompt(tradingConfig || config.trading);

    // Resolve provider config: explicit llmConfig > config.llm global
    const provider = llmConfig?.provider || config.llm.provider || 'anthropic';
    const effectiveModel = model || llmConfig?.model || config.llm.model || 'claude-haiku-4-5';
    const effectiveApiKey = (apiKey ? String(apiKey).trim() : null)
      || llmConfig?.apiKey
      || config.llm.apiKey
      || '';

    logger.info(`🧠 LLM call → provider: ${provider} | model: ${effectiveModel}`);

    if (!effectiveApiKey || effectiveApiKey.length < 10) {
      throw new Error(`No valid API Key provided for provider "${provider}"`);
    }

    const params = {
      apiKey: effectiveApiKey,
      model: effectiveModel,
      systemPrompt: effectiveSystemPrompt,
      userMessage,
    };

    let raw;
    switch (provider) {
      case 'anthropic':
        raw = await callAnthropic(params);
        break;
      case 'openai':
      case 'deepseek':
        raw = await callOpenAICompat(params);
        break;
      case 'groq':
        raw = await callOpenAICompat({ ...params, baseUrl: 'https://api.groq.com/openai/v1' });
        break;
      case 'gemini':
        raw = await callGemini(params);
        break;
      default:
        throw new Error(`Unsupported LLM provider: "${provider}"`);
    }

    return parseLlmJsonResponse(raw);
  }

  /** @deprecated Use callAiWithCustomPrompt */
  async callClaudeWithCustomPrompt(...args) {
    return this.callAiWithCustomPrompt(...args);
  }

  async callAgentAnalyzer(userMessage, apiKey = null, model = null, tradingConfig = null, llmConfig = null) {
    logger.info(`🧠 callAgentAnalyzer → provider: ${llmConfig?.provider || config.llm.provider}`);
    logger.info('User Message: ', userMessage);
    return this.callAiWithCustomPrompt(userMessage, apiKey, model, tradingConfig, null, llmConfig);
  }
}

// Export a singleton instance or the class? 
// The user asked for a class, but usually for these types of jobs we can export an instance or just the class.
// I'll export both the class and a static-like helper to avoid breaking too many things if I can.
// But let's stick to the class for now as requested.
export const clientAgentInstance = new clientAgentMain();
