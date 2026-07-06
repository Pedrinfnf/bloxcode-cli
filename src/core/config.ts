import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Config } from "./types.js";

const DIR = path.join(os.homedir(), ".bloxcode");
const FILE = path.join(DIR, "config.json");

export async function loadConfig(): Promise<Config> {
  const def: Config = {
    apiKey: process.env.OPENROUTER_API_KEY || "",
    apiBaseUrl: "https://openrouter.ai/api/v1",
    model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    mode: "suggest", profile: "safe", workspace: process.cwd(),
  };
  try { await fs.mkdir(DIR, { recursive: true }); const d = JSON.parse(await fs.readFile(FILE, "utf8")); return { ...def, ...d, workspace: process.cwd() }; }
  catch { return def; }
}

export async function saveConfig(c: Config) {
  await fs.mkdir(DIR, { recursive: true });
  const { workspace, ...rest } = c;
  await fs.writeFile(FILE, JSON.stringify(rest, null, 2));
}
