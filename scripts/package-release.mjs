import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import process from "node:process";

const root = new URL("../", import.meta.url);
const releaseDirectory = new URL("../dist/release/", import.meta.url);
const releaseAssets = ["main.js", "manifest.json", "styles.css"];
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const packageJson = await readJson(new URL("package.json", root));
const manifest = await readJson(new URL("manifest.json", root));
const versions = await readJson(new URL("versions.json", root));
const version = requiredString(manifest, "version", "manifest.json");
const minimumAppVersion = requiredString(manifest, "minAppVersion", "manifest.json");
const packageVersion = requiredString(packageJson, "version", "package.json");

assert(semverPattern.test(version), `manifest.json version must be SemVer without a leading v: ${version}`);
assert(packageVersion === version, `package.json version ${packageVersion} does not match manifest.json ${version}`);
assert(versions[version] === minimumAppVersion, `versions.json must map ${version} to ${minimumAppVersion}`);

const releaseTag = process.env.RELEASE_TAG?.trim();
if (releaseTag) assert(releaseTag === version, `release tag ${releaseTag} does not match manifest.json ${version}`);

await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(releaseDirectory, { recursive: true });

const checksumLines = [];
for (const asset of releaseAssets) {
  const source = new URL(asset, root);
  const sourceStats = await stat(source);
  assert(sourceStats.isFile() && sourceStats.size > 0, `${asset} must be a non-empty regular file`);
  const destination = new URL(asset, releaseDirectory);
  await copyFile(source, destination);
  const content = await readFile(destination);
  const digest = createHash("sha256").update(content).digest("hex");
  checksumLines.push(`${digest}  ${basename(asset)}`);
}

await writeFile(new URL("checksums.sha256", releaseDirectory), `${checksumLines.join("\n")}\n`, "utf8");
process.stdout.write(`Packaged Hybrid Chat ${version} in dist/release\n`);

async function readJson(url) {
  const parsed = JSON.parse(await readFile(url, "utf8"));
  assert(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed), `${basename(url.pathname)} must contain a JSON object`);
  return parsed;
}

function requiredString(value, key, source) {
  const result = value[key];
  assert(typeof result === "string" && result.length > 0, `${source} must define a non-empty ${key}`);
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
