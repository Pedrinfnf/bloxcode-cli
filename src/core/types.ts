export interface ChatMessage { role: "system" | "user" | "assistant"; content: string; }
export interface ToolResult { ok: boolean; error?: string; [key: string]: unknown; }
export interface ToolDef { name: string; desc: string; args: string[]; cat: string; fn: (a: Record<string, unknown>) => Promise<ToolResult>; }
export interface StreamResult { content: string; reasoning: string; isJson: boolean; wasStreamed: boolean; usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null; }
export interface Config { apiKey: string; apiBaseUrl: string; model: string; mode: string; profile: string; workspace: string; }
