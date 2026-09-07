#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const options = parseOptions(process.argv.slice(2));
const base = verifyRef(options.base);
const upstream = verifyRef(options.upstream);
const mergeBase = git(["merge-base", base, upstream]).trim();
const changes = parseChanges(
  git([
    "diff",
    "--name-status",
    "--find-renames",
    "--no-ext-diff",
    mergeBase,
    upstream,
  ]),
);
const report = renderReport({ base, upstream, mergeBase, changes });

if (options.output) {
  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, report, "utf8");
}

process.stdout.write(report);

function verifyRef(ref) {
  git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return ref;
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || "unknown Git error";
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

function parseChanges(output) {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      const status = fields[0];
      const paths = fields.slice(1);
      const currentPath =
        status.startsWith("R") || status.startsWith("C") ? paths[1] : paths[0];
      return {
        status,
        path: currentPath,
        previousPath: paths.length > 1 ? paths[0] : undefined,
      };
    });
}

function renderReport({ base, upstream, mergeBase, changes }) {
  const grouped = new Map();
  for (const change of changes) {
    const category = classify(change.path);
    const entries = grouped.get(category) ?? [];
    entries.push(change);
    grouped.set(category, entries);
  }

  const lines = [
    "# Upstream Documentation Migration Report",
    "",
    `- Base branch: \`${base}\``,
    `- Upstream branch: \`${upstream}\``,
    `- Common ancestor: \`${mergeBase}\``,
    "",
  ];

  if (changes.length === 0) {
    lines.push(
      "No upstream changes are pending relative to the common ancestor.",
      "",
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    "Review the documentation and generation-behavior groups first, then route each relevant change to the shared skill, its references, documentation, package metadata, or validation.",
  );

  for (const category of [
    "Documentation",
    "Generation behavior",
    "Workflows",
    "Tests",
    "Runtime adapters",
    "Supporting code",
  ]) {
    const entries = grouped.get(category);
    if (!entries?.length) continue;
    lines.push("", `## ${category}`, "", "| Change | Path |", "| --- | --- |");
    for (const entry of entries) {
      const pathLabel = entry.previousPath
        ? `\`${entry.previousPath}\` → \`${entry.path}\``
        : `\`${entry.path}\``;
      lines.push(`| \`${entry.status}\` | ${pathLabel} |`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function classify(file) {
  if (
    [
      "README.md",
      "DEVELOPMENT.md",
      "CONTRIBUTING.md",
      "AGENTS.md",
      "CLAUDE.md",
    ].includes(file) ||
    file.startsWith("openwiki/") ||
    file.startsWith("docs/") ||
    file.startsWith("integrations/openwiki/")
  ) {
    return "Documentation";
  }
  if (file.startsWith(".github/workflows/") || file.startsWith("examples/")) {
    return "Workflows";
  }
  if (
    file.startsWith("src/agent/") ||
    file.startsWith("src/generation/") ||
    file.startsWith("src/claims/") ||
    file.startsWith("src/okf/") ||
    file.startsWith("src/mermaid/")
  ) {
    return "Generation behavior";
  }
  if (file.startsWith("src/cli/") || file.startsWith("src/integrations/")) {
    return "Runtime adapters";
  }
  if (file.startsWith("test/")) {
    return "Tests";
  }
  return "Supporting code";
}

function parseOptions(args) {
  const options = { base: "HEAD", upstream: "upstream/main", output: null };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      argument === "--base" ||
      argument === "--upstream" ||
      argument === "--output"
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("-"))
        throw new Error(`${argument} requires a value.`);
      options[argument.slice(2)] = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "Usage: upstream-docs-report.mjs [--base <ref>] [--upstream <ref>] [--output <path>]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return options;
}
