#!/usr/bin/env node

/**
 * Native lifecycle engine for Less OpenWiki.
 *
 * This module is deliberately dependency-free: hooks run in the user's coding
 * agent process environment, where the plugin cannot assume a package manager
 * install. It owns only deterministic state, validation, indexes, Claims
 * sidecars, provenance, and resumability. The accompanying skill owns research
 * and explanatory writing.
 */

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

const action = process.argv[2] ?? "";
const input = await readHookInput();

try {
  const root = repositoryRoot(input.cwd ?? process.cwd());
  if (!root) process.exit(0);
  const result = await dispatch(action, root, input);
  emit(result, input);
} catch (error) {
  // A lifecycle hook must never hide the host's original tool result. Surface a
  // concise actionable warning and leave the durable checkpoint untouched.
  emit({ systemMessage: `Less OpenWiki: ${safeError(error)}` }, input);
}

async function dispatch(currentAction, root, input) {
  switch (currentAction) {
    case "session-start":
      return sessionContext(root);
    case "user-prompt":
      return handlePrompt(root, input);
    case "pre-tool":
      return preTool(root, input);
    case "post-tool":
      return postTool(root, input);
    case "stop":
      return stop(root);
    case "interrupt":
    case "session-end":
      return interrupt(root);
    default:
      return {
        systemMessage: "Less OpenWiki: unknown lifecycle event ignored.",
      };
  }
}

async function sessionContext(root) {
  const state = await readJson(runPath(root));
  if (!state) return {};
  if (state.phase === "interrupted") {
    return context(
      `A documentation run (${state.runId}) is interrupted. Resume its pending pages before starting a new documentation request. ${pendingSummary(state)}`,
    );
  }
  return context(
    `A documentation run (${state.runId}) is active. ${pendingSummary(state)}`,
  );
}

async function handlePrompt(root, input) {
  const active = await readJson(runPath(root));
  const prompt = String(input.prompt ?? input.user_prompt ?? "");
  if (
    active &&
    !(
      active.phase === "interrupted" &&
      active.invalidatedAt &&
      isDocumentationRequest(prompt)
    )
  ) {
    return sessionContext(root);
  }
  if (!isDocumentationRequest(prompt)) return {};

  const wikiExists = await isDirectory(path.join(root, "openwiki"));
  const mode = wikiExists ? "update" : "init";
  const fingerprint = await sourceFingerprint(root);
  const lastUpdate = await readJson(lastUpdatePath(root));
  if (
    mode === "update" &&
    lastUpdate?.status === "complete" &&
    lastUpdate.sourceFingerprint === fingerprint
  ) {
    return context(
      "Documentation is already current for the repository source. Inspect the existing pages and report the no-change result.",
    );
  }

  const state = await beginRun(root, mode, fingerprint, input);
  return context(
    `Documentation run ${state.runId} started. Work only on the queued page shown below. After each Markdown write, the lifecycle records validation and advances the queue. ${pendingSummary(state)}`,
  );
}

async function preTool(root, input) {
  const state = await readJson(runPath(root));
  if (!state) return {};
  if ((await sourceFingerprint(root)) !== state.sourceFingerprint) {
    state.phase = "interrupted";
    state.invalidatedAt = now();
    await writeJson(runPath(root), state);
    return deny(
      "Repository source changed during this documentation run. Start a fresh documentation update before writing generated pages.",
      input,
    );
  }
  const targets = extractTargets(input, root);
  const protectedTarget = targets.find(isOwnedStatePath);
  if (protectedTarget) {
    return deny(
      `The documentation lifecycle owns ${relative(root, protectedTarget)}. Edit the assigned Markdown page instead; the lifecycle writes its state and Claims records.`,
      input,
    );
  }
  const wikiTargets = targets.filter((candidate) =>
    isWikiMarkdown(root, candidate),
  );
  if (wikiTargets.length === 0) return {};
  const current = currentJob(state);
  if (!current) {
    return deny(
      "The documentation queue is complete. Do not change generated pages outside a new documentation run.",
      input,
    );
  }
  const unauthorized = wikiTargets.find(
    (candidate) => relative(root, candidate) !== current.path,
  );
  if (unauthorized) {
    return deny(
      `The current documentation page is ${current.path}; do not write ${relative(root, unauthorized)} before it is complete.`,
      input,
    );
  }
  return {};
}

