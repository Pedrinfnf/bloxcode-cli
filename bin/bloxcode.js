#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
const dir = dirname(fileURLToPath(import.meta.url));
try { execFileSync(process.execPath, ["--import", "tsx", resolve(dir, "../src/cli.ts")], { stdio: "inherit", cwd: process.cwd() }); }
catch (e) { if (e.status) process.exit(e.status); }
