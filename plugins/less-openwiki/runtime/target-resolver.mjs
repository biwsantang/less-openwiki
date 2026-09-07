import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { repositoryRoot } from "./storage.mjs";

const PATH_FIELDS = [
  "file_path",
  "filePath",
  "output_path",
  "outputPath",
  "path",
  "file",
  "target_file",
  "targetFile",
];

/**
 * Resolve a lifecycle root from a structured file operation. A projectless
 * prompt intentionally has no target: only a concrete operation may bind a
 * repository. Shell text is not treated as an authority to select a root.
 */
export function resolveTargetRepository(event) {
  const tool = event.tool_input ?? event.toolInput ?? {};
  const base = typeof tool.workdir === "string" ? tool.workdir : event.cwd;
  const paths = structuredPaths(tool, base);
  const documentation = paths.filter((candidate) =>
    candidate.split(path.sep).includes("openwiki"),
  );
  if (documentation.length === 0) return { root: null, targets: [] };

  const roots = new Set();
  const targets = [];
  for (const candidate of documentation) {
    const root = gitRootForPath(candidate);
    if (!root)
      return {
        root: null,
        targets: [],
        error: `Less OpenWiki cannot activate: ${candidate} is not inside a Git worktree.`,
      };
    if (!isWithin(path.join(root, "openwiki"), candidate))
      return {
        root: null,
        targets: [],
        error:
          "Less OpenWiki only manages paths below the selected repository's openwiki/ directory.",
      };
    roots.add(root);
    targets.push(candidate);
  }
  if (roots.size !== 1)
    return {
      root: null,
      targets: [],
      error:
        "Less OpenWiki cannot activate one lifecycle from an operation targeting multiple Git worktrees. Split the documentation edits by repository.",
    };
  const [root] = roots;
  const mixed = paths.some(
    (candidate) =>
      isWithin(root, candidate) &&
      !isWithin(path.join(root, "openwiki"), candidate),
  );
  if (mixed)
    return {
      root: null,
      targets: [],
      error:
        "Less OpenWiki requires source changes and openwiki/ writes to be separate operations so the documentation source snapshot remains valid.",
    };
  return { root, targets: [...new Set(targets)] };
}

export function sessionRepository(event) {
  return gitRootForPath(event.cwd ?? process.cwd());
}

function structuredPaths(tool, base) {
  const values = [];
  for (const field of PATH_FIELDS)
    if (typeof tool[field] === "string") values.push(tool[field]);
  for (const field of ["patch", "command"])
    if (typeof tool[field] === "string")
      values.push(
        ...[
          ...tool[field].matchAll(
            /^\*\*\* (?:Add|Delete|Update) File: ([^\r\n]+)/gmu,
          ),
        ].map((match) => match[1].trim()),
      );
  return values
    .filter((value) => value && !value.includes("\0"))
    .map((value) => canonicalPath(path.resolve(base ?? process.cwd(), value)));
}

function canonicalPath(candidate) {
  let existing = candidate;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return candidate;
    existing = parent;
  }
  try {
    return path.join(
      realpathSync(existing),
      path.relative(existing, candidate),
    );
  } catch {
    return candidate;
  }
}

function gitRootForPath(candidate) {
  let directory = candidate;
  while (!existsSync(directory)) {
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  if (existsSync(directory) && !statSync(directory).isDirectory())
    directory = path.dirname(directory);
  if (!existsSync(directory)) return null;
  const root = repositoryRoot(directory);
  if (!root) return null;
  try {
    return realpathSync(root);
  } catch {
    return null;
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
