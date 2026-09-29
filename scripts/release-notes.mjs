import { readFile } from "node:fs/promises";
import process from "node:process";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Provide a release version such as 0.1.8");
}

const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const lines = changelog.split(/\r?\n/u);
const start = lines.findIndex((line) => line === `## ${version}` || line.startsWith(`## ${version} —`));
if (start < 0) throw new Error(`CHANGELOG.md has no entry for ${version}`);

const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
const entry = lines.slice(start, next < 0 ? undefined : next).join("\n").trim();
if (!entry) throw new Error(`CHANGELOG.md entry for ${version} is empty`);
process.stdout.write(`${entry}\n`);
