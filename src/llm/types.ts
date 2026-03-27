// LLM domain — provider configuration types
// Extraits de src/types.ts (phase 3)

export interface ProviderConfig {
  apiKey?: string;
  apiBase?: string;
  enabled?: boolean;
}

export interface ProvidersConfig {
  openrouter?: ProviderConfig;
  anthropic?: ProviderConfig;
  openai?: ProviderConfig;
  deepseek?: ProviderConfig;
  groq?: ProviderConfig;
  gemini?: ProviderConfig;
  [key: string]: ProviderConfig | undefined;
}
