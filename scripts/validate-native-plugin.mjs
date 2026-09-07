#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const pluginRoot = path.join(root, "plugins", "less-openwiki");
const requiredFiles = [
  path.join(pluginRoot, ".codex-plugin", "plugin.json"),
  path.join(pluginRoot, ".claude-plugin", "plugin.json"),
  path.join(pluginRoot, "skills", "openwiki", "SKILL.md"),
  path.join(pluginRoot, "hooks", "hooks.json"),
  path.join(pluginRoot, "hooks", "less-openwiki-hook.mjs"),
  path.join(pluginRoot, "runtime", "storage.mjs"),
  path.join(pluginRoot, "runtime", "lifecycle.mjs"),
  path.join(pluginRoot, "runtime", "claims.mjs"),
  path.join(pluginRoot, "runtime", "evidence.mjs"),
  path.join(pluginRoot, "runtime", "okf.mjs"),
  path.join(pluginRoot, "runtime", "identity.mjs"),
  path.join(pluginRoot, "runtime", "setup.mjs"),
  path.join(pluginRoot, "runtime", "target-resolver.mjs"),
  path.join(pluginRoot, "runtime", "session-binding.mjs"),
  path.join(pluginRoot, "runtime", "vendor", "yaml.mjs"),
  path.join(pluginRoot, "runtime", "vendor", "NOTICE.md"),
  path.join(root, ".agents", "plugins", "marketplace.json"),
  path.join(root, ".claude-plugin", "marketplace.json"),
];

for (const file of requiredFiles) {
  await access(file);
}

const codexManifest = await readJson(requiredFiles[0]);
const claudeManifest = await readJson(requiredFiles[1]);
const hooks = await readJson(requiredFiles[3]);
const codexMarketplace = await readJson(requiredFiles[16]);
const claudeMarketplace = await readJson(requiredFiles[17]);
const identity = await import(path.join(pluginRoot, "runtime", "identity.mjs"));

assert(
  codexManifest.name === "less-openwiki",
  "Codex manifest name must be less-openwiki.",
);
assert(
  claudeManifest.name === "less-openwiki",
  "Claude manifest name must be less-openwiki.",
);
assert(
  codexManifest.skills === "./skills/",
  "Codex manifest must declare the skills directory.",
);
assert(
  codexManifest.hooks === "./hooks/hooks.json",
  "Codex manifest must explicitly declare its lifecycle hook package.",
);
assert(
  codexManifest.version === "0.4.1",
  "Codex manifest version must be 0.4.1.",
);
assert(
  claudeManifest.version === "0.4.1",
  "Claude manifest version must be 0.4.1.",
);
for (const [host, manifest] of [
  ["Codex", codexManifest],
  ["Claude", claudeManifest],
]) {
  assert(
    manifest.mcp === undefined &&
      manifest.mcpServers === undefined &&
      manifest.commands === undefined &&
      manifest.bin === undefined,
    `${host} manifest must expose the native skill and hooks without a public CLI or MCP transport.`,
  );
}
assert(
  identity.OPENWIKI_PRODUCER_ACTOR === `openwiki/${codexManifest.version}` &&
    codexManifest.version === claudeManifest.version,
  "Native producer actor must match the shared plugin version.",
);
for (const event of [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
]) {
  const command = hooks.hooks?.[event]?.[0]?.hooks?.[0]?.command;
  assert(
    typeof command === "string" && command.includes("less-openwiki-hook.mjs"),
    `Hook package must wire ${event} to the shared engine.`,
  );
}
for (const event of ["PreToolUse", "PostToolUse"]) {
  assert(
    hooks.hooks?.[event]?.[0]?.matcher === "*",
    `Hook package must route every ${event} tool event to the shared engine.`,
  );
}
assert(
  codexMarketplace.plugins?.[0]?.source?.path === "./plugins/less-openwiki",
  "Codex marketplace must point at the plugin.",
);
assert(
  claudeMarketplace.plugins?.[0]?.source === "./plugins/less-openwiki",
  "Claude marketplace must point at the plugin.",
);

const validator = path.join(pluginRoot, "scripts", "validate-wiki.mjs");
const validation = spawnSync(process.execPath, [validator, "--root", root], {
  encoding: "utf8",
});
if (validation.status !== 0) {
  process.stderr.write(validation.stderr || validation.stdout);
  process.exit(validation.status ?? 1);
}

process.stdout.write(
  "Native plugin manifests, extracted runtime, hook package, and repository wiki are valid.\n",
);

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
