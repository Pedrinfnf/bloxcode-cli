import type { ToolDef, ToolResult } from "../core/types.js";

const tools = new Map<string, ToolDef>();

export function register(t: ToolDef) { tools.set(t.name, t); }
export function unregister(name: string) { tools.delete(name); }
export function all(): ToolDef[] { return [...tools.values()]; }
export function descriptions(): string {
  const cats = new Map<string, string[]>();
  for (const t of tools.values()) { if (!cats.has(t.cat)) cats.set(t.cat, []); cats.get(t.cat)!.push(`  - ${t.name}(${t.args.join(",")}): ${t.desc}`); }
  return [...cats.entries()].map(([cat, lines]) => `${cat}:\n${lines.join("\n")}`).join("\n\n");
}
export async function run(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const t = tools.get(name);
  if (!t) return { ok: false, error: `Unknown tool: ${name}. Available: ${[...tools.keys()].join(", ")}` };
  try { return await t.fn(args); } catch (e) { return { ok: false, error: (e as Error).message }; }
}