async function postTool(root, input) {
  const state = await readJson(runPath(root));
  if (!state) return {};
  const targets = extractTargets(input, root);
  const current = currentJob(state);
  if (!current) return {};
  const currentPath = path.join(root, current.path);
  const wroteCurrent = targets.includes(currentPath);
  if (!wroteCurrent) return {};

  if ((await sourceFingerprint(root)) !== state.sourceFingerprint) {
    state.phase = "interrupted";
    state.invalidatedAt = now();
    await writeJson(runPath(root), state);
    return {
      systemMessage:
        "Less OpenWiki: repository source changed during the run. The documentation queue was preserved for replanning.",
    };
  }

  const validation = await validatePage(root, current.path);
  if (!validation.ok) {
    await rollbackPage(root, state, current.path);
    return {
      systemMessage: `Less OpenWiki: ${current.path} was restored to its prior checkpoint because it is not ready: ${validation.errors.join(" ")}`,
    };
  }

  await synchronizeClaims(root, current.path, state);
  current.status = "complete";
  current.completedBy = actorFor(input);
  await writeJson(runPath(root), state);
  return context(`Recorded ${current.path}. ${pendingSummary(state)}`);
}

async function stop(root) {
  const state = await readJson(runPath(root));
  if (!state) return {};
  const current = currentJob(state);
  if (current) {
    return {
      continue: false,
      stopReason: `Documentation remains incomplete: ${current.path}.`,
      systemMessage: `Less OpenWiki requires the assigned page before completion. ${pendingSummary(state)}`,
    };
  }
  await finalize(root, state);
  return {
    systemMessage: "Less OpenWiki documentation run is complete and validated.",
  };
}

async function interrupt(root) {
  const state = await readJson(runPath(root));
  if (!state) return {};
  state.phase = "interrupted";
  state.interruptedAt = now();
  await writeJson(runPath(root), state);
  await writeJson(lastUpdatePath(root), {
    updatedAt: now(),
    command: state.mode,
    gitHead: git(root, ["rev-parse", "HEAD"]) ?? undefined,
    model: state.actor?.metadataModel ?? "native-agent",
    status: "interrupted",
    sourceFingerprint: state.sourceFingerprint,
  });
  return {};
}

async function beginRun(root, mode, fingerprint, input) {
  const existingPages = await factualPages(root);
  const pagePaths =
    mode === "init" && existingPages.length === 0
      ? defaultInitPages(root)
      : existingPages.map((file) => relative(root, file));
  const state = {
    schemaVersion: 1,
    runId: randomUUID(),
    mode,
    phase: "generating",
    startedAt: now(),
    language: "en",
    languageChanged: false,
    requiredRewritePages: [],
    initialPages: existingPages.map((file) => `/${relative(root, file)}`),
    sourceFingerprint: fingerprint,
    targetGitHead: git(root, ["rev-parse", "HEAD"]) ?? undefined,
    actor: { producerActor: actorFor(input), metadataModel: modelFor(input) },
    beforeContentSnapshot: await wikiFingerprint(root),
    preparedWiki: { generatedProvenance: [] },
    plan: {
      pages: pagePaths.map((page) => pageJob(page)),
      deletePages: [],
    },
    rollback: await createRollback(root, existingPages),
  };
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  await writeJson(runPath(root), state);
  return state;
}

function defaultInitPages(root) {
  // A small canonical bootstrap remains useful in every repository. The skill
  // supplies the research and can extend future runs with additional pages.
  return [
    "openwiki/quickstart.md",
    "openwiki/architecture/overview.md",
    "openwiki/testing/overview.md",
  ];
}

