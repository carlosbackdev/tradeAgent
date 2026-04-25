export const PROVIDER_MODELS = {
    anthropic: [
        'claude-haiku-4-5',     // mejor coste/calidad de Anthropic
        'claude-sonnet-4-5',    // muy bueno para decisiones serias
        'claude-sonnet-4-6',    // mejor calidad, más caro
        'claude-opus-4-7',      // premium, solo casos críticos
        'claude-opus-4-6'       // premium fallback
    ],

    openai: [
        'gpt-5.4-mini',         // mejor coste/calidad OpenAI
        'gpt-5.4-nano',         // muy barato para análisis simples
        'o4-mini',              // razonamiento barato
        'gpt-5.4',              // calidad alta
        'gpt-5.5'               // premium
    ],

    gemini: [
        'gemini-2.5-flash',     // mejor calidad/precio de gemini
        'gemini-2.5-pro',       // muy buena calidad/precio para razonamiento
        'gemini-3.1-flash-lite',// barato y rápido
        'gemini-3.1-flash',     // equilibrado
        'gemini-3-pro',         // potente
        'gemini-3.1-pro'        // premium
    ],

    deepseek: [
        'deepseek-v4-flash',    // mejor coste/calidad
        'deepseek-v3.2',        // muy barato
        'deepseek-r1',          // razonamiento barato
        'deepseek-v4-pro',      // más calidad
        'deepseek-v3.2-speciale'// experimental/premium
    ],
    groq: [
        'llama-3.3-70b-versatile', // Potente y rápido
        'llama-3.1-8b-instant'     // Ultra-rápido para análisis simples
    ]
};