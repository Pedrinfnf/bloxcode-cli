#!/usr/bin/env npx tsx
import readline from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import { LLM } from "./core/llm.js";
import { loadConfig, saveConfig } from "./core/config.js";
import { registerAll } from "./tools/builtin.js";
import { run, all, descriptions } from "./tools/registry.js";
import { createAgents } from "./agents/orchestrator.js";
import { mcpAdd, mcpRemove, mcpStatus, mcpStopAll } from "./mcp/client.js";

const V = "0.1.0";
const c = (t: string, ...s: string[]) => s.join("") + t + "\x1b[0m";
const C = { r: "\x1b[0m", b: "\x1b[1m", d: "\x1b[2m", red: "\x1b[31m", grn: "\x1b[32m", yel: "\x1b[33m", cyn: "\x1b[36m", gry: "\x1b[90m", bgrn: "\x1b[92m" };

async function main() {
  const cfg = await loadConfig();
  const llm = new LLM(cfg.apiKey, cfg.apiBaseUrl);
  registerAll();
  const agents = createAgents();

  const prompt = `You are BloxCode v${V}, a terminal AI agent on Termux (Android).

RULES:
- Normal chat: respond in PLAIN TEXT. No JSON. No markdown. No bold/headers/code blocks.
- To use a tool: {"type":"tool","tool":"name","args":{}}
- After multi-step task: {"type":"final","content":"summary"}
- NEVER wrap chat in {"type":"final",...}. Just write text.
- Keep output SHORT (mobile screen).

TOOLS:\n${descriptions()}

WORKSPACE: ${cfg.workspace}
MODE: ${cfg.mode}

The shell tool runs ANY command. You are not limited to listed tools.`;

  const msgs = [{ role: "system" as const, content: prompt }];

  // Banner
  console.log(`\n${c("  ● bloxcode", C.cyn, C.b)}`);
  console.log(`${c(`  v${V}`, C.gry)}${c(" · ", C.d)}${c(cfg.model.split("/").pop() || "", C.cyn)}${c(" · ", C.d)}${c(cfg.mode, C.yel)}`);
  if (!cfg.apiKey) console.log(c("  ⚠ no API key — /api set <key>", C.red));
  console.log(c(`  ${cfg.workspace.replace(process.env.HOME || "", "~")}`, C.gry));
  console.log(`\n${c("  /help · /model · @file · !cmd · /agent", C.gry)}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (p: string) => new Promise<string>(r => rl.question(p, r));
  const pr = () => { rl.setPrompt(c("bloxcode", C.cyn) + c(" > ", C.grn)); rl.prompt(); };

  pr();
  for await (const raw of rl) {
    const line = raw.trim(); if (!line) { pr(); continue; }

    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") {
      const h: [string,string][] = [
        ["/api set <key>","Set API key"],["/api show","Show key"],["/api url <u>","Change URL"],
        ["/model <slug>","Set model"],["/model","Show model"],["/mode <m>","suggest/autoedit/fullauto/plan/scout"],
        ["/agent <task>","Multi-agent"],["/agents","List agents"],["/tools","List tools"],
        ["/mcp add <n> <cmd>","Add MCP"],["/mcp remove <n>","Remove"],["/mcp","Status"],
        ["/clear","Clear context"],["@file msg","Attach file"],["!cmd","Shell"],["!!cmd","Silent shell"],["/exit","Quit"]];
      console.log(""); for (const [a,b] of h) console.log(`  ${c(a.padEnd(24),C.cyn)}${c(b,C.gry)}`); console.log("");
      pr(); continue;
    }
    if (line.startsWith("/api set ")) { cfg.apiKey = line.slice(9).trim(); llm.setKey(cfg.apiKey); await saveConfig(cfg); console.log(c("  ✓ saved",C.grn)); pr(); continue; }
    if (line === "/api set" || line === "/api") { const k = await ask(c("  key: ",C.yel)); if (k.trim()) { cfg.apiKey = k.trim(); llm.setKey(cfg.apiKey); await saveConfig(cfg); console.log(c("  ✓ saved",C.grn)); } pr(); continue; }
    if (line === "/api show") { const k = cfg.apiKey; console.log(k ? `  ${c("key:",C.cyn)} ${k.slice(0,10)}...${k.slice(-4)}` : c("  no key",C.red)); console.log(`  ${c("url:",C.cyn)} ${cfg.apiBaseUrl}`); pr(); continue; }
    if (line.startsWith("/api url ")) { cfg.apiBaseUrl = line.slice(9).trim().replace(/\/+$/,""); llm.setUrl(cfg.apiBaseUrl); await saveConfig(cfg); console.log(c(`  ✓ ${cfg.apiBaseUrl}`,C.grn)); pr(); continue; }
    if (line.startsWith("/model ")) { cfg.model = line.slice(7).trim(); await saveConfig(cfg); console.log(c(`  ✓ ${cfg.model}`,C.grn)); pr(); continue; }
    if (line === "/model") { console.log(`  ${c("model:",C.cyn)} ${cfg.model}`); pr(); continue; }
    if (line.startsWith("/mode ")) { cfg.mode = line.slice(6).trim(); await saveConfig(cfg); console.log(c(`  ✓ ${cfg.mode}`,C.grn)); pr(); continue; }
    if (line === "/tools") { console.log(""); const t = all(); let lc = ""; for (const x of t) { if (x.cat !== lc) { console.log(c(`  ${x.cat}`,C.b)); lc = x.cat; } console.log(`    ${c(x.name.padEnd(16),C.cyn)}${c(x.desc,C.gry)}`); } console.log(""); pr(); continue; }
    if (line === "/clear") { msgs.length = 1; console.log(c("  ✓ cleared",C.grn)); pr(); continue; }
    if (line.startsWith("/agent ")) {
      const task = line.slice(7).trim(); if (!task || !cfg.apiKey) { console.log(c("  ⚠ need task + API key",C.red)); pr(); continue; }
      console.log(c("  ● orchestrating...",C.cyn));
      const r = await agents.execute(task, llm, cfg.model);
      for (const x of r.results) console.log(`  ${x.ok ? c("✓",C.grn) : c("✗",C.red)} ${c(`[${x.agent}]`,C.cyn)} ${(x.content||x.error||"").slice(0,200)}`);
      pr(); continue;
    }
    if (line === "/agents") { console.log(""); for (const [n,a] of agents.agents) console.log(`  ${c(n.padEnd(12),C.cyn)}${c(a.role,C.gry)}`); console.log(""); pr(); continue; }
    if (line.startsWith("/mcp add ")) { const p = line.slice(9).trim().split(/\s+/); if (p.length < 2) { console.log(c("  /mcp add <name> <cmd> [args]",C.yel)); pr(); continue; } try { const n = await mcpAdd(p[0], p[1], p.slice(2), cfg.workspace); console.log(c(`  ✓ ${p[0]}: ${n} tools`,C.grn)); } catch (e) { console.log(c(`  ✗ ${(e as Error).message}`,C.red)); } pr(); continue; }
    if (line.startsWith("/mcp remove ")) { mcpRemove(line.slice(12).trim()); console.log(c("  ✓",C.grn)); pr(); continue; }
    if (line === "/mcp") { const s = mcpStatus(); if (!s.length) console.log(c("  no MCP servers",C.gry)); else for (const x of s) console.log(`  ${c(x.name.padEnd(16),C.cyn)}${x.running?c("● running",C.grn):c("○ stopped",C.gry)} ${c(`${x.tools} tools`,C.gry)}`); pr(); continue; }
    if (line.startsWith("!")) { const s = line.startsWith("!!"), cmd = line.slice(s?2:1).trim(); if (cmd) { const r = await run("shell", {command:cmd}); const o = (r as any).stdout||(r as any).error||""; if (o) console.log(o); if (!s && o) msgs.push({role:"user",content:`[shell: ${cmd}]\n${o}`}); } pr(); continue; }
    if (line.startsWith("/")) { console.log(c("  unknown — /help",C.red)); pr(); continue; }

    // ── Chat ──
    if (!cfg.apiKey) { console.log(c("  ⚠ /api set <key>",C.red)); pr(); continue; }
    let input = line;
    const refs = line.match(/@([\w.\/\-]+)/g);
    if (refs) for (const ref of refs) { try { const f = await fs.readFile(path.resolve(cfg.workspace, ref.slice(1)), "utf8"); input = input.replace(ref,"") + `\n[File: ${ref.slice(1)}]\n${f.slice(0,12000)}`; console.log(c(`  📎 ${ref.slice(1)}`,C.gry)); } catch { console.log(c(`  ⚠ ${ref.slice(1)} not found`,C.yel)); } }
    msgs.push({ role: "user", content: input.trim() });

    for (let loop = 0; loop < 25; loop++) {
      try {
        const r = await llm.stream(msgs, cfg.model, ch => process.stdout.write(ch));
        if (r.wasStreamed) process.stdout.write("\n\n");
        let parsed: any = null;
        if (r.isJson || !r.wasStreamed) { try { parsed = JSON.parse(r.content); } catch { const m = r.content.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]); } catch {} } }
        if (!parsed) { if (!r.wasStreamed) console.log(r.content+"\n"); msgs.push({role:"assistant",content:r.content}); break; }
        if (parsed.type === "final") { const t = parsed.content||""; if (!r.wasStreamed) console.log(t+"\n"); msgs.push({role:"assistant",content:t}); break; }
        if (parsed.type === "tool") {
          const tr = await run(parsed.tool, parsed.args||{});
          const ok = (tr as any).ok !== false;
          console.log(`  ${c(parsed.tool,C.cyn)} ${c("→",C.gry)} ${ok?c("✓",C.grn):c("✗",C.red)}`);
          const o = JSON.stringify(tr,null,2).split("\n"); if (o.length<=5) for (const l of o) console.log(c(`  │ ${l}`,C.gry)); else { for (const l of o.slice(0,3)) console.log(c(`  │ ${l}`,C.gry)); console.log(c(`  │ ...+${o.length-3}`,C.d)); }
          msgs.push({role:"assistant",content:JSON.stringify(parsed)}); msgs.push({role:"user",content:`TOOL_RESULT:\n${JSON.stringify(tr).slice(0,3000)}`});
          continue;
        }
        if (!r.wasStreamed) console.log(r.content+"\n"); msgs.push({role:"assistant",content:r.content}); break;
      } catch (e) { console.log(c(`  ✗ ${(e as Error).message}`,C.red)); break; }
    }
    pr();
  }
  mcpStopAll();
  console.log(c("\n  ● goodbye\n",C.cyn));
  process.exit(0);
}
main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
