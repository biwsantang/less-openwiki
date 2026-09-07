import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
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

function gitRaw(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
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
    path.posix.basename(normalized).startsWith("_") ||
    normalized.includes("../") ||
    normalized.startsWith("../")
  ) {
    throw new Error(`invalid documentation page path: ${value}`);
  }
  return normalized;
}

export async function sourceSnapshot(root) {
  const ignore = await loadOpenWikiIgnore(root);
  const [head, trackedOutput, untrackedOutput, statusOutput] =
    await Promise.all([
      fingerprintHead(root),
      fingerprintGit(root, ["ls-files", "--cached", "-z"]),
      fingerprintGit(root, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]),
      fingerprintGit(root, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--no-renames",
        "-z",
      ]),
    ]);
  const tracked = new Set(splitGitNul(trackedOutput).map(assertGitPath));
  const candidates = new Set([
    ...tracked,
    ...splitGitNul(untrackedOutput).map(assertGitPath),
  ]);
  try {
    await lstat(path.join(root, ".openwikiignore"));
    candidates.add(".openwikiignore");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const visible = [...candidates]
    .filter((file) => visibleSourcePath(file, ignore))
    .sort(compareCodeUnits);
  const statuses = splitGitNul(statusOutput)
    .map((record) => {
      if (record.length < 4 || record[2] !== " ")
        throw new Error("Git returned malformed porcelain status output.");
      return { code: record.slice(0, 2), path: assertGitPath(record.slice(3)) };
    })
    .filter(({ path: file }) => visibleSourcePath(file, ignore))
    .sort((left, right) =>
      compareCodeUnits(
        `${left.code}\0${left.path}`,
        `${right.code}\0${right.path}`,
      ),
    );
  const digest = createHash("sha256");
  updateFingerprintField(digest, "format", "openwiki-source-fingerprint-v1");
  updateFingerprintField(digest, "head", head);
  for (const status of statuses) {
    updateFingerprintField(digest, "status-code", status.code);
    updateFingerprintField(digest, "status-path", status.path);
  }
  for (const file of visible)
    await updateFingerprintSourceEntry(digest, root, file, tracked.has(file));
  return {
    fingerprint: `sha256:${digest.digest("hex")}`,
    ...(head.startsWith("unborn:") ? {} : { gitHead: head }),
  };
}

async function fingerprintHead(root) {
  const head = gitRaw(root, ["rev-parse", "--verify", "HEAD"]);
  if (head) return head.trimEnd();
  const symbolic = gitRaw(root, ["symbolic-ref", "-q", "HEAD"]);
  if (symbolic?.trim()) return `unborn:${symbolic.trimEnd()}`;
  throw new Error(
    "Unable to resolve repository HEAD for source fingerprinting.",
  );
}

function fingerprintGit(root, args) {
  const output = gitRaw(root, args);
  if (output === null)
    throw new Error(
      `Git failed while creating source fingerprint: git ${args.join(" ")}`,
    );
  return output;
}

function splitGitNul(output) {
  if (!output) return [];
  if (!output.endsWith("\0"))
    throw new Error("Git returned non-NUL-terminated fingerprint output.");
  return output.slice(0, -1).split("\0");
}

function assertGitPath(value) {
  if (!value || path.posix.isAbsolute(value))
    throw new Error(`Git returned an invalid repository path: ${value}`);
  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../"))
    throw new Error(`Git returned an escaping repository path: ${value}`);
  return normalized;
}

function visibleSourcePath(file, ignore) {
  return (
    file === ".openwikiignore" ||
    (file !== ".git" &&
      !file.startsWith(".git/") &&
      file !== WIKI &&
      !file.startsWith(`${WIKI}/`) &&
      !ignore(file))
  );
}

