// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-PROVIDER LLM — Supports all major AI APIs
// ═══════════════════════════════════════════════════════════════════════════════

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  authHeader: (key: string) => Record<string, string>;
  modelsEndpoint: string;
  parseModels: (data: any) => ModelInfo[];
  supportsReasoning: boolean;
  free: boolean;
  creditsEndpoint?: string;
  parseCredits?: (data: any) => CreditInfo;
}

export interface ModelInfo {
  id: string;
  name: string;
  context: number;
  pricing: { input: number; output: number };
  reasoning: boolean;
}

export interface CreditInfo {
  remaining: number;
  limit: number;
  unit: string;
}

function openaiAuth(key: string) { return { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" }; }
function anthropicAuth(key: string) { return { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }; }

export const PROVIDERS: Record<string, Provider> = {
  openrouter: {
    id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1",
    authHeader: (k) => ({ ...openaiAuth(k), "HTTP-Referer": "http://localhost", "X-Title": "BloxCode" }),
    modelsEndpoint: "/models", supportsReasoning: true, free: true,
    parseModels: (d) => (d.data || []).map((m: any) => ({
      id: m.id, name: m.name || m.id.split("/").pop(), context: m.context_length || 0,
      pricing: { input: (m.pricing?.prompt || 0) * 1e6, output: (m.pricing?.completion || 0) * 1e6 },
      reasoning: m.id.includes("reasoning") || m.id.includes("r1"),
    })),
    creditsEndpoint: "/credits",
    parseCredits: (d) => ({ remaining: d.data?.remaining || 0, limit: d.data?.limit || 0, unit: "credits" }),
  },
  openai: {
    id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1",
    authHeader: openaiAuth, modelsEndpoint: "/models", supportsReasoning: true, free: false,
    parseModels: (d) => (d.data || []).filter((m: any) => m.id.startsWith("gpt") || m.id.startsWith("o")).map((m: any) => ({
      id: m.id, name: m.id, context: 128000, pricing: { input: 0, output: 0 }, reasoning: m.id.startsWith("o"),
    })),
  },
  anthropic: {
    id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1",
    authHeader: anthropicAuth, modelsEndpoint: "/models", supportsReasoning: true, free: false,
    parseModels: (_d) => [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", context: 200000, pricing: { input: 3, output: 15 }, reasoning: true },
      { id: "claude-opus-4", name: "Claude Opus 4", context: 200000, pricing: { input: 15, output: 75 }, reasoning: true },
      { id: "claude-haiku-3.5", name: "Claude Haiku 3.5", context: 200000, pricing: { input: 0.25, output: 1.25 }, reasoning: false },
    ],
  },
  google: {
    id: "google", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    authHeader: (k) => ({ "Content-Type": "application/json", "x-goog-api-key": k }),
    modelsEndpoint: "/models", supportsReasoning: true, free: true,
    parseModels: (d) => (d.models || []).map((m: any) => ({
      id: m.name?.replace("models/", ""), name: m.displayName || m.name, context: m.inputTokenLimit || 0,
      pricing: { input: 0, output: 0 }, reasoning: false,
    })),
  },
  groq: {
    id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1",
    authHeader: openaiAuth, modelsEndpoint: "/models", supportsReasoning: false, free: true,
    parseModels: (d) => (d.data || []).map((m: any) => ({
      id: m.id, name: m.id, context: m.context_window || 32768, pricing: { input: 0, output: 0 }, reasoning: false,
    })),
  },
  deepseek: {
    id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1",
    authHeader: openaiAuth, modelsEndpoint: "/models", supportsReasoning: true, free: false,
    parseModels: (d) => (d.data || []).map((m: any) => ({
      id: m.id, name: m.id, context: 131072, pricing: { input: 0.14, output: 0.28 }, reasoning: m.id.includes("reasoner"),
    })),
  },
  mistral: {
    id: "mistral", name: "Mistral AI", baseUrl: "https://api.mistral.ai/v1",
    authHeader: openaiAuth, modelsEndpoint: "/models", supportsReasoning: false, free: false,
    parseModels: (d) => (d.data || []).map((m: any) => ({
      id: m.id, name: m.id, context: m.max_context_length || 32768, pricing: { input: 0, output: 0 }, reasoning: false,
    })),
  },
  xai: {
    id: "xai", name: "xAI (Grok)", baseUrl: "https://api.x.ai/v1",
    authHeader: openaiAuth, modelsEndpoint: "/models", supportsReasoning: true, free: false,
    parseModels: (d) => (d.data || []).map((m: any) => ({
      id: m.id, name: m.id, context: 131072, pricing: { input: 0, output: 0 }, reasoning: false,
    })),
  },
  together: {
    id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1",
    authHeader: openaiAuth, modelsEndpoint: "/models", supportsReasoning: false, free: false,
    parseModels: (d) => (d || []).map((m: any) => ({
      id: m.id, name: m.display_name || m.id, context: m.context_length || 4096, pricing: { input: 0, output: 0 }, reasoning: false,
    })),
  },
  cerebras: {
    id: "cerebras", name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1",
    authHeader: openaiAuth, modelsEndpoint: "/models", supportsReasoning: false, free: true,
    parseModels: (d) => (d.data || []).map((m: any) => ({
      id: m.id, name: m.id, context: 131072, pricing: { input: 0, output: 0 }, reasoning: false,
    })),
  },
  cohere: {
    id: "cohere", name: "Cohere", baseUrl: "https://api.cohere.com/v2",
    authHeader: (k) => ({ "Authorization": `Bearer ${k}`, "Content-Type": "application/json" }),
    modelsEndpoint: "/models", supportsReasoning: false, free: false,
    parseModels: (d) => (d.models || []).map((m: any) => ({
      id: m.name, name: m.name, context: m.context_length || 128000, pricing: { input: 0, output: 0 }, reasoning: false,
    })),
  },
  ollama: {
    id: "ollama", name: "Ollama (local)", baseUrl: "http://localhost:11434/v1",
    authHeader: () => ({ "Content-Type": "application/json" }), modelsEndpoint: "/models",
    supportsReasoning: false, free: true,
    parseModels: (d) => (d.models || d.data || []).map((m: any) => ({
      id: m.name || m.id, name: m.name || m.id, context: 32768, pricing: { input: 0, output: 0 }, reasoning: false,
    })),
  },
  lmstudio: {
    id: "lmstudio", name: "LM Studio (local)", baseUrl: "http://localhost:1234/v1",
    authHeader: () => ({ "Content-Type": "application/json" }), modelsEndpoint: "/models",
    supportsReasoning: false, free: true,
    parseModels: (d) => (d.data || []).map((m: any) => ({
      id: m.id, name: m.id, context: 32768, pricing: { input: 0, output: 0 }, reasoning: false,
    })),
  },
  custom: {
    id: "custom", name: "Custom (OpenAI-compatible)", baseUrl: "",
    authHeader: openaiAuth, modelsEndpoint: "/models", supportsReasoning: false, free: false,
    parseModels: (d) => (d.data || []).map((m: any) => ({
      id: m.id, name: m.id, context: m.context_length || 32768, pricing: { input: 0, output: 0 }, reasoning: false,
    })),
  },
};

export function getProvider(id: string): Provider | undefined { return PROVIDERS[id]; }
export function allProviders(): Provider[] { return Object.values(PROVIDERS); }
