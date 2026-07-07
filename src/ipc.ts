#!/usr/bin/env npx tsx
// ═══════════════════════════════════════════════════════════════════════════════
// IPC SERVER — Receives commands from Rust TUI via stdin, responds via stdout
// Protocol: JSON lines (one JSON object per line)
// ═══════════════════════════════════════════════════════════════════════════════

import readline from "node:readline";
import { LLM } from "./core/llm.js";
import { loadConfig, saveConfig } from "./core/config.js";
import { registerAll, setCwd } from "./tools/builtin.js";
import { run, all, descriptions } from "./tools/registry.js";
import { createAgents } from "./agents/orchestrator.js";
import { mcpAdd, mcpRemove, mcpStatus, mcpStopAll } from "./mcp/client.js";
import { allProviders, type ModelInfo } from "./core/providers.js";

const VERSION = "0.1.2";

function send(msg: any) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function main() {
  const cfg = await loadConfig();
  const llm = new LLM(cfg.provider || "openrouter", cfg.apiKey, cfg.apiBaseUrl);
  registerAll();
  setCwd(cfg.workspace);
  const agents = createAgents();

  const systemPrompt = `You are BloxCode v${VERSION}, a terminal AI agent on Termux (Android).

RULES:
- Normal chat: PLAIN TEXT only. No JSON. No markdown.
- Tool use: {"type":"tool","tool":"name","args":{}}
- After multi-step: {"type":"final","content":"summary"}
- NEVER wrap chat in {"type":"final",...}
- Keep output SHORT (mobile screen).
- Shell runs ANY command. You are not limited.

TOOLS:
${descriptions()}

WORKSPACE: ${cfg.workspace}`;

  const messages = [{ role: "system" as const, content: systemPrompt }];

  // Tell Rust we're ready
  send({ type: "ready", version: VERSION, provider: llm.getProviderInfo(), model: cfg.model });

  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    let req: any;
    try { req = JSON.parse(line); } catch { continue; }

    try {
      switch (req.cmd) {
        case "chat": {
          messages.push({ role: "user", content: req.content });
          let loops = 0;
          while (loops++ < 25) {
            const result = await llm.stream(messages, cfg.model, req.reasoning || "high", (chunk) => {
              send({ type: "stream", chunk });
            });
            if (result.wasStreamed) send({ type: "stream_end" });
            if (result.reasoning) send({ type: "reasoning", content: result.reasoning });

            let parsed: any = null;
            if (result.isJson || !result.wasStreamed) {
              try { parsed = JSON.parse(result.content); } catch { const m = result.content.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]); } catch {} }
            }

            if (!parsed) {
              if (!result.wasStreamed) send({ type: "response", content: result.content });
              messages.push({ role: "assistant", content: result.content });
              send({ type: "done", usage: result.usage });
              break;
            }
            if (parsed.type === "final") {
              send({ type: "response", content: parsed.content || "" });
              messages.push({ role: "assistant", content: parsed.content || "" });
              send({ type: "done", usage: result.usage });
              break;
            }
            if (parsed.type === "tool") {
              send({ type: "tool_call", tool: parsed.tool, args: parsed.args });
              const tr = await run(parsed.tool, parsed.args || {});
              send({ type: "tool_result", tool: parsed.tool, result: tr });
              messages.push({ role: "assistant", content: JSON.stringify(parsed) });
              messages.push({ role: "user", content: `TOOL_RESULT:\n${JSON.stringify(tr).slice(0, 3000)}` });
              continue;
            }
            if (!result.wasStreamed) send({ type: "response", content: result.content });
            messages.push({ role: "assistant", content: result.content });
            send({ type: "done", usage: result.usage });
            break;
          }
          break;
        }

        case "models": {
          const models = await llm.fetchModels();
          send({ type: "models", models });
          break;
        }

        case "credits": {
          const credits = await llm.fetchCredits();
          send({ type: "credits", credits });
          break;
        }

        case "test_connection": {
          const test = await llm.testConnection();
          send({ type: "connection", ...test });
          break;
        }

        case "set_provider": {
          cfg.provider = req.provider;
          cfg.apiKey = req.key || cfg.apiKey;
          if (req.baseUrl) cfg.apiBaseUrl = req.baseUrl;
          llm.setProvider(cfg.provider, cfg.apiKey, cfg.apiBaseUrl);
          await saveConfig(cfg);
          send({ type: "ok", msg: `Provider: ${req.provider}` });
          break;
        }

        case "set_key": {
          cfg.apiKey = req.key;
          llm.setKey(req.key);
          await saveConfig(cfg);
          send({ type: "ok", msg: "Key saved" });
          break;
        }

        case "set_model": {
          cfg.model = req.model;
          await saveConfig(cfg);
          send({ type: "ok", msg: `Model: ${req.model}` });
          break;
        }

        case "providers": {
          send({ type: "providers", providers: allProviders().map(p => ({ id: p.id, name: p.name, free: p.free, reasoning: p.supportsReasoning })) });
          break;
        }

        case "tools": {
          send({ type: "tools", tools: all().map(t => ({ name: t.name, desc: t.desc, cat: t.cat })) });
          break;
        }

        case "exec": {
          const result = await run("shell", { command: req.command });
          send({ type: "exec_result", result });
          break;
        }

        case "agent": {
          send({ type: "agent_start" });
          const result = await agents.execute(req.task, llm as any, cfg.model);
          send({ type: "agent_result", ...result });
          break;
        }

        case "mcp_add": {
          const n = await mcpAdd(req.name, req.command, req.args || [], cfg.workspace);
          send({ type: "mcp_added", name: req.name, tools: n });
          break;
        }

        case "mcp_remove": {
          mcpRemove(req.name);
          send({ type: "ok", msg: `Removed ${req.name}` });
          break;
        }

        case "mcp_status": {
          send({ type: "mcp_status", servers: mcpStatus() });
          break;
        }

        case "clear": {
          messages.length = 1;
          send({ type: "ok", msg: "Cleared" });
          break;
        }

        case "quit": {
          mcpStopAll();
          send({ type: "bye" });
          process.exit(0);
        }

        default:
          send({ type: "error", msg: `Unknown command: ${req.cmd}` });
      }
    } catch (e) {
      send({ type: "error", msg: (e as Error).message });
    }
  }
}

main().catch(e => { send({ type: "error", msg: e.message }); process.exit(1); });
