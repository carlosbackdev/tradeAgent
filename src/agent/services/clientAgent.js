/**
 * agent/services/clientAgent.js
 * Generic multi-provider LLM client implementations.
 * Supports: anthropic | openai | deepseek | gemini
 * These functions are used by clientAgentMain.
 */

import Anthropic from '@anthropic-ai/sdk';

export async function callAnthropic({ apiKey, model, systemPrompt, userMessage }) {
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    temperature: 0.1,
    system: systemPrompt,
    messages: [{ role: 'user', content: [{ type: 'text', text: userMessage }] }],
  });
  return response.content.map(b => b.text || '').join('').trim();
}

export async function callOpenAICompat({ apiKey, model, systemPrompt, userMessage, baseUrl }) {
  // Works for OpenAI and DeepSeek (both use the OpenAI SDK format)
  const { OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey,
    ...(baseUrl ? { baseUrl: baseUrl } : {}),
  });
  const response = await client.chat.completions.create({
    model,
    max_tokens: 2048,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });
  return response.choices?.[0]?.message?.content?.trim() || '';
}

export async function callGemini({ apiKey, model, systemPrompt, userMessage }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig: {
      temperature: 0.1,
      response_mime_type: 'application/json',
      maxOutputTokens: 4096,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
    ]
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errBody}`);
  }
  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}