function pageJob(page) {
  const title = path.basename(page, ".md").replace(/[-_]/gu, " ");
  return {
    id: randomUUID(),
    path: page,
    title: title.slice(0, 1).toUpperCase() + title.slice(1),
    purpose: `Document ${page}.`,
    seedPaths: [],
    relatedPages: [],
    instructions: [],
    status: "pending",
  };
}

async function finalize(root, state) {
  const latestFingerprint = await sourceFingerprint(root);
  if (latestFingerprint !== state.sourceFingerprint) {
    state.phase = "interrupted";
    state.invalidatedAt = now();
    await writeJson(runPath(root), state);
    throw new Error(
      "repository source changed during the documentation run; the pending work must be replanned",
    );
  }
  const pages = await factualPages(root);
  const errors = [];
  for (const page of pages) {
    const result = await validatePage(root, relative(root, page));
    if (!result.ok) errors.push(...result.errors);
    else await synchronizeClaims(root, relative(root, page), state);
  }
  if (errors.length > 0) throw new Error(errors.join(" "));
  await synchronizeIndexes(root);
  await writeManifest(root, pages, state);
  await writeJson(lastUpdatePath(root), {
    updatedAt: now(),
    command: state.mode,
    gitHead: git(root, ["rev-parse", "HEAD"]) ?? undefined,
    model: state.actor.metadataModel,
    status: "complete",
    language: state.language,
    sourceFingerprint: state.sourceFingerprint,
  });
  await rm(runPath(root), { force: true });
  const rollback = rollbackRoot(root, state);
  if (rollback) await rm(rollback, { recursive: true, force: true });
}

async function synchronizeClaims(root, page, state) {
  if (!isFactualRelativePage(page)) return;
  const markdown = path.join(root, page);
  const sidecar = path.join(
    root,
    "openwiki",
    ".claims",
    page.slice("openwiki/".length).replace(/\.md$/u, ".json"),
  );
  const existing = await readJson(sidecar);
  const content = await readFile(markdown);
  const claims = Array.isArray(existing?.claims) ? existing.claims : [];
  await writeJson(sidecar, {
    schemaVersion: 1,
    pageVersion: hash(content),
    claims,
    ...(claims.length > 0
      ? { verification: { by: state.actor.producerActor, at: now() } }
      : {}),
  });
}

async function writeManifest(root, pages, state) {
  const entries = {};
  for (const file of pages) {
    const page = relative(root, file);
    if (!isFactualRelativePage(page)) continue;
    entries[`/${page}`] = {
      gitHead: state.targetGitHead,
      sourceFingerprint: state.sourceFingerprint,
      pageVersion: hash(await readFile(file)),
      completedBy: state.actor.producerActor,
      completedRunId: state.runId,
    };
  }
  await writeJson(path.join(root, "openwiki", ".page-manifest.json"), {
    schemaVersion: 1,
    pages: entries,
  });
}

async function synchronizeIndexes(root) {
  const wikiRoot = path.join(root, "openwiki");
  const directories = await markdownDirectories(wikiRoot);
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true });
    const links = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          entry.name !== "index.md" &&
          !entry.name.startsWith("."),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (entry) =>
          `- [${pageTitle(entry.name)}](${encodeURIComponent(entry.name)})`,
      );
    const childLinks = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (entry) =>
          `- [${pageTitle(entry.name)}](${encodeURIComponent(entry.name)}/)`,
      );
    if (links.length === 0 && childLinks.length === 0) continue;
    const name = relative(wikiRoot, directory) || "Documentation";
    await writeFile(
      path.join(directory, "index.md"),
      `---\ntype: index\ntitle: ${pageTitle(name)}\ndescription: Documentation navigation.\n---\n\n# ${pageTitle(name)}\n\n${[...childLinks, ...links].join("\n")}\n`,
      "utf8",
    );
  }
}

