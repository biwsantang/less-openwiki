import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const WIKI = "openwiki";

export function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function now() {
  return new Date().toISOString();
}

export function relative(root, candidate) {
  return path.relative(root, candidate).replace(/\\/gu, "/");
}

export function isWithin(root, candidate) {
  const result = path.relative(root, candidate);
  return (
    result === "" || (!result.startsWith("..") && !path.isAbsolute(result))
  );
}

export function repositoryRoot(cwd) {
  const output = git(cwd, ["rev-parse", "--show-toplevel"]);
  return output ? path.resolve(output) : null;
}

export function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function runPath(root) {
  return path.join(root, WIKI, ".run.json");
}

export function lastUpdatePath(root) {
  return path.join(root, WIKI, ".last-update.json");
}

export function manifestPath(root) {
  return path.join(root, WIKI, ".page-manifest.json");
}

export function intentRoot(root) {
  return path.join(root, WIKI, ".intents");
}

export function planIntentPath(root) {
  return path.join(intentRoot(root), "plan.json");
}

export function pageIntentPath(root, page) {
  return path.join(
    intentRoot(root),
    `${page.replace(/^openwiki\//u, "").replace(/\.md$/u, "")}.json`,
  );
}

export function rollbackRoot(root, runId) {
  return path.join(root, WIKI, ".rollback", runId);
}

export async function readJson(file, { required = false } = {}) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return null;
    throw new Error(
      `invalid JSON at ${file}; refusing to discard durable documentation state`,
    );
  }
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function isFile(file) {
  try {
    return (await lstat(file)).isFile();
  } catch {
    return false;
  }
}

export async function isDirectory(file) {
  try {
    return (await lstat(file)).isDirectory();
  } catch {
    return false;
  }
}

export async function markdownFiles(directory) {
  if (!(await isDirectory(directory))) return [];
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await markdownFiles(child)));
    else if (entry.isFile() && entry.name.endsWith(".md")) result.push(child);
  }
  return result.sort();
}

export function isFactualPage(page) {
  const normalized = page.replace(/\\/gu, "/");
  const basename = path.posix.basename(normalized).toLowerCase();
  return (
    normalized.startsWith("openwiki/") &&
    normalized.endsWith(".md") &&
    !["index.md", "log.md", "instructions.md"].includes(basename) &&
    !normalized.includes("/.claims/")
  );
}

export async function factualPages(root) {
  return (await markdownFiles(path.join(root, WIKI))).filter((file) =>
    isFactualPage(relative(root, file)),
  );
}

export function normalizePage(value) {
  const page = value.trim().replace(/\\/gu, "/").replace(/^\/+/, "");
  const rooted = page.startsWith("openwiki/") ? page : `openwiki/${page}`;
  const normalized = path.posix.normalize(rooted);
  if (
    !isFactualPage(normalized) ||
    normalized.includes("../") ||
    normalized.startsWith("../")
  ) {
    throw new Error(`invalid documentation page path: ${value}`);
  }
  return normalized;
}

export async function sourceSnapshot(root) {
  const ignore = await loadIgnore(root);
  const files = await repositoryFiles(root);
  const digest = createHash("sha256");
  digest.update("openwiki-source-v1\0");
  digest.update(
    (git(root, ["rev-parse", "--verify", "HEAD"]) ?? "unborn").trim(),
  );
  for (const file of files) {
    if (
      file === ".git" ||
      file.startsWith(".git/") ||
      file === WIKI ||
      file.startsWith(`${WIKI}/`) ||
      (file !== ".openwikiignore" && ignore(file))
    )
      continue;
    const absolute = path.join(root, file);
    let stats;
    try {
      stats = await lstat(absolute);
    } catch {
      digest.update(`missing\0${file}\0`);
      continue;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) continue;
    digest.update(`file\0${file}\0`);
    digest.update(await readFile(absolute));
    digest.update("\0");
  }
  return {
    fingerprint: `sha256:${digest.digest("hex")}`,
    gitHead: git(root, ["rev-parse", "--verify", "HEAD"]) ?? undefined,
  };
}

async function repositoryFiles(root) {
  const tracked = git(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (tracked !== null)
    return [...new Set(tracked.split("\0").filter(Boolean))].sort();
  return walk(root, root);
}

async function walk(root, directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === WIKI || entry.isSymbolicLink())
      continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(root, absolute)));
    else if (entry.isFile()) result.push(relative(root, absolute));
  }
  return result.sort();
}

async function loadIgnore(root) {
  let lines = [];
  try {
    lines = (await readFile(path.join(root, ".openwikiignore"), "utf8")).split(
      /\r?\n/u,
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const rules = lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return (candidate) => {
    let ignored = false;
    for (let rule of rules) {
      const negated = rule.startsWith("!");
      if (negated) rule = rule.slice(1);
      rule = rule.replace(/^\.\//u, "").replace(/^\/+|\/+$/gu, "");
      const expression =
        "^" +
        rule
          .split("**")
          .map((part) => part.split("*").map(escape).join("[^/]*"))
          .join(".*") +
        "(?:/.*)?$";
      const matches = rule.includes("/")
        ? new RegExp(expression, "iu").test(candidate)
        : new RegExp(`(^|/)${expression.slice(1)}`, "iu").test(candidate);
      if (matches) ignored = !negated;
    }
    return ignored;
  };
}

function escape(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}
