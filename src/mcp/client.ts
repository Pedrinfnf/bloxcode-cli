import { spawn, type ChildProcess } from "node:child_process";
import { register, unregister } from "../tools/registry.js";

interface Conn { proc: ChildProcess; tools: string[]; }
const conns = new Map<string, Conn>();

function rpc(proc: ChildProcess, method: string, params: any, timeout = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    let resp = ""; const timer = setTimeout(() => { cleanup(); reject(new Error("MCP timeout")); }, timeout);
    const onData = (chunk: Buffer) => {
      resp += chunk.toString();
      for (const line of resp.split("\n")) {
        if (!line.trim()) continue;
        try { const p = JSON.parse(line.trim()); if (p.id || p.result || p.error) { cleanup(); p.error ? reject(new Error(p.error.message)) : resolve(p.result || p); return; } } catch {}
      }
    };
    const cleanup = () => { clearTimeout(timer); proc.stdout?.removeListener("data", onData); };
    proc.stdout?.on("data", onData);
    proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) + "\n");
  });
}

export async function mcpAdd(name: string, command: string, args: string[], cwd: string) {
  const proc = spawn(command, args, { cwd, env: process.env, stdio: ["pipe","pipe","pipe"] });
  proc.on("exit", () => { const c = conns.get(name); if (c) { c.tools.forEach(t => unregister(t)); conns.delete(name); } });
  await rpc(proc, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "BloxCode", version: "0.1" } });
  const r = await rpc(proc, "tools/list", {}) as any;
  const tools: string[] = [];
  for (const t of r?.tools || []) {
    const id = `mcp:${name}:${t.name}`;
    register({ name: id, desc: `[MCP:${name}] ${t.description || t.name}`, args: Object.keys(t.inputSchema?.properties || {}), cat: "mcp",
      fn: async (a) => { try { return { ok: true, ...(await rpc(proc, "tools/call", { name: t.name, arguments: a })) }; } catch (e) { return { ok: false, error: (e as Error).message }; } } });
    tools.push(id);
  }
  conns.set(name, { proc, tools });
  return tools.length;
}

export function mcpRemove(name: string) { const c = conns.get(name); if (c) { c.tools.forEach(t => unregister(t)); try { c.proc.kill(); } catch {} conns.delete(name); } }
export function mcpStatus() { return [...conns.entries()].map(([n, c]) => ({ name: n, running: !c.proc.killed, tools: c.tools.length })); }
export function mcpStopAll() { for (const [n] of conns) mcpRemove(n); }
