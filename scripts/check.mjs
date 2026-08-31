#!/usr/bin/env node
// scripts/check.mjs — minimal project sanity script: syntax-check all JS/MJS files
// and report counts. Run via `npm run check`.

import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function walk(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (
        ent.name === "node_modules" ||
        ent.name.startsWith(".") ||
        ent.name === "vendor"
      )
        continue;
      out.push(...(await walk(p)));
    } else if (/\.(m?js)$/.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

const files = await walk(ROOT);
let failed = 0;
for (const f of files) {
  try {
    execFileSync(
      process.execPath,
      ["--check", f],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    console.log(`  ok   ${relative(ROOT, f)}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${relative(ROOT, f)}`);
    if (err.stderr) console.error(String(err.stderr));
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) failed syntax check`);
  process.exit(1);
}
console.log(`\n${files.length} file(s) syntax-checked`);