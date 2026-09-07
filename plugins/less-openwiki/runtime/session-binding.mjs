import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readJson, runPath, writeJson } from "./storage.mjs";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function bindSession(root, input, runId) {
  const sessionId = sessionIdFor(input);
  if (!sessionId) return;
  await writeJson(bindingPath(sessionId), {
    schemaVersion: 1,
    sessionId,
    root,
    runId,
    createdAt: new Date().toISOString(),
  });
}

export async function boundSessionRoot(input) {
  const binding = await bindingFor(input);
  if (!binding) return null;
  return binding.root;
}

/**
 * Preserves the structured documentation targets from PreToolUse until the
 * matching PostToolUse event. Some Codex tool wrappers omit their nested file
 * operation from the post-event payload, even though it was available before
 * the write.
 */
export async function recordSessionTargets(input, targets) {
  const sessionId = sessionIdFor(input);
  const binding = await bindingFor(input);
  if (!sessionId || !binding || !validTargets(targets)) return;
  await writeJson(bindingPath(sessionId), {
    ...binding,
    pendingTargets: targets,
  });
}

/**
 * Returns and clears the target handoff so a later unrelated post-event cannot
 * checkpoint an earlier documentation write.
 */
export async function consumeSessionTargets(input) {
  const sessionId = sessionIdFor(input);
  const binding = await bindingFor(input);
  if (!sessionId || !binding) return [];
  const targets = validTargets(binding.pendingTargets)
    ? binding.pendingTargets
    : [];
  if (Object.hasOwn(binding, "pendingTargets")) {
    const { pendingTargets: _pendingTargets, ...rest } = binding;
    await writeJson(bindingPath(sessionId), rest);
  }
  return targets;
}

export async function clearSessionBinding(input) {
  const sessionId = sessionIdFor(input);
  if (sessionId) await rm(bindingPath(sessionId), { force: true });
}

function bindingPath(sessionId) {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return path.join(
    process.env.LESS_OPENWIKI_STATE_DIR ?? tmpdir(),
    "less-openwiki-sessions",
    `${digest}.json`,
  );
}

async function bindingFor(input) {
  const sessionId = sessionIdFor(input);
  if (!sessionId) return null;
  const file = bindingPath(sessionId);
  const binding = await readJson(file);
  if (
    !valid(binding, sessionId) ||
    Date.now() - Date.parse(binding.createdAt) > MAX_AGE_MS
  ) {
    await rm(file, { force: true });
    return null;
  }
  const run = await readJson(runPath(binding.root));
  if (!run || run.runId !== binding.runId) {
    await rm(file, { force: true });
    return null;
  }
  return binding;
}

function sessionIdFor(input) {
  return typeof input.session_id === "string" && input.session_id.trim()
    ? input.session_id
    : typeof input.sessionId === "string" && input.sessionId.trim()
      ? input.sessionId
      : null;
}

function valid(value, sessionId) {
  return (
    value &&
    typeof value === "object" &&
    value.schemaVersion === 1 &&
    value.sessionId === sessionId &&
    typeof value.root === "string" &&
    typeof value.runId === "string" &&
    typeof value.createdAt === "string" &&
    (value.pendingTargets === undefined || validTargets(value.pendingTargets))
  );
}

function validTargets(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((target) => typeof target === "string" && target)
  );
}
