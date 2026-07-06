import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { register } from "./registry.js";

const exec = promisify(execFile);
let cwd = process.cwd();
export function setCwd(d: string) { cwd = d; }

function clip(s: string, n = 12000) { return s.length <= n ? s : s.slice(0, n) + `\n...(${s.length - n} chars cut)`; }
function safe(p: string) { const f = path.resolve(cwd, p); if (!f.startsWith(cwd) && f !== cwd) throw new Error("Outside workspace"); return f; }
async function sh(c: string) {
  try { const r = await exec("bash", ["-lc", c], { cwd, maxBuffer: 1024 * 1024, timeout: 120000 }); return { ok: true as const, code: 0, stdout: clip(r.stdout || ""), stderr: clip(r.stderr || "") }; }
  catch (e: any) { return { ok: false as const, code: e.code || 1, error: e.message, stderr: clip(e.stderr || "") }; }
}

export function registerAll() {
  const t = (name: string, desc: string, args: string[], cat: string, fn: (a: any) => Promise<any>) => register({ name, desc, args, cat, fn });

  t("cat", "Read file", ["path","start?","end?"], "fs", async a => {
    const c = await fs.readFile(safe(a.path), "utf8"); const l = c.split("\n");
    const s = Math.max(1, +a.start || 1), e = Math.min(l.length, +a.end || 200);
    return { ok: true, path: a.path, content: clip(l.slice(s-1, e).map((x,i) => `${String(s+i).padStart(5)} | ${x}`).join("\n")) };
  });
  t("write", "Write file", ["path","content"], "fs", async a => {
    const f = safe(a.path); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, String(a.content||""), "utf8");
    return { ok: true, path: a.path, bytes: Buffer.byteLength(String(a.content||"")) };
  });
  t("edit", "Edit lines", ["path","startLine","endLine","content"], "fs", async a => {
    const f = safe(a.path); const raw = await fs.readFile(f, "utf8"); const l = raw.split("\n");
    const s = Math.max(1,+a.startLine||1), e = Math.max(s,+a.endLine||s);
    l.splice(s-1, e-s+1, ...String(a.content||"").split("\n")); await fs.writeFile(f, l.join("\n"), "utf8");
    return { ok: true, path: a.path, replaced: { start: s, end: e } };
  });
  t("ls", "List dir", ["path?"], "fs", async a => {
    const e = await fs.readdir(safe(a.path || "."), { withFileTypes: true });
    return { ok: true, entries: e.slice(0, 200).map(x => ({ name: x.name, type: x.isDirectory() ? "dir" : "file" })) };
  });
  t("find", "Find files", ["pattern"], "fs", async a => {
    const r = await sh(`find . -name "${a.pattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -100`);
    return { ok: true, matches: (r.stdout as string || "").trim().split("\n").filter(Boolean) };
  });
  t("grep", "Search in files", ["pattern"], "fs", async a => {
    const r = await sh(`grep -rn --include="*.*" "${a.pattern}" . 2>/dev/null | head -50`);
    return { ok: true, matches: (r.stdout as string || "").trim().split("\n").filter(Boolean) };
  });
  t("tree", "Dir tree", ["path?","depth?"], "fs", async a => {
    const r = await sh(`find ${a.path||"."} -maxdepth ${a.depth||3} -not -path "*/node_modules/*" -not -path "*/.git/*" | head -200 | sort`);
    return { ok: true, tree: r.stdout };
  });
  t("shell", "Run command", ["command"], "shell", async a => sh(String(a.command)));
  t("test", "Run tests", ["framework?"], "shell", async a => {
    let c = ""; const fw = String(a.framework || "auto").toLowerCase();
    if (fw === "auto") { try { await fs.access(path.join(cwd,"package.json")); c="npm test"; } catch {} if(!c) try { await fs.access(path.join(cwd,"Cargo.toml")); c="cargo test"; } catch {} }
    else c = fw === "npm" ? "npm test" : fw === "cargo" ? "cargo test" : fw;
    return c ? sh(c) : { ok: false, error: "No framework" };
  });
  t("docker", "Docker cmd", ["action","args?"], "shell", async a => sh(`docker ${a.action} ${a.args||""}`));
  t("pkg", "Package mgr", ["action","packages?"], "shell", async a => sh(`npm ${a.action} ${a.packages||""}`));
  t("gitStatus", "Git status", [], "git", async () => sh("git status --short"));
  t("gitDiff", "Git diff", [], "git", async () => sh("git diff"));
  t("gitCommit", "Git commit", ["message"], "git", async a => sh(`git add -A && git commit -m "${a.message}"`));
  t("gitBranch", "New branch", ["name"], "git", async a => sh(`git checkout -b ${a.name}`));
  t("gitStash", "Git stash", [], "git", async () => sh("git stash"));
  t("gitLog", "Git log", ["count?"], "git", async a => sh(`git log --oneline -${a.count||10}`));
  t("search", "Web search", ["query"], "web", async a => {
    const q = encodeURIComponent(String(a.query));
    try {
      const r = await fetch(`https://lite.duckduckgo.com/lite/?q=${q}`, { headers: { "User-Agent": "Mozilla/5.0" } });
      const h = await r.text(); const re = /<a[^>]+class="result-link"[^>]*>(.*?)<\/a>/gi; const m: string[] = []; let x;
      while ((x = re.exec(h))) m.push(x[1].replace(/<[^>]+>/g, "").trim());
      return { ok: true, results: m.slice(0, 5) };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  t("fetch", "Fetch URL", ["url"], "web", async a => {
    try {
      const r = await fetch(String(a.url), { headers: { "User-Agent": "BloxCode/0.1" } });
      const t = await r.text();
      return { ok: true, content: clip(t.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<style[^>]*>[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim(), 8000) };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
}
