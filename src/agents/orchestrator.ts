import type { ChatMessage } from "../core/types.js";
import { run } from "../tools/registry.js";
import { LLM } from "../core/llm.js";

interface AgentCfg { name: string; role: string; prompt: string; tools: string[]; loops: number; }

export class Orchestrator {
  agents = new Map<string, AgentCfg>();
  register(a: AgentCfg) { this.agents.set(a.name, a); }

  async execute(task: string, llm: LLM, model: string) {
    const list = [...this.agents.values()].map(a => `- ${a.name}: ${a.role}`).join("\n");
    let plan: any;
    try {
      const r = await llm.chat([
        { role: "system", content: "Pick agents. Return JSON: {\"tasks\":[{\"agent\":\"name\",\"task\":\"subtask\"}]}" },
        { role: "user", content: `Task: ${task}\nAgents:\n${list}` },
      ], model);
      plan = JSON.parse(r.content);
    } catch { plan = { tasks: [{ agent: "Coder", task }] }; }

    const results: any[] = [];
    for (const t of plan.tasks || []) {
      const agent = this.agents.get(t.agent) || this.agents.get("Coder")!;
      const msgs: ChatMessage[] = [{ role: "system", content: agent.prompt }, { role: "user", content: t.task }];
      for (let i = 0; i < agent.loops; i++) {
        try {
          const r = await llm.stream(msgs, model);
          let parsed: any;
          try { parsed = JSON.parse(r.content); } catch { const m = r.content.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]); } catch {} }
          if (!parsed) { results.push({ agent: t.agent, ok: true, content: r.content }); break; }
          if (parsed.type === "final") { results.push({ agent: t.agent, ok: true, content: parsed.content }); break; }
          if (parsed.type === "tool") {
            const tr = await run(parsed.tool, parsed.args || {});
            msgs.push({ role: "assistant", content: JSON.stringify(parsed) });
            msgs.push({ role: "user", content: `TOOL_RESULT:\n${JSON.stringify(tr).slice(0,3000)}` });
            continue;
          }
          results.push({ agent: t.agent, ok: true, content: r.content }); break;
        } catch (e) { results.push({ agent: t.agent, ok: false, error: (e as Error).message }); break; }
      }
    }
    return { ok: results.every(r => r.ok), results };
  }
}

export function createAgents(): Orchestrator {
  const o = new Orchestrator();
  const a = (n: string, r: string, p: string, t: string[], l = 15) => o.register({ name: n, role: r, prompt: p, tools: t, loops: l });
  a("Coder", "Creates/edits code", "You are Coder. Read before edit. JSON: {\"type\":\"tool\",...} or {\"type\":\"final\",\"content\":\"...\"}",
    ["cat","write","edit","shell","find","grep","tree","ls","test"], 20);
  a("Reviewer", "Reviews code", "You are Reviewer. Find bugs. JSON: type:tool or type:final.", ["cat","grep","find","shell","tree"], 10);
  a("Researcher", "Searches docs", "You are Researcher. Search web/code. JSON: type:tool or type:final.", ["search","fetch","cat","find","grep"], 8);
  a("Tester", "Runs tests", "You are Tester. Write+run tests. JSON: type:tool or type:final.", ["cat","write","shell","test","find"], 15);
  a("DevOps", "Git/Docker/CI", "You are DevOps. Git, docker, deploy. JSON: type:tool or type:final.",
    ["shell","gitStatus","gitDiff","gitCommit","gitBranch","gitStash","gitLog","docker","pkg"], 10);
  return o;
}
