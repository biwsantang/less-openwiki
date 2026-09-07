import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveRepositoryEvidence } from "../../plugins/less-openwiki/runtime/evidence.mjs";
import { repositoryChangedPaths } from "../../plugins/less-openwiki/runtime/storage.mjs";
import { hash } from "../../plugins/less-openwiki/runtime/storage.mjs";

const engine = path.resolve(
  "plugins/less-openwiki/hooks/less-openwiki-hook.mjs",
);

test("native hooks accept a semantic plan, reconcile Claims, and finalize compatible state", async (t) => {
  const root = await fixture(t);
  const begin = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Initialize project documentation as a wiki.",
  });
  assert.match(begin.hookSpecificOutput.additionalContext, /plan intent/u);
  const runFile = path.join(root, "openwiki", ".run.json");
  let state = JSON.parse(await readFile(runFile, "utf8"));
  assert.equal(state.phase, "planning");
  assert.equal(state.previousLastUpdate, null);

  await writeJson(path.join(root, "openwiki", ".intents", "plan.json"), {
    pages: [
      {
        path: "architecture/overview.md",
        title: "Architecture",
        purpose: "Explain runtime ownership.",
        seedPaths: ["README.md"],
      },
      {
        path: "quickstart.md",
        title: "Quickstart",
        purpose: "Route readers to the architecture.",
      },
    ],
  });
  const plan = invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/.intents/plan.json" },
  });
  assert.match(plan.hookSpecificOutput.additionalContext, /accepted/u);
  state = JSON.parse(await readFile(runFile, "utf8"));
  assert.equal(state.phase, "generating");
  assert.deepEqual(
    state.plan.pages.map((page) => page.path),
    ["openwiki/architecture/overview.md", "openwiki/quickstart.md"],
  );

  const denied = invoke(root, "pre-tool", {
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/quickstart.md" },
  });
  assert.match(
    denied.hookSpecificOutput.permissionDecisionReason,
    /architecture/u,
  );

  for (const page of state.plan.pages.map((entry) => entry.path)) {
    await writeIntent(root, page, "README.md");
    const absolute = path.join(root, page);
    await mkdir(path.dirname(absolute), { recursive: true });
    const extra = page.includes("architecture")
      ? "\n[Broken](missing.md)\n\n```mermaid\nflowchart TD\nend[broken]\n```\n"
      : "";
    await writeFile(
      absolute,
      `---\ntype: concept\ntitle: ${path.basename(page, ".md")}\ndescription: Fixture documentation.\n---\n\n# Fixture\n${extra}`,
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
  assert.equal(claims.claims.length, 1);
  assert.match(claims.pageVersion, /^sha256:/u);
  const quickstart = await readFile(
    path.join(root, "openwiki", "quickstart.md"),
  );
  assert.equal(claims.pageVersion, hash(quickstart));
  const manifest = JSON.parse(
    await readFile(path.join(root, "openwiki", ".page-manifest.json"), "utf8"),
  );
  assert.ok(manifest.pages["/openwiki/quickstart.md"]);
  assert.match(
    await readFile(path.join(root, "openwiki", "quickstart.md"), "utf8"),
    /generated:/u,
  );
  assert.match(
    await readFile(path.join(root, "openwiki", "quickstart.md"), "utf8"),
    /verified:\n\s+- by: openwiki\/0\.5\.0/u,
  );
  const architecture = await readFile(
    path.join(root, "openwiki", "architecture", "overview.md"),
    "utf8",
  );
  assert.match(architecture, /broken internal link/u);
  assert.match(architecture, /```text/u);
});

test("repository evidence uses upstream V1 whole-file and relocating line-range versions", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "source.ts"),
    "before\nselected\nafter\n",
    "utf8",
  );
  const whole = await resolveRepositoryEvidence(root, "repo://source.ts");
  assert.match(whole.version, /^repo-file-v1:sha256:[a-f0-9]{64}$/u);
  const ranged = await resolveRepositoryEvidence(
    root,
    "repo://source.ts#L2-L2",
  );
  assert.match(ranged.version, /^repo-lines-v1:sha256:[a-f0-9]{64}:/u);
  await writeFile(
    path.join(root, "source.ts"),
    "new\nbefore\nselected\nafter\n",
    "utf8",
  );
  const relocated = await resolveRepositoryEvidence(
    root,
    "repo://source.ts#L2-L2",
    ranged.version,
  );
  assert.equal(relocated.version, ranged.version);
  assert.equal(relocated.content, "selected\n");
});

test("a changed documentation language requires every existing factual page to be planned", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    "---\ntype: concept\ntitle: Quickstart\ndescription: Existing.\n---\n\n# Quickstart\n",
    "utf8",
  );
  await writeJson(path.join(root, "openwiki", ".last-update.json"), {
    updatedAt: new Date().toISOString(),
    command: "update",
    model: "codex",
    status: "complete",
    language: "en",
  });
  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Update the documentation.",
  });
  await writeJson(path.join(root, "openwiki", ".intents", "plan.json"), {
    language: "fr",
    pages: [
      {
        path: "architecture.md",
        title: "Architecture",
        purpose: "Wrong incomplete plan.",
      },
    ],
  });
  const rejected = invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/.intents/plan.json" },
  });
  assert.match(rejected.systemMessage, /language change requires/u);
});

test("the update window contains visible committed and untracked source paths", async (t) => {
  const root = await fixture(t);
  execFileSync("git", ["config", "user.email", "fixture@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root });
  const base = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  await writeFile(
    path.join(root, "committed.ts"),
    "export const committed = true;\n",
    "utf8",
  );
  execFileSync("git", ["add", "committed.ts"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "source"], { cwd: root });
  await writeFile(
    path.join(root, "untracked.ts"),
    "export const untracked = true;\n",
    "utf8",
  );
  await writeFile(path.join(root, ".openwikiignore"), "ignored.ts\n", "utf8");
  await writeFile(path.join(root, "ignored.ts"), "secret\n", "utf8");
  assert.deepEqual(await repositoryChangedPaths(root, base), [
    ".openwikiignore",
    "committed.ts",
    "untracked.ts",
  ]);
});

test("an update is a no-op only with no visible source changes and no Claims debt", async (t) => {
  const root = await fixture(t);
  execFileSync("git", ["config", "user.email", "fixture@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    "---\ntype: concept\ntitle: Quickstart\ndescription: Existing.\n---\n\n# Quickstart\n",
    "utf8",
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  await writeJson(path.join(root, "openwiki", ".last-update.json"), {
    updatedAt: new Date().toISOString(),
    command: "update",
    gitHead: head,
    model: "openwiki/0.5.0",
    status: "complete",
    language: "en",
  });
  const noop = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Update the documentation.",
  });
  assert.match(noop.hookSpecificOutput.additionalContext, /current/u);
  await assert.rejects(
    readFile(path.join(root, "openwiki", ".run.json"), "utf8"),
  );
  await writeFile(path.join(root, "README.md"), "# Changed\n", "utf8");
  const active = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Update the documentation.",
  });
  assert.match(
    active.hookSpecificOutput.additionalContext,
    /Changed source paths: README.md/u,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(root, "openwiki", ".run.json"), "utf8"))
      .phase,
    "planning",
  );
});

test("source content drift is detected even when Git status stays modified", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "README.md"),
    "# Fixture changed once\n",
    "utf8",
  );
  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Create repository documentation.",
  });
  await writeFile(
    path.join(root, "README.md"),
    "# Fixture changed twice\n",
    "utf8",
  );
  const output = invoke(root, "pre-tool", {
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/quickstart.md" },
  });
  assert.match(
    output.hookSpecificOutput.permissionDecisionReason,
    /source changed/u,
  );
});

test("source drift invalidates a durable queue and returns the run to planning", async (t) => {
  const root = await fixture(t);
  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Create repository documentation.",
  });
  await writeJson(path.join(root, "openwiki", ".intents", "plan.json"), {
    pages: [
      { path: "quickstart.md", title: "Quickstart", purpose: "Route readers." },
    ],
  });
  invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/.intents/plan.json" },
  });
  await writeFile(path.join(root, "README.md"), "# Changed source\n", "utf8");
  invoke(root, "pre-tool", {
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/quickstart.md" },
  });
  const state = JSON.parse(
    await readFile(path.join(root, "openwiki", ".run.json"), "utf8"),
  );
  assert.equal(state.phase, "planning");
  assert.equal(state.plan, undefined);
  const resume = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Resume documentation.",
  });
  assert.match(resume.hookSpecificOutput.additionalContext, /semantic plan/u);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "less-openwiki-hook-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# Fixture\n", "utf8");
  return root;
}

async function writeIntent(root, page, evidencePath) {
  await writeJson(
    path.join(
      root,
      "openwiki",
      ".intents",
      page.replace(/^openwiki\//u, "").replace(/\.md$/u, ".json"),
    ),
    {
      claims: [
        {
          statement: `${page} documents the fixture.`,
          evidence: [{ resource: `repo://${evidencePath}` }],
        },
      ],
    },
  );
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

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
