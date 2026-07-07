// ═══════════════════════════════════════════════════════════════════════════════
// LLM CLIENT — Multi-provider with real reasoning support
// ═══════════════════════════════════════════════════════════════════════════════

import type { ChatMessage, StreamResult } from "./types.js";
import { getProvider, type Provider, type ModelInfo, type CreditInfo } from "./providers.js";

export class LLM {
  private provider: Provider;
  private apiKey: string;

  constructor(providerId: string, apiKey: string, customBaseUrl?: string) {
    this.provider = getProvider(providerId) || getProvider("openrouter")!;
    this.apiKey = apiKey;
    if (customBaseUrl) this.provider = { ...this.provider, baseUrl: customBaseUrl };
  }

  setProvider(id: string, key: string, baseUrl?: string) {
    this.provider = getProvider(id) || getProvider("openrouter")!;
    this.apiKey = key;
    if (baseUrl) this.provider = { ...this.provider, baseUrl };
  }

  setKey(k: string) { this.apiKey = k; }

  getProviderInfo() { return { id: this.provider.id, name: this.provider.name, baseUrl: this.provider.baseUrl }; }

  async fetchModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.provider.baseUrl}${this.provider.modelsEndpoint}`, { headers: this.provider.authHeader(this.apiKey) });
      if (!res.ok) return [];
      return this.provider.parseModels(await res.json());
    } catch { return []; }
  }

  async fetchCredits(): Promise<CreditInfo | null> {
    if (!this.provider.creditsEndpoint || !this.provider.parseCredits) return null;
    try {
      const res = await fetch(`${this.provider.baseUrl}${this.provider.creditsEndpoint}`, { headers: this.provider.authHeader(this.apiKey) });
      if (!res.ok) return null;
      return this.provider.parseCredits(await res.json());
    } catch { return null; }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; latency?: number }> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.provider.baseUrl}${this.provider.modelsEndpoint}`, {
        headers: this.provider.authHeader(this.apiKey), signal: AbortSignal.timeout(10000),
      });
      return { ok: res.ok, latency: Date.now() - start, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  async stream(messages: ChatMessage[], model: string, reasoning: "off"|"low"|"medium"|"high" = "off", onChunk?: (c: string) => void): Promise<StreamResult> {
    if (!this.apiKey && this.provider.id !== "ollama" && this.provider.id !== "lmstudio") throw new Error("API key not set. /api set <key>");

    const isAnthropic = this.provider.id === "anthropic";
    const isGoogle = this.provider.id === "google";

    // Build request based on provider
    let url: string, body: any, headers: Record<string, string>;

    if (isAnthropic) {
      url = `${this.provider.baseUrl}/messages`;
      const sysMsg = messages.find(m => m.role === "system");
      const otherMsgs = messages.filter(m => m.role !== "system");
      body = {
        model, max_tokens: 4096, stream: true,
        system: sysMsg?.content || "",
        messages: otherMsgs.map(m => ({ role: m.role, content: m.content })),
      };
      if (reasoning !== "off") body.thinking = { type: "enabled", budget_tokens: reasoning === "high" ? 8192 : reasoning === "medium" ? 4096 : 2048 };
      headers = this.provider.authHeader(this.apiKey);
    } else if (isGoogle) {
      url = `${this.provider.baseUrl}/models/${model}:streamGenerateContent?key=${this.apiKey}&alt=sse`;
      body = { contents: messages.filter(m => m.role !== "system").map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })) };
      const sys = messages.find(m => m.role === "system");
      if (sys) body.systemInstruction = { parts: [{ text: sys.content }] };
      headers = { "Content-Type": "application/json" };
    } else {
      // OpenAI-compatible (OpenRouter, Groq, DeepSeek, Together, etc)
      url = `${this.provider.baseUrl}/chat/completions`;
      body = { model, messages, max_tokens: 4096, temperature: 0.3, stream: true };
      if (reasoning !== "off" && this.provider.supportsReasoning) body.reasoning = { effort: reasoning };
      headers = this.provider.authHeader(this.apiKey);
    }

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);

    // Parse SSE stream
    let content = "", reasoningContent = "", usage: any = null;
    let phase: "detect" | "stream" | "buffer" = "detect";
    let pending = "", wasStreamed = false;

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      while (buf.includes("\n")) {
        const i = buf.indexOf("\n"); const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data: ")) continue;
        const d = line.slice(6).trim(); if (d === "[DONE]") continue;
        try {
          const p = JSON.parse(d);

          // Extract content based on provider
          let chunk = "", reasoning = "";
          if (isAnthropic) {
            if (p.type === "content_block_delta") {
              if (p.delta?.type === "thinking_delta") reasoning = p.delta.thinking || "";
              else chunk = p.delta?.text || "";
            }
            if (p.type === "message_delta" && p.usage) usage = p.usage;
          } else if (isGoogle) {
            chunk = p.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (p.usageMetadata) usage = { prompt_tokens: p.usageMetadata.promptTokenCount, completion_tokens: p.usageMetadata.candidatesTokenCount, total_tokens: p.usageMetadata.totalTokenCount };
          } else {
            const delta = p.choices?.[0]?.delta;
            reasoning = delta?.reasoning || delta?.reasoning_content || "";
            chunk = delta?.content || "";
            if (p.usage) usage = p.usage;
          }

          // Filter <think> tags
          if (chunk.includes("<think>") || chunk.includes("</think>")) { reasoningContent += chunk.replace(/<\/?think>/g, ""); continue; }
          if (reasoning) { reasoningContent += reasoning; continue; }
          if (!chunk) continue;

          content += chunk;

          // Smart streaming: detect JSON vs text
          if (phase === "detect") {
            pending += chunk;
            if (pending.length >= 30) {
              const t = pending.trimStart();
              if (t.startsWith("{") || t.startsWith("[") || t.startsWith("```json")) { phase = "buffer"; }
              else { phase = "stream"; wasStreamed = true; onChunk?.(pending); }
              pending = "";
            }
          } else if (phase === "stream") {
            if (chunk.trimStart().startsWith('{"type"')) { phase = "buffer"; continue; }
            onChunk?.(chunk);
          }
        } catch {}
      }
    }

    if (phase === "detect" && pending) {
      const t = pending.trimStart();
      if (t.startsWith("{") || t.startsWith("[")) { phase = "buffer"; }
      else { onChunk?.(pending); wasStreamed = true; }
    }

    let final = content;
    if (final.includes("<think>")) final = final.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    return { content: final, reasoning: reasoningContent, isJson: phase === "buffer", wasStreamed, usage };
  }

  async chat(messages: ChatMessage[], model: string) {
    const result = await this.stream(messages, model, "off");
    return { content: result.content, usage: result.usage };
  }
}
