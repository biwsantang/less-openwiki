#!/usr/bin/env node

/** Thin Codex/Claude Code event adapter. Repository behavior lives in runtime/. */
import {
  boundSessionRoot,
  clearSessionBinding,
  consumeSessionTargets,
  recordSessionTargets,
} from "../runtime/session-binding.mjs";
import {
  resolveTargetRepository,
  sessionRepository,
} from "../runtime/target-resolver.mjs";
import {
  checkpoint,
  finish,
  guardWrite,
  interrupt,
  sessionContext,
  startOrResume,
} from "../runtime/lifecycle.mjs";

const action = process.argv[2] ?? "";
const input = await readInput();

try {
  const target = resolveTargetRepository(input);
  if (target.error) {
    if (action === "pre-tool")
      process.stdout.write(`${JSON.stringify(deny(target.error))}\n`);
    process.exit(0);
  }
  const bound = await boundSessionRoot(input);
  if (bound && target.root && bound !== target.root) {
    if (action === "pre-tool")
      process.stdout.write(
        `${JSON.stringify(deny("Less OpenWiki already has an active repository for this task. Finish or interrupt that run before targeting another repository."))}\n`,
      );
    process.exit(0);
  }
  const root = target.root ?? bound ?? sessionRepository(input);
  if (!root) process.exit(0);
  const deferredTargets =
    action === "post-tool" && target.targets.length === 0
      ? await consumeSessionTargets(input)
      : [];
  if (action === "post-tool" && target.targets.length > 0)
    await consumeSessionTargets(input);
  const event = deferredTargets.length
    ? {
        ...input,
        tool_input: {
          ...(input.tool_input ?? input.toolInput ?? {}),
          file_path: deferredTargets[0],
        },
      }
    : input;
  const result = await dispatch(root, event);
  if (action === "pre-tool" && target.targets.length > 0)
    await recordSessionTargets(input, target.targets);
  if (
    action === "session-end" ||
    (action === "stop" && result && result.continue !== false)
  )
    await clearSessionBinding(input);
  if (result && Object.keys(result).length)
    process.stdout.write(`${JSON.stringify(normalize(result))}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ systemMessage: `Less OpenWiki: ${error instanceof Error ? error.message.replace(/\s+/gu, " ").slice(0, 500) : "lifecycle operation failed"}` })}\n`,
  );
}

function deny(permissionDecisionReason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason,
    },
  };
}

async function dispatch(root, event) {
  switch (action) {
    case "session-start":
      return sessionContext(root);
    case "user-prompt":
      return documentationRequest(event)
        ? startOrResume(root, event)
        : sessionContext(root);
    case "pre-tool":
      return guardWrite(root, event);
    case "post-tool":
      return checkpoint(root, event);
    case "stop":
      return finish(root);
    case "session-end":
      return interrupt(root);
    default:
      return {};
  }
}

function normalize(result) {
  if (!result.hookSpecificOutput) return result;
  const events = {
    "session-start": "SessionStart",
    "user-prompt": "UserPromptSubmit",
    "pre-tool": "PreToolUse",
    "post-tool": "PostToolUse",
  };
  if (events[action]) result.hookSpecificOutput.hookEventName = events[action];
  return result;
}

function documentationRequest(event) {
  const prompt = String(event.prompt ?? event.user_prompt ?? "");
  const documentationTarget =
    /\b(openwiki|wiki|documentation|docs?|knowledge\s+base|onboarding\s+(?:guide|documentation)|(?:repository|project|codebase)\s+(?:guide|documentation|map))\b/iu.test(
      prompt,
    );
  const documentationAction =
    /\b(add|build|create|document|generate|improve|initialize|initialise|maintain|map|migrate|refresh|repair|resume|revise|translate|update|validate|write)\b/iu.test(
      prompt,
    );
  return documentationTarget && documentationAction;
}

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}
