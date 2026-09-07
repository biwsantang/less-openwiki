#!/usr/bin/env node

/** Thin Codex/Claude Code event adapter. Repository behavior lives in runtime/. */
import { repositoryRoot } from "../runtime/storage.mjs";
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
  const root = repositoryRoot(input.cwd ?? process.cwd());
  if (!root) process.exit(0);
  const result = await dispatch(root, input);
  if (result && Object.keys(result).length)
    process.stdout.write(`${JSON.stringify(normalize(result))}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ systemMessage: `Less OpenWiki: ${error instanceof Error ? error.message.replace(/\s+/gu, " ").slice(0, 500) : "lifecycle operation failed"}` })}\n`,
  );
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
  if (action === "session-start")
    result.hookSpecificOutput.hookEventName = "SessionStart";
  else if (action === "post-tool")
    result.hookSpecificOutput.hookEventName = "PostToolUse";
  return result;
}

function documentationRequest(event) {
  const prompt = String(event.prompt ?? event.user_prompt ?? "");
  const documentationTarget =
    /\b(openwiki|wiki|documentation|docs?|knowledge\s+base|onboarding\s+(?:guide|documentation)|(?:repository|project|codebase)\s+(?:guide|documentation|map))\b/iu.test(
      prompt,
    );
  const documentationAction =
    /\b(create|generate|initialize|initialise|update|refresh|maintain|document|build|write|resume|map)\b/iu.test(
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