async function validatePage(root, page) {
  const file = path.join(root, page);
  const errors = [];
  if (!(await isFile(file)))
    return { ok: false, errors: [`${page} does not exist.`] };
  const content = await readFile(file, "utf8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/u);
  if (!match) errors.push(`${page} is missing YAML front matter.`);
  else
    for (const field of ["type", "title", "description"]) {
      if (!new RegExp(`^${field}:\\s*\\S`, "mu").test(match[1]))
        errors.push(`${page} is missing '${field}' front matter.`);
    }
  return { ok: errors.length === 0, errors };
}

function currentJob(state) {
  const current =
    state?.plan?.pages?.find((job) => job.status === "pending") ?? null;
  if (current && !isSafeRelativeWikiPage(current.path)) {
    throw new Error("documentation run contains an unsafe page path");
  }
  return current;
}

function pendingSummary(state) {
  const pending =
    state.plan?.pages?.filter((job) => job.status === "pending") ?? [];
  if (pending.length === 0)
    return "All queued pages are complete; finish the run.";
  return `Current page: ${pending[0].path}. ${pending.length - 1} page(s) remain after it.`;
}

function extractTargets(input, root) {
  const raw = [];
  const tool = input.tool_input ?? input.toolInput ?? {};
  for (const key of ["file_path", "path", "file", "target_file"])
    if (typeof tool[key] === "string") raw.push(tool[key]);
  for (const key of [
    "patch",
    "command",
    "new_string",
    "old_string",
    "content",
  ]) {
    if (typeof tool[key] !== "string") continue;
    raw.push(
      ...[
        ...tool[key].matchAll(
          /(?:^|[\s'"`])((?:\.?\/?[\w@+=:,.-]+\/)*openwiki\/[\w@+=:,./-]+\.md)/gmu,
        ),
      ].map((match) => match[1]),
    );
  }
  return [
    ...new Set(
      raw
        .map((candidate) => path.resolve(root, candidate))
        .filter((candidate) => isWithin(root, candidate)),
    ),
  ];
}

function isOwnedStatePath(candidate) {
  const basename = path.basename(candidate);
  return (
    candidate.includes(`${path.sep}openwiki${path.sep}.claims${path.sep}`) ||
    [".run.json", ".last-update.json", ".page-manifest.json"].includes(basename)
  );
}

function isWikiMarkdown(root, candidate) {
  return (
    isWithin(path.join(root, "openwiki"), candidate) &&
    candidate.endsWith(".md") &&
    !candidate.includes(`${path.sep}.claims${path.sep}`)
  );
}

function isFactualRelativePage(page) {
  const basename = path.basename(page).toLowerCase();
  return (
    page.startsWith("openwiki/") &&
    page.endsWith(".md") &&
    !["index.md", "log.md", "instructions.md"].includes(basename) &&
    !page.includes("/.claims/")
  );
}

function isSafeRelativeWikiPage(page) {
  if (typeof page !== "string" || !page.startsWith("openwiki/")) return false;
  const normalized = path.posix.normalize(page.replace(/\\/gu, "/"));
  return (
    normalized === page &&
    normalized.endsWith(".md") &&
    !normalized.includes("/../") &&
    !normalized.includes("/.claims/")
  );
}

async function factualPages(root) {
  const wikiRoot = path.join(root, "openwiki");
  if (!(await isDirectory(wikiRoot))) return [];
  return (await markdownFiles(wikiRoot)).filter((file) =>
    isFactualRelativePage(relative(root, file)),
  );
}

async function markdownDirectories(root) {
  if (!(await isDirectory(root))) return [];
  const result = [root];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith("."))
      result.push(...(await markdownDirectories(path.join(root, entry.name))));
  }
  return result.sort((a, b) => a.localeCompare(b));
}

async function markdownFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...(await markdownFiles(file)));
    else if (entry.isFile() && entry.name.endsWith(".md")) result.push(file);
  }
  return result.sort((a, b) => a.localeCompare(b));
}

