import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const engine = path.resolve(
  "plugins/less-openwiki/hooks/less-openwiki-hook.mjs",
);

test("the hook engine checkpoints, validates, resumes, and finalizes a documentation run", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "less-openwiki-hook-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# Fixture\n", "utf8");

  const begin = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Initialize project documentation as a wiki.",
  });
  assert.match(begin.hookSpecificOutput.additionalContext, /started/u);

  const runFile = path.join(root, "openwiki", ".run.json");
  let state = JSON.parse(await readFile(runFile, "utf8"));
  assert.equal(state.mode, "init");
  assert.deepEqual(
    state.plan.pages.map((page) => page.path),
    [
      "openwiki/quickstart.md",
      "openwiki/architecture/overview.md",
      "openwiki/testing/overview.md",
    ],
  );

  const denied = invoke(root, "pre-tool", {
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/testing/overview.md" },
  });
  assert.match(
    denied.hookSpecificOutput.permissionDecisionReason,
    /quickstart/u,
  );

  const firstPage = path.join(root, "openwiki", "quickstart.md");
  await mkdir(path.dirname(firstPage), { recursive: true });
  await writeFile(firstPage, "# Incomplete\n", "utf8");
  const restored = invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/quickstart.md" },
  });
  assert.match(restored.systemMessage, /restored/u);
  await assert.rejects(readFile(firstPage, "utf8"));

  for (const page of state.plan.pages.map((entry) => entry.path)) {
    const absolute = path.join(root, page);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(
      absolute,
      `---\ntype: concept\ntitle: ${path.basename(page, ".md")}\ndescription: Fixture documentation.\n---\n\n# Fixture\n`,
      "utf8",
    );
    const result = invoke(root, "post-tool", {
      hook_event_name: "PostToolUse",
      cwd: root,
      tool_input: { file_path: page },
    });
    assert.match(result.hookSpecificOutput.additionalContext, /Recorded/u);
  }

  const final = invoke(root, "stop", { hook_event_name: "Stop", cwd: root });
  assert.match(final.systemMessage, /complete/u);
  await assert.rejects(readFile(runFile, "utf8"));
  const claims = JSON.parse(
    await readFile(
      path.join(root, "openwiki", ".claims", "quickstart.json"),
      "utf8",
    ),
  );
  assert.equal(claims.schemaVersion, 1);
  assert.match(claims.pageVersion, /^sha256:/u);
  const manifest = JSON.parse(
    await readFile(path.join(root, "openwiki", ".page-manifest.json"), "utf8"),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.pages["/openwiki/quickstart.md"]);
});

test("the hook engine preserves an interrupted checkpoint when source drifts", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "less-openwiki-hook-drift-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# Fixture\n", "utf8");
  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Create repository documentation.",
  });
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "changed.js"), "export {};\n", "utf8");
  const output = invoke(root, "pre-tool", {
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/quickstart.md" },
  });
  assert.match(
    output.hookSpecificOutput.permissionDecisionReason,
    /source changed/u,
  );
  const state = JSON.parse(
    await readFile(path.join(root, "openwiki", ".run.json"), "utf8"),
  );
  assert.equal(state.phase, "interrupted");
  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Update the repository documentation after the source change.",
  });
  const restarted = JSON.parse(
    await readFile(path.join(root, "openwiki", ".run.json"), "utf8"),
  );
  assert.equal(restarted.phase, "generating");
  assert.notEqual(restarted.runId, state.runId);
});

function invoke(cwd, action, input) {
  const result = spawnSync(process.execPath, [engine, action], {
    cwd,
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: path.dirname(path.dirname(engine)),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}
