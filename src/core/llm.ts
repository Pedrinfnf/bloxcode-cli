import type { ChatMessage, StreamResult } from "./types.js";

export class LLM {
  constructor(private apiKey: string, private baseUrl: string) {}
  setKey(k: string) { this.apiKey = k; }
  setUrl(u: string) { this.baseUrl = u.replace(/\/+$/, ""); }

  async stream(messages: ChatMessage[], model: string, onChunk?: (c: string) => void): Promise<StreamResult> {
    if (!this.apiKey) throw new Error("API key not set. /api set <key>");
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}`, "HTTP-Referer": "http://localhost", "X-Title": "BloxCode" },
      body: JSON.stringify({ model, messages, max_tokens: 4096, temperature: 0.3, stream: true }),
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);

    let content = "", reasoning = "", usage: any = null;
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
          const p = JSON.parse(d); const delta = p.choices?.[0]?.delta;
          const r = delta?.reasoning || delta?.reasoning_content || "";
          if (r) { reasoning += r; continue; }
          if (delta?.content) {
            let ch: string = delta.content;
            if (ch.includes("<think>") || ch.includes("</think>")) { reasoning += ch.replace(/<\/?think>/g, ""); continue; }
            content += ch;
            if (phase === "detect") {
              pending += ch;
              if (pending.length >= 30) {
                const t = pending.trimStart();
                if (t.startsWith("{") || t.startsWith("[") || t.startsWith("```json")) { phase = "buffer"; }
                else { phase = "stream"; wasStreamed = true; onChunk?.(pending); }
                pending = "";
              }
            } else if (phase === "stream") {
              if (ch.trimStart().startsWith('{"type"')) { phase = "buffer"; continue; }
              onChunk?.(ch);
            }
          }
          if (p.usage) usage = p.usage;
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
    return { content: final, reasoning, isJson: phase === "buffer", wasStreamed, usage };
  }

  async chat(messages: ChatMessage[], model: string) {
    if (!this.apiKey) throw new Error("API key not set");
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}`, "HTTP-Referer": "http://localhost", "X-Title": "BloxCode" },
      body: JSON.stringify({ model, messages, max_tokens: 4096, temperature: 0.3 }),
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json() as any;
    return { content: data.choices?.[0]?.message?.content || "", usage: data.usage || null };
  }
}