async function createRollback(root, pages) {
  const directory = path.join(root, "openwiki", ".rollback", randomUUID());
  await mkdir(directory, { recursive: true });
  for (const page of pages) {
    const destination = path.join(
      directory,
      relative(path.join(root, "openwiki"), page),
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(page));
  }
  return { path: directory, pages: pages.map((page) => relative(root, page)) };
}

async function rollbackPage(root, state, page) {
  const target = path.join(root, page);
  const rollback = rollbackRoot(root, state);
  const backup = rollback
    ? path.join(rollback, page.slice("openwiki/".length))
    : null;
  if (backup && (await isFile(backup))) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(backup));
  } else {
    await rm(target, { force: true });
  }
}

async function sourceFingerprint(root) {
  const status =
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) ?? "";
  const relevant = status
    .split("\n")
    .filter((line) => line && !line.includes(" openwiki/"))
    .join("\n");
  const head = git(root, ["rev-parse", "HEAD"]) ?? "unborn";
  return hash(`${head}\n${relevant}`);
}

async function wikiFingerprint(root) {
  const pages = await factualPages(root);
  const entries = await Promise.all(
    pages.map(
      async (file) => `${relative(root, file)}:${hash(await readFile(file))}`,
    ),
  );
  return hash(entries.sort().join("\n"));
}

function repositoryRoot(cwd) {
  const output = git(cwd, ["rev-parse", "--show-toplevel"]);
  return output ? path.resolve(output) : null;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function isDirectory(file) {
  try {
    return (await lstat(file)).isDirectory();
  } catch {
    return false;
  }
}
async function isFile(file) {
  try {
    return (await lstat(file)).isFile();
  } catch {
    return false;
  }
}
function runPath(root) {
  return path.join(root, "openwiki", ".run.json");
}
function rollbackRoot(root, state) {
  const base = path.join(root, "openwiki", ".rollback");
  const candidate = state?.rollback?.path;
  if (typeof candidate !== "string") return null;
  const resolved = path.resolve(candidate);
  return isWithin(base, resolved) && resolved !== base ? resolved : null;
}
function lastUpdatePath(root) {
  return path.join(root, "openwiki", ".last-update.json");
}
function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function now() {
  return new Date().toISOString();
}
function relative(root, candidate) {
  return path.relative(root, candidate).replace(/\\/gu, "/");
}
function isWithin(root, candidate) {
  const result = path.relative(root, candidate);
  return (
    result === "" || (!result.startsWith("..") && !path.isAbsolute(result))
  );
}
function pageTitle(value) {
  return value
    .split(/[\\/]/u)
    .map((part) =>
      part
        .replace(/[-_]/gu, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase()),
    )
    .join(" / ");
}
function modelFor(input) {
  return String(
    input.model ?? (process.env.CLAUDE_PLUGIN_ROOT ? "claude-code" : "codex"),
  );
}
function actorFor(input) {
  return process.env.CLAUDE_PLUGIN_ROOT ? "claude-code" : "codex";
}
function safeError(error) {
  return error instanceof Error
    ? error.message.replace(/\s+/gu, " ").slice(0, 500)
    : "lifecycle operation failed";
}
function isDocumentationRequest(prompt) {
  return (
    /\b(openwiki|wiki|documentation|docs?)\b/iu.test(prompt) &&
    /\b(create|generate|initialize|initialise|update|refresh|maintain|document|build|write)\b/iu.test(
      prompt,
    )
  );
}
function context(additionalContext) {
  const hookEventName =
    action === "session-start"
      ? "SessionStart"
      : action === "post-tool"
        ? "PostToolUse"
        : "UserPromptSubmit";
  return { hookSpecificOutput: { hookEventName, additionalContext } };
}
function deny(message, input) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: message,
    },
  };
}
function emit(result, input) {
  if (!result || Object.keys(result).length === 0) return;
  // Codex accepts the common output envelope; Claude accepts the same context
  // envelope plus its PreToolUse permission decision above.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
