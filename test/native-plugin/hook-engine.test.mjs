import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
  assert.equal(claims.claims.length, 1);
  assert.match(claims.pageVersion, /^sha256:/u);
  const manifest = JSON.parse(
    await readFile(path.join(root, "openwiki", ".page-manifest.json"), "utf8"),
  );
  assert.ok(manifest.pages["/openwiki/quickstart.md"]);
  assert.match(
    await readFile(path.join(root, "openwiki", "quickstart.md"), "utf8"),
    /generated:/u,
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
