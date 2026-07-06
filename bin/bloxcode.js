#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(dir, "..");
const entry = join(pkgRoot, "src", "cli.ts");
const tsxBin = join(pkgRoot, "node_modules", ".bin", "tsx");

try {
  execFileSync(tsxBin, [entry], { stdio: "inherit", cwd: process.cwd(), env: process.env });
} catch (e) {
  // tsx binary might not exist (Windows, or npm didn't link)
  // Fallback: use node --import with tsx loader
  try {
    const tsxLoader = join(pkgRoot, "node_modules", "tsx", "dist", "loader.mjs");
    execFileSync(process.execPath, ["--import", tsxLoader, entry], { stdio: "inherit", cwd: process.cwd(), env: process.env });
  } catch (e2) {
    console.error("bloxcode: cannot find tsx runtime");
    console.error("try: npm install -g tsx");
    process.exit(1);
  }
}