async function updateFingerprintSourceEntry(digest, root, file, tracked) {
  const absolute = path.resolve(root, file);
  if (!isWithin(root, absolute))
    throw new Error(`Source fingerprint path escaped the repository: ${file}`);
  updateFingerprintField(digest, "path", file);
  let stats;
  try {
    stats = await lstat(absolute, { bigint: true });
  } catch (error) {
    if (tracked && error?.code === "ENOENT") {
      updateFingerprintField(digest, "kind", "tracked-missing");
      return;
    }
    throw new Error(`Unable to inspect source path ${file}.`, { cause: error });
  }
  if (stats.isFile()) {
    const opened = await readFingerprintRegularFile(absolute, file, stats);
    updateFingerprintField(
      digest,
      "executable",
      opened.executable ? "yes" : "no",
    );
    updateFingerprintField(digest, "kind", "file");
    updateFingerprintField(digest, "bytes", opened.bytes);
    return;
  }
  updateFingerprintField(
    digest,
    "executable",
    stats.mode & 0o111n ? "yes" : "no",
  );
  if (stats.isSymbolicLink()) {
    updateFingerprintField(digest, "kind", "symlink");
    updateFingerprintField(
      digest,
      "target",
      await readlink(absolute, { encoding: "buffer" }),
    );
    return;
  }
  if (stats.isDirectory()) {
    updateFingerprintField(digest, "kind", "directory");
    return;
  }
  throw new Error(`Unsupported source entry type at ${file}.`);
}

async function readFingerprintRegularFile(absolute, file, inspected) {
  let handle;
  try {
    handle = await open(
      absolute,
      fsConstants.O_RDONLY |
        (typeof fsConstants.O_NOFOLLOW === "number"
          ? fsConstants.O_NOFOLLOW
          : 0),
    );
  } catch (error) {
    throw new Error(`Unable to safely open source path ${file}.`, {
      cause: error,
    });
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== inspected.dev ||
      opened.ino !== inspected.ino
    )
      throw new Error(`Source path changed while fingerprinting ${file}.`);
    return {
      bytes: await handle.readFile(),
      executable: (opened.mode & 0o111n) !== 0n,
    };
  } finally {
    await handle.close();
  }
}

function updateFingerprintField(digest, label, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  digest.update(label, "utf8");
  digest.update("\0");
  digest.update(String(bytes.length), "utf8");
  digest.update("\0");
  digest.update(bytes);
  digest.update("\0");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Returns the upstream planner's visible changed-source window, best effort. */
export async function repositoryChangedPaths(root, baseGitHead) {
  const ignore = await loadOpenWikiIgnore(root);
  const paths = new Set();
  if (baseGitHead)
    addGitLines(
      paths,
      git(root, ["diff", "--name-only", `${baseGitHead}..HEAD`]),
    );
  addGitLines(paths, git(root, ["diff", "--name-only", "HEAD"]));
  addGitLines(paths, git(root, ["ls-files", "--others", "--exclude-standard"]));
  return [...paths]
    .filter(
      (candidate) =>
        candidate &&
        candidate !== WIKI &&
        !candidate.startsWith(`${WIKI}/`) &&
        !ignore(candidate),
    )
    .sort();
}

function addGitLines(target, output) {
  for (const line of (output ?? "").split("\n")) {
    const normalized = line.trim().replace(/\\/gu, "/");
    if (normalized) target.add(normalized);
  }
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

export async function loadOpenWikiIgnore(root) {
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
    .filter((line) => line && !line.startsWith("#"))
    .map(compileIgnoreRule)
    .filter(Boolean);
  return (candidate) => {
    const normalized = normalizeIgnorePath(candidate);
    if (!normalized) return false;
    let ignored = false;
    for (let rule of rules) {
      if (rule.matches(normalized, false)) ignored = !rule.negated;
    }
    return ignored;
  };
}

function compileIgnoreRule(pattern) {
  let normalized = pattern.replace(/\\/gu, "/");
  const negated = normalized.startsWith("!");
  if (negated) normalized = normalized.slice(1);
  normalized = normalized.replace(/^\.\/+/u, "").replace(/\/+/gu, "/");
  const anchored = normalized.startsWith("/");
  const directoryOnly = normalized.endsWith("/");
  normalized = normalized.replace(/^\/+|\/+$/gu, "");
  if (!normalized) return null;
  const source = globToRegexSource(normalized);
  const matcher =
    anchored || normalized.includes("/")
      ? new RegExp(`^${source}(?:/.*)?$`, "iu")
      : new RegExp(`(^|/)${source}(/.*)?$`, "iu");
  return {
    negated,
    matches(candidate, isDirectory) {
      return (
        matcher.test(candidate) &&
        (!directoryOnly || isDirectory || candidate.includes("/"))
      );
    },
  };
}

function globToRegexSource(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (character === "*") {
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += escape(character);
  }
  return source;
}

function normalizeIgnorePath(value) {
  const slashed = value.replace(/\\/gu, "/");
  const normalized = path.posix.normalize(`/${slashed.replace(/^\/+/u, "")}`);
  return normalized.replace(/^\/+/u, "").replace(/\/+$/u, "");
}

function escape(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}
