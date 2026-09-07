#!/usr/bin/env node

import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const pluginRoot = path.join(root, "plugins", "less-openwiki");
const requiredFiles = [
  path.join(pluginRoot, ".codex-plugin", "plugin.json"),
  path.join(pluginRoot, ".claude-plugin", "plugin.json"),
  path.join(pluginRoot, "skills", "openwiki", "SKILL.md"),
  path.join(pluginRoot, "skills", "openwiki", "references", "maintenance.md"),
  path.join(
    pluginRoot,
    "skills",
    "openwiki",
    "references",
    "markdown-format.md",
  ),
  path.join(
    pluginRoot,
    "skills",
    "openwiki",
    "references",
    "research-and-authoring.md",
  ),
  path.join(root, ".agents", "plugins", "marketplace.json"),
  path.join(root, ".claude-plugin", "marketplace.json"),
];

for (const file of requiredFiles) await access(file);

const codexManifest = await readJson(requiredFiles[0]);
const claudeManifest = await readJson(requiredFiles[1]);
const codexMarketplace = await readJson(requiredFiles[6]);
const claudeMarketplace = await readJson(requiredFiles[7]);
const skill = await readFile(requiredFiles[2], "utf8");

assert(codexManifest.name === "less-openwiki", "Invalid Codex plugin name.");
assert(claudeManifest.name === "less-openwiki", "Invalid Claude plugin name.");
assert(
  codexManifest.version === "1.0.0",
  "Codex manifest version must be 1.0.0.",
);
assert(
  claudeManifest.version === "1.0.0",
  "Claude manifest version must be 1.0.0.",
);
assert(
  codexManifest.skills === "./skills/",
  "Codex manifest must expose the skill.",
);

for (const [host, manifest] of [
  ["Codex", codexManifest],
  ["Claude", claudeManifest],
]) {
  for (const field of ["hooks", "mcp", "mcpServers", "commands", "bin"]) {
    assert(
      manifest[field] === undefined,
      `${host} manifest must not expose ${field}.`,
    );
  }
}

for (const directory of ["hooks", "runtime", "scripts"]) {
  assert(
    !(await exists(path.join(pluginRoot, directory))),
    `Skill-only plugin must not contain plugins/less-openwiki/${directory}.`,
  );
}

assert(
  skill.includes("Do not create or depend on"),
  "Skill must explicitly reject legacy lifecycle artifacts.",
);

assert(
  codexMarketplace.plugins?.[0]?.source?.path === "./plugins/less-openwiki",
  "Codex marketplace must point at the plugin.",
);
assert(
  claudeMarketplace.plugins?.[0]?.source === "./plugins/less-openwiki",
  "Claude marketplace must point at the plugin.",
);

const validation = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "validate-wiki.mjs"), "--root", root],
  { encoding: "utf8" },
);
if (validation.status !== 0) {
  process.stderr.write(validation.stderr || validation.stdout);
  process.exit(validation.status ?? 1);
}

process.stdout.write(
  "Skill-only plugin manifests, skill references, and repository wiki are valid.\n",
);

async function exists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
