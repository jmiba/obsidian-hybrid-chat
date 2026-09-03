import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";

const syntax = spawnSync(process.execPath, ["--check", "main.js"], { stdio: "inherit" });
if (syntax.status !== 0) process.exit(syntax.status ?? 1);

const bundle = await readFile(new URL("../main.js", import.meta.url), "utf8");
const disallowed = [
  ["eval()", /\beval\s*\(/u],
  ["new Function()", /\bnew\s+Function\s*\(/u],
];

for (const [label, pattern] of disallowed) {
  if (pattern.test(bundle)) {
    process.stderr.write(`Generated main.js contains disallowed dynamic code execution via ${label}.\n`);
    process.exit(1);
  }
}

process.stdout.write("Verified main.js syntax and absence of dynamic code execution.\n");
