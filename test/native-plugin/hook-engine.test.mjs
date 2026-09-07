import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  preflightClaims,
  reconcileClaims,
} from "../../plugins/less-openwiki/runtime/claims.mjs";
import { resolveRepositoryEvidence } from "../../plugins/less-openwiki/runtime/evidence.mjs";
import { finish } from "../../plugins/less-openwiki/runtime/lifecycle.mjs";
import {
  finalizeGeneratedProvenance,
  finalizePage,
  finalizeWiki,
  normalizePageOkf,
  normalizeWikiOkf,
  synchronizeClaimSources,
  synchronizeClaimsVerification,
  validateOkfFrontmatter,
} from "../../plugins/less-openwiki/runtime/okf.mjs";
import {
  hash,
  repositoryChangedPaths,
  sourceSnapshot,
} from "../../plugins/less-openwiki/runtime/storage.mjs";

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
  const startedAt = state.startedAt;
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
  assert.match(
    plan.hookSpecificOutput.additionalContext,
    /Title: Architecture\. Purpose: Explain runtime ownership\./u,
  );
  assert.match(
    plan.hookSpecificOutput.additionalContext,
    /Research seed paths: README\.md\. Related pages: none specified\./u,
  );
  state = JSON.parse(await readFile(runFile, "utf8"));
  assert.equal(state.phase, "generating");
  assert.deepEqual(
    state.plan.pages.map((page) => page.path),
    ["openwiki/architecture/overview.md", "openwiki/quickstart.md"],
  );
  const resumedContext = invoke(root, "session-start", {
    hook_event_name: "SessionStart",
    cwd: root,
  });
  assert.match(
    resumedContext.hookSpecificOutput.additionalContext,
    /Current page: openwiki\/architecture\/overview\.md\. Title: Architecture\./u,
  );
  assert.match(
    resumedContext.hookSpecificOutput.additionalContext,
    /Purpose: Explain runtime ownership\. Research seed paths: README\.md\./u,
  );
  assert.match(
    resumedContext.hookSpecificOutput.additionalContext,
    /Existing Claims: 0\. Claims requiring attention: none\./u,
  );
  assert.deepEqual(
    invoke(root, "post-tool", {
      hook_event_name: "PostToolUse",
      cwd: root,
      tool_name: "Read",
      tool_input: { file_path: "openwiki/architecture/overview.md" },
    }),
    {},
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
  const camelCaseDenied = invoke(root, "pre-tool", {
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_input: { filePath: "openwiki/quickstart.md" },
  });
  assert.match(
    camelCaseDenied.hookSpecificOutput.permissionDecisionReason,
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
    assert.match(
      await readFile(absolute, "utf8"),
      /verified:\n\s+- by: openwiki\/0\.2\.0/u,
    );
    const checkpointManifest = JSON.parse(
      await readFile(
        path.join(root, "openwiki", ".page-manifest.json"),
        "utf8",
      ),
    );
    assert.ok(checkpointManifest.pages[`/${page}`]);
  }
  await writeFile(
    path.join(root, "openwiki", "abandoned.md"),
    "---\ntype: concept\ntitle: Abandoned\n---\n\n# Abandoned\n",
    "utf8",
  );

  const final = invoke(root, "stop", { hook_event_name: "Stop", cwd: root });
  assert.match(final.systemMessage, /complete/u);
  await assert.rejects(readFile(runFile, "utf8"));
  await assert.rejects(
    readFile(path.join(root, "openwiki", "abandoned.md"), "utf8"),
  );
  const claims = JSON.parse(
    await readFile(
      path.join(root, "openwiki", ".claims", "quickstart.json"),
      "utf8",
    ),
  );
  assert.equal(claims.schemaVersion, 1);
  assert.equal(claims.claims.length, 1);
  assert.equal(claims.verification.at, startedAt);
  assert.match(claims.pageVersion, /^sha256:/u);
  const quickstart = await readFile(
    path.join(root, "openwiki", "quickstart.md"),
    "utf8",
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
  assert.match(quickstart, new RegExp(`at: ${startedAt}`, "u"));
  assert.match(
    await readFile(path.join(root, "openwiki", "quickstart.md"), "utf8"),
    /verified:\n\s+- by: openwiki\/0\.2\.0/u,
  );
  assert.equal(
    await readFile(path.join(root, "openwiki", "index.md"), "utf8"),
    '---\nokf_version: "0.2"\n---\n\n# Files\n\n- [quickstart](quickstart.md) - Fixture documentation.\n\n# Directories\n\n- [architecture](architecture/)\n',
  );
  assert.equal(
    await readFile(
      path.join(root, "openwiki", "architecture", "index.md"),
      "utf8",
    ),
    "# Files\n\n- [overview](overview.md) - Fixture documentation.\n",
  );
  const architecture = await readFile(
    path.join(root, "openwiki", "architecture", "overview.md"),
    "utf8",
  );
  const architectureClaims = JSON.parse(
    await readFile(
      path.join(root, "openwiki", ".claims", "architecture", "overview.json"),
      "utf8",
    ),
  );
  assert.equal(architectureClaims.pageVersion, hash(architecture));
  assert.match(architecture, /broken internal link/u);
  assert.match(architecture, /```text/u);
});

test("the native hook runs from an isolated plugin package", async (t) => {
  const root = await fixture(t);
  const packageRoot = await mkdtemp(
    path.join(os.tmpdir(), "less-openwiki-package-"),
  );
  t.after(() => rm(packageRoot, { recursive: true, force: true }));
  const isolated = path.join(packageRoot, "less-openwiki");
  await cp(path.dirname(path.dirname(engine)), isolated, { recursive: true });

  const result = invoke(
    root,
    "user-prompt",
    {
      hook_event_name: "UserPromptSubmit",
      cwd: root,
      prompt: "Initialize repository documentation.",
    },
    path.join(isolated, "hooks", "less-openwiki-hook.mjs"),
  );

  assert.match(result.hookSpecificOutput.additionalContext, /plan intent/u);
  await readFile(path.join(root, "openwiki", ".run.json"), "utf8");
});

test("initialization replaces stale generated wiki state but preserves instructions", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki", ".claims"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "INSTRUCTIONS.md"),
    "Keep deployment guidance concise.\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "openwiki", "index.md"),
    "# Stale index\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "openwiki", "log.md"),
    "# Stale log\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "openwiki", "legacy.md"),
    "---\ntype: concept\ntitle: Legacy\n---\n\n# Legacy\n",
    "utf8",
  );
  await writeJson(path.join(root, "openwiki", ".claims", "stale.json"), {
    schemaVersion: 1,
  });
  await writeJson(path.join(root, "openwiki", ".last-update.json"), {
    updatedAt: "2026-01-01T00:00:00.000Z",
    command: "init",
    model: "openwiki/old",
    status: "complete",
  });

  const started = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Initialize project documentation as a wiki.",
  });

  assert.match(started.hookSpecificOutput.additionalContext, /started/u);
  const state = JSON.parse(
    await readFile(path.join(root, "openwiki", ".run.json"), "utf8"),
  );
  assert.equal(state.mode, "init");
  assert.deepEqual(state.initialPages, []);
  assert.equal(state.previousLastUpdate.model, "openwiki/old");
  assert.equal(
    await readFile(path.join(root, "openwiki", "INSTRUCTIONS.md"), "utf8"),
    "Keep deployment guidance concise.\n",
  );
  await assert.rejects(
    readFile(path.join(root, "openwiki", "index.md"), "utf8"),
  );
  await assert.rejects(readFile(path.join(root, "openwiki", "log.md"), "utf8"));
  await assert.rejects(
    readFile(path.join(root, "openwiki", "legacy.md"), "utf8"),
  );
  await assert.rejects(
    readFile(path.join(root, "openwiki", ".claims", "stale.json"), "utf8"),
  );
  assert.equal(
    JSON.parse(await readFile(path.join(root, "openwiki", ".last-update.json")))
      .status,
    "interrupted",
  );
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

test("repository evidence enforces upstream source-boundary rules", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "private"), { recursive: true });
  await writeFile(path.join(root, "private", "secret.ts"), "secret\n", "utf8");
  await writeFile(path.join(root, ".openwikiignore"), "private/\n", "utf8");

  await assert.rejects(
    resolveRepositoryEvidence(root, "repo://private/secret.ts"),
    /excluded by \.openwikiignore: private\/secret\.ts/u,
  );
  await assert.rejects(
    resolveRepositoryEvidence(root, "repo://source.ts%0A"),
    /control character/u,
  );
  await assert.rejects(
    resolveRepositoryEvidence(root, "repo://OpenWiki/page.md"),
    /must remain inside the repository/u,
  );
});

test("native prompt detection recognizes an onboarding guide request", async (t) => {
  const root = await fixture(t);
  const result = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Create an onboarding guide for this codebase.",
  });
  assert.match(result.hookSpecificOutput.additionalContext, /started/u);
  assert.equal(
    JSON.parse(await readFile(path.join(root, "openwiki", ".run.json"), "utf8"))
      .phase,
    "planning",
  );
});

test("native prompt detection recognizes documentation migration requests", async (t) => {
  const root = await fixture(t);
  const result = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Migrate the repository documentation to the current format.",
  });
  assert.match(result.hookSpecificOutput.additionalContext, /started/u);
  assert.equal(
    JSON.parse(await readFile(path.join(root, "openwiki", ".run.json"), "utf8"))
      .phase,
    "planning",
  );
});

test("native run requests validate language before durable state and reject resume conflicts", async (t) => {
  const root = await fixture(t);
  const invalid = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Update the documentation.",
    language: "Korean",
  });
  assert.match(invalid.systemMessage, /Unrecognized language "Korean"/u);
  await assert.rejects(readFile(path.join(root, "openwiki", ".run.json")));

  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Initialize project documentation.",
    language: "ko",
  });
  const conflicting = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Resume the documentation.",
    language: "fr",
  });
  assert.match(
    conflicting.systemMessage,
    /uses ko; resume it before changing/u,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(root, "openwiki", ".run.json")))
      .language,
    "ko",
  );
});

test("a changed documentation language adds every omitted factual page to the plan", async (t) => {
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
    prompt: "Update the documentation in English.",
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
  const accepted = invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/.intents/plan.json" },
  });
  assert.match(accepted.hookSpecificOutput.additionalContext, /accepted/u);
  const state = JSON.parse(
    await readFile(path.join(root, "openwiki", ".run.json"), "utf8"),
  );
  assert.deepEqual(
    state.plan.pages.map((page) => page.path),
    ["openwiki/architecture.md", "openwiki/quickstart.md"],
  );
});

test("a regional language variant does not force a full page rewrite", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    "---\ntype: concept\ntitle: Quickstart\n---\n\n# Quickstart\n",
    "utf8",
  );
  await writeJson(path.join(root, "openwiki", ".last-update.json"), {
    updatedAt: new Date().toISOString(),
    command: "update",
    model: "openwiki/0.5.0",
    status: "complete",
    language: "en-US",
  });
  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Update the documentation.",
  });
  await writeJson(path.join(root, "openwiki", ".intents", "plan.json"), {
    language: "en-GB",
    pages: [
      {
        path: "architecture.md",
        title: "Architecture",
        purpose: "Document the architecture.",
      },
    ],
  });
  invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/.intents/plan.json" },
  });
  const state = JSON.parse(
    await readFile(path.join(root, "openwiki", ".run.json"), "utf8"),
  );
  assert.equal(state.languageChanged, false);
  assert.deepEqual(state.requiredRewritePages, []);
});

test("a plan rejects an unrecognized documentation language without advancing", async (t) => {
  const root = await fixture(t);
  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Create repository documentation.",
  });
  await writeJson(path.join(root, "openwiki", ".intents", "plan.json"), {
    language: "Korean",
    pages: [
      {
        path: "quickstart.md",
        title: "Quickstart",
        purpose: "Route readers.",
      },
    ],
  });
  const rejected = invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/.intents/plan.json" },
  });
  assert.match(rejected.systemMessage, /Unrecognized language "Korean"/u);
  assert.equal(
    JSON.parse(await readFile(path.join(root, "openwiki", ".run.json"), "utf8"))
      .phase,
    "planning",
  );
});

test("a plan rejects malformed page fields without coercing them", async (t) => {
  const root = await fixture(t);
  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Create repository documentation.",
  });
  await writeJson(path.join(root, "openwiki", ".intents", "plan.json"), {
    pages: [{ path: 42, title: "Quickstart", purpose: "Route readers." }],
  });

  const rejected = invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/.intents/plan.json" },
  });

  assert.match(rejected.systemMessage, /non-empty string path/u);
  assert.equal(
    JSON.parse(await readFile(path.join(root, "openwiki", ".run.json"), "utf8"))
      .phase,
    "planning",
  );
});

test("an initialization plan cannot delete generated pages", async (t) => {
  const root = await fixture(t);
  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Create repository documentation.",
  });
  await writeJson(path.join(root, "openwiki", ".intents", "plan.json"), {
    pages: [
      {
        path: "quickstart.md",
        title: "Quickstart",
        purpose: "Route readers.",
      },
    ],
    deletePages: ["obsolete.md"],
  });

  const rejected = invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/.intents/plan.json" },
  });

  assert.match(rejected.systemMessage, /cannot delete generated pages/u);
  assert.equal(
    JSON.parse(await readFile(path.join(root, "openwiki", ".run.json"), "utf8"))
      .phase,
    "planning",
  );
});

test("a plan canonicalizes seeds and related pages and rejects reserved pages", async (t) => {
  const root = await fixture(t);
  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Create repository documentation.",
  });
  await writeJson(path.join(root, "openwiki", ".intents", "plan.json"), {
    pages: [
      {
        path: "quickstart.md",
        title: "Quickstart",
        purpose: "Route readers.",
        seedPaths: ["/src\\main.ts"],
        relatedPages: ["architecture.md"],
      },
    ],
  });
  invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/.intents/plan.json" },
  });
  const accepted = JSON.parse(
    await readFile(path.join(root, "openwiki", ".run.json"), "utf8"),
  );
  assert.deepEqual(accepted.plan.pages[0].seedPaths, ["src/main.ts"]);
  assert.deepEqual(accepted.plan.pages[0].relatedPages, [
    "openwiki/architecture.md",
  ]);

  const rejectedRoot = await fixture(t);
  invoke(rejectedRoot, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: rejectedRoot,
    prompt: "Create repository documentation.",
  });
  await writeJson(
    path.join(rejectedRoot, "openwiki", ".intents", "plan.json"),
    {
      pages: [
        {
          path: "_working.md",
          title: "Working",
          purpose: "Reserved page.",
        },
        {
          path: "quickstart.md",
          title: "Quickstart",
          purpose: "Route readers.",
        },
      ],
    },
  );
  const rejected = invoke(rejectedRoot, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: rejectedRoot,
    tool_input: { file_path: "openwiki/.intents/plan.json" },
  });
  assert.match(rejected.systemMessage, /invalid documentation page path/u);
});

test("an update normalizes an existing page with unusable front matter", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "existing-page.md"),
    "# Existing page\n\nThis is existing documentation.\n",
    "utf8",
  );
  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Update the documentation.",
  });
  assert.equal(
    await readFile(path.join(root, "openwiki", "existing-page.md"), "utf8"),
    '---\ntype: "Reference"\ntitle: "Existing page"\nopenwiki_generated: true\n---\n\n# Existing page\n\nThis is existing documentation.\n',
  );
});

test("OKF migration uses the upstream localized concept type fallback", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "existing.md"),
    "# Existing\n",
    "utf8",
  );
  await writeJson(path.join(root, "openwiki", ".last-update.json"), {
    updatedAt: new Date().toISOString(),
    command: "update",
    model: "openwiki/0.5.0",
    status: "complete",
    language: "fr-CA",
  });
  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Update the documentation.",
  });
  assert.match(
    await readFile(path.join(root, "openwiki", "existing.md"), "utf8"),
    /type: "Référence"/u,
  );
});

test("OKF migration repairs owned scalar fields without discarding parseable extensions", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  const page = path.join(root, "openwiki", "existing.md");
  await writeFile(
    page,
    "---\ntype: []\ntitle: 42\ndescription: false\nauthor: Ada\n---\n# Existing\n",
    "utf8",
  );

  await normalizeWikiOkf(root);

  assert.equal(
    await readFile(page, "utf8"),
    '---\ntype: "Reference"\ntitle: "Existing"\nauthor: Ada\nopenwiki_generated: true\n---\n# Existing\n',
  );
});

test("OKF migration uses YAML structure when repairing source records", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  const page = path.join(root, "openwiki", "existing.md");
  await writeFile(
    page,
    "---\ntype: Reference\ntitle: >-\n  Existing: structured\nsources:\n  - resource: repo://README.md\n    annotation: { owner: docs }\n  - annotation: missing-resource\nproducer_extension:\n  nested: true\n---\n# Existing\n",
    "utf8",
  );

  await normalizePageOkf(root, "openwiki/existing.md");

  const normalized = await readFile(page, "utf8");
  assert.match(normalized, /title: >-/u);
  assert.match(normalized, /producer_extension:/u);
  assert.match(normalized, /resource: repo:\/\/README\.md/u);
  assert.doesNotMatch(normalized, /missing-resource/u);
});

test("OKF migration falls back cleanly when front matter is structurally malformed", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  const page = path.join(root, "openwiki", "broken.md");
  await writeFile(
    page,
    "---\ntype: [unterminated\nauthor: Ada\n---\n# Broken\n",
    "utf8",
  );

  await normalizeWikiOkf(root);

  assert.equal(
    await readFile(page, "utf8"),
    '---\ntype: "Reference"\ntitle: "Broken"\nopenwiki_generated: true\n---\n\n# Broken\n',
  );
});

test("OKF migration repairs malformed standard metadata families", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  const page = path.join(root, "openwiki", "metadata.md");
  await writeFile(
    page,
    "---\ntype: concept\ntitle: Existing\ntags: [ok, 2]\ngenerated: nope\nverified: { by: human, at: nope }\nsources: [bad]\nstatus: broken\nstale_after: nope\nauthor: Ada\n---\n# Existing\n",
    "utf8",
  );

  await normalizeWikiOkf(root);

  assert.equal(
    await readFile(page, "utf8"),
    "---\ntype: concept\ntitle: Existing\ntags:\n  - ok\nauthor: Ada\n---\n# Existing\n",
  );
});

test("native OKF validation matches structured upstream metadata requirements", () => {
  assert.equal(
    validateOkfFrontmatter(
      "---\ntype: concept\ntitle: Valid\ngenerated: { by: openwiki/1.0, at: 2026-02-29T00:00:00Z }\n---\n# Valid\n",
    ).ok,
    false,
  );
  assert.equal(
    validateOkfFrontmatter(
      "---\ntype: concept\ntitle: Valid\ngenerated: { by: openwiki/1.0, at: 2024-02-29T00:00:00Z }\nsources: [{ resource: repo://README.md }]\n---\n# Valid\n",
    ).ok,
    true,
  );
});

test("OKF repair retains valid verifier events from a mixed YAML list", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  const page = path.join(root, "openwiki", "existing.md");
  await writeFile(
    page,
    "---\ntype: concept\ntitle: Existing\nverified:\n  - by: human/1.0\n    at: 2025-01-01T00:00:00Z\n  - by: invalid/1.0\n    at: not-a-date\n---\n# Existing\n",
    "utf8",
  );

  await normalizePageOkf(root, "openwiki/existing.md");

  const normalized = await readFile(page, "utf8");
  assert.match(normalized, /by: human\/1\.0/u);
  assert.doesNotMatch(normalized, /invalid\/1\.0/u);
});

test("a native checkpoint repairs authored OKF before Claims completion", async (t) => {
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
  await writeIntent(root, "openwiki/quickstart.md", "README.md");
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    "---\ntype: []\ntitle: 42\nauthor: Ada\n---\n# Quickstart\n",
    "utf8",
  );

  const checkpoint = invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/quickstart.md" },
  });

  assert.match(checkpoint.hookSpecificOutput.additionalContext, /Recorded/u);
  assert.match(
    await readFile(path.join(root, "openwiki", "quickstart.md"), "utf8"),
    /type: "Reference"\ntitle: "Quickstart"\nauthor: Ada\nopenwiki_generated: true/u,
  );
});

test("generated provenance preserves an untouched page's prior producer event", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  const original =
    "---\ntype: concept\ngenerated:\n  by: example/1.0\n  at: 2025-01-01T00:00:00.000Z\n---\n\n# Existing\n";
  await writeFile(path.join(root, "openwiki", "existing.md"), original, "utf8");
  await finalizeGeneratedProvenance(root, {
    startedAt: "2026-01-01T00:00:00.000Z",
    actor: { producerActor: "openwiki/0.5.0" },
    plan: { pages: [] },
    preparedWiki: {
      generatedProvenance: [
        {
          page: "/openwiki/existing.md",
          bodyHash: hash("\n# Existing\n"),
          generated: { by: "example/1.0", at: "2025-01-01T00:00:00.000Z" },
        },
      ],
    },
  });
  assert.equal(
    await readFile(path.join(root, "openwiki", "existing.md"), "utf8"),
    original,
  );
});

test("generated provenance recognizes a YAML flow event", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  const original =
    "---\ntype: concept\ngenerated: { by: example/1.0, at: 2025-01-01T00:00:00.000Z }\n---\n\n# Existing\n";
  await writeFile(path.join(root, "openwiki", "existing.md"), original, "utf8");
  await finalizeGeneratedProvenance(root, {
    startedAt: "2026-01-01T00:00:00.000Z",
    actor: { producerActor: "openwiki/0.5.0" },
    plan: { pages: [] },
    preparedWiki: {
      generatedProvenance: [
        {
          page: "/openwiki/existing.md",
          bodyHash: hash("\n# Existing\n"),
          generated: { by: "example/1.0", at: "2025-01-01T00:00:00.000Z" },
        },
      ],
    },
  });
  assert.equal(
    await readFile(path.join(root, "openwiki", "existing.md"), "utf8"),
    original,
  );
});

test("an update snapshots YAML flow provenance before page work", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "existing.md"),
    "---\ntype: concept\ntitle: Existing\ngenerated: { by: example/1.0, at: 2025-01-01T00:00:00.000Z }\n---\n\n# Existing\n",
    "utf8",
  );

  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Update the documentation.",
  });

  const state = JSON.parse(
    await readFile(path.join(root, "openwiki", ".run.json"), "utf8"),
  );
  assert.deepEqual(state.preparedWiki.generatedProvenance[0].generated, {
    by: "example/1.0",
    at: "2025-01-01T00:00:00.000Z",
  });
});

test("an interrupted native run retains its prior successful Git baseline", async (t) => {
  const root = await fixture(t);
  execFileSync("git", ["config", "user.email", "fixture@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "existing.md"),
    "---\ntype: concept\ntitle: Existing\n---\n\n# Existing\n",
    "utf8",
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "baseline"], {
    cwd: root,
  });
  const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  await writeJson(path.join(root, "openwiki", ".last-update.json"), {
    updatedAt: "2026-01-01T00:00:00.000Z",
    command: "update",
    gitHead: baseline,
    model: "openwiki/0.5.0",
    status: "complete",
    language: "en",
  });

  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Update the documentation.",
  });
  invoke(root, "session-end", { hook_event_name: "SessionEnd", cwd: root });

  const interrupted = JSON.parse(
    await readFile(path.join(root, "openwiki", ".last-update.json"), "utf8"),
  );
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.gitHead, baseline);
});

test("an update plan adds omitted work for stale Claims", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki", ".claims"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    "---\ntype: concept\ntitle: Quickstart\ndescription: Existing.\n---\n\n# Quickstart\n",
    "utf8",
  );
  await writeJson(path.join(root, "openwiki", ".claims", "quickstart.json"), {
    schemaVersion: 1,
    pageVersion:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    verification: { by: "openwiki/0.5.0", at: new Date().toISOString() },
    claims: [
      {
        id: "a3bd33b5-3545-4551-a84d-82a68d92b3ff",
        statement: "The fixture exists.",
        evidence: [{ resource: "repo://README.md", version: "stale" }],
      },
    ],
  });
  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Update the documentation.",
  });
  await writeJson(path.join(root, "openwiki", ".intents", "plan.json"), {
    pages: [],
  });
  const accepted = invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/.intents/plan.json" },
  });
  assert.match(accepted.hookSpecificOutput.additionalContext, /accepted/u);
  const state = JSON.parse(
    await readFile(path.join(root, "openwiki", ".run.json"), "utf8"),
  );
  assert.deepEqual(
    state.plan.pages.map((page) => page.path),
    ["openwiki/quickstart.md"],
  );
  assert.deepEqual(state.plan.pages[0].seedPaths, ["README.md"]);
});

test("an update plan adds full review work for a page without manifest coverage", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    "---\ntype: concept\ntitle: Quickstart\n---\n\n# Quickstart\n",
    "utf8",
  );
  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Update the documentation.",
  });
  await writeJson(path.join(root, "openwiki", ".intents", "plan.json"), {
    pages: [],
  });
  invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/.intents/plan.json" },
  });
  const state = JSON.parse(
    await readFile(path.join(root, "openwiki", ".run.json"), "utf8"),
  );
  assert.deepEqual(
    state.plan.pages.map((page) => page.path),
    ["openwiki/quickstart.md"],
  );
  assert.match(state.plan.pages[0].purpose, /durable verified coverage/u);
});

test("a stale Claim requires an explicit reconciliation decision", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki", ".claims"), { recursive: true });
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    "---\ntype: concept\ntitle: Quickstart\ndescription: Existing.\n---\n\n# Quickstart\n",
    "utf8",
  );
  const staleId = "a3bd33b5-3545-4551-a84d-82a68d92b3ff";
  await writeJson(path.join(root, "openwiki", ".claims", "quickstart.json"), {
    schemaVersion: 1,
    pageVersion:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    verification: { by: "openwiki/0.5.0", at: new Date().toISOString() },
    claims: [
      {
        id: staleId,
        statement: "The fixture exists.",
        evidence: [{ resource: "repo://README.md", version: "stale" }],
      },
    ],
  });
  await assert.rejects(
    reconcileClaims(
      root,
      "openwiki/quickstart.md",
      {
        claims: [
          {
            statement: "A separate fact.",
            evidence: [{ resource: "repo://README.md" }],
          },
        ],
      },
      "openwiki/0.5.0",
    ),
    /requires an explicit confirm/u,
  );
  await reconcileClaims(
    root,
    "openwiki/quickstart.md",
    {
      retractedClaimIds: [staleId],
      claims: [
        {
          statement: "The replacement fact is supported by the fixture.",
          evidence: [{ resource: "repo://README.md" }],
        },
      ],
    },
    "openwiki/0.5.0",
  );
});

test("Claims reconciliation accepts only the upstream private intent shape", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    "---\ntype: concept\ntitle: Quickstart\n---\n\n# Quickstart\n",
    "utf8",
  );
  await assert.rejects(
    reconcileClaims(
      root,
      "openwiki/quickstart.md",
      {
        replaceAll: true,
        claims: [
          {
            statement: "The fixture exists.",
            evidence: [{ resource: "repo://README.md" }],
          },
        ],
      },
      "openwiki/0.5.0",
    ),
    /unsupported Claim reconciliation field/u,
  );
  await assert.rejects(
    reconcileClaims(
      root,
      "openwiki/quickstart.md",
      {
        claims: [
          { statement: "The fixture exists.", evidence: ["repo://README.md"] },
        ],
      },
      "openwiki/0.5.0",
    ),
    /evidence must contain only a non-empty resource/u,
  );
  const claims = await reconcileClaims(
    root,
    "openwiki/quickstart.md",
    {
      claims: [
        {
          statement: "The fixture exists.",
          evidence: [{ resource: "repo://README.md" }],
        },
      ],
    },
    "openwiki/0.5.0",
  );
  assert.match(claims[0].id, /^claim_[a-f0-9]{32}$/u);
  const confirmedByOmission = await reconcileClaims(
    root,
    "openwiki/quickstart.md",
    {},
    "openwiki/0.5.0",
  );
  assert.deepEqual(
    confirmedByOmission.map(({ id }) => id),
    claims.map(({ id }) => id),
  );
});

test("malformed durable Claims state fails closed during preflight", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki", ".claims"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", ".claims", "quickstart.json"),
    '{"schemaVersion":1,"claims":[]}\n',
    "utf8",
  );
  await assert.rejects(
    preflightClaims(root),
    /refusing to discard durable grounding state/u,
  );
});

test("Claims preflight groups multiple stale evidence records per Claim", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki", ".claims"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    "---\ntype: concept\ntitle: Quickstart\n---\n\n# Quickstart\n",
    "utf8",
  );
  await writeFile(path.join(root, "second.txt"), "second\n", "utf8");
  await writeJson(path.join(root, "openwiki", ".claims", "quickstart.json"), {
    schemaVersion: 1,
    pageVersion: hash(
      await readFile(path.join(root, "openwiki", "quickstart.md")),
    ),
    verification: { by: "openwiki/0.5.0", at: new Date().toISOString() },
    claims: [
      {
        id: "a3bd33b5-3545-4551-a84d-82a68d92b3ff",
        statement: "The fixture has two source files.",
        evidence: [
          { resource: "repo://README.md", version: "stale" },
          { resource: "repo://second.txt", version: "stale" },
        ],
      },
    ],
  });
  assert.deepEqual(await preflightClaims(root), [
    {
      page: "/openwiki/quickstart.md",
      kind: "stale",
      claimId: "a3bd33b5-3545-4551-a84d-82a68d92b3ff",
      resources: ["repo://README.md", "repo://second.txt"],
    },
  ]);
});

test("Claims preflight rejects duplicate identifiers across factual pages", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki", ".claims"), { recursive: true });
  for (const page of ["first.md", "second.md"]) {
    await writeFile(
      path.join(root, "openwiki", page),
      `---\ntype: concept\n---\n\n# ${page}\n`,
      "utf8",
    );
    await writeJson(
      path.join(root, "openwiki", ".claims", page.replace(/\.md$/u, ".json")),
      {
        schemaVersion: 1,
        pageVersion: hash(await readFile(path.join(root, "openwiki", page))),
        verification: { by: "openwiki/0.5.0", at: new Date().toISOString() },
        claims: [
          {
            id: "a3bd33b5-3545-4551-a84d-82a68d92b3ff",
            statement: "The fixture exists.",
            evidence: [
              {
                resource: "repo://README.md",
                version: (
                  await resolveRepositoryEvidence(root, "repo://README.md")
                ).version,
              },
            ],
          },
        ],
      },
    );
  }
  await assert.rejects(preflightClaims(root), /Duplicate Claim identifier/u);
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

test("the update window honors upstream .openwikiignore glob and directory semantics", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, ".openwikiignore"),
    "/root-only\n**/generated/\n*.log\n!logs/keep.log\ncache?\n",
    "utf8",
  );
  for (const [file, contents] of [
    ["root-only", "hidden\n"],
    ["nested/root-only", "visible\n"],
    ["generated/output.js", "hidden\n"],
    ["nested/generated/output.js", "hidden\n"],
    ["build", "visible\n"],
    ["logs/debug.log", "hidden\n"],
    ["logs/keep.log", "visible\n"],
    ["cache1", "hidden\n"],
    ["nested/cache2", "hidden\n"],
    ["cache12", "visible\n"],
  ]) {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
  assert.deepEqual(await repositoryChangedPaths(root, null), [
    ".openwikiignore",
    "README.md",
    "build",
    "cache12",
    "logs/keep.log",
    "nested/root-only",
  ]);
});

test("native link validation clamps paths and stamps upstream-compatible diagnostics", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki", "nested"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "nested", "page.md"),
    "---\ntype: concept\ntitle: Page\n---\n\n# Page\n[repository](../../README.md)\n[missing](../../../../etc/passwd)\n[anchor](#missing-anchor)\n",
    "utf8",
  );

  await finalizeWiki(root);

  const page = await readFile(
    path.join(root, "openwiki", "nested", "page.md"),
    "utf8",
  );
  assert.doesNotMatch(page, /broken internal link \[\.\.\/\.\.\/README\.md\]/u);
  assert.match(
    page,
    /<!-- openwiki: broken internal link \[\.\.\/\.\.\/\.\.\/\.\.\/etc\/passwd\] file "\.\.\/\.\.\/\.\.\/\.\.\/etc\/passwd" does not exist\. Fix the href or restore the target, then delete this comment\. -->/u,
  );
  assert.match(
    page,
    /<!-- openwiki: broken internal link \[#missing-anchor\] heading anchor "missing-anchor" does not exist in \/openwiki\/nested\/page\.md\. Fix the href or restore the target, then delete this comment\. -->/u,
  );
});

test("native Mermaid validation uses upstream fence extraction and fallback diagnostics", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  const page = path.join(root, "openwiki", "diagrams.md");
  await writeFile(
    page,
    "---\ntype: concept\ntitle: Diagrams\n---\n\n# Diagrams\n\n```mermaid\nflowchart TD\nnode[one; two]\n```\n\n````markdown\n```mermaid\nflowchart TD\nexample[one; two]\n```\n````\n",
    "utf8",
  );

  await finalizeWiki(root);

  const content = await readFile(page, "utf8");
  assert.match(
    content,
    /<!-- openwiki: mermaid parse failed and this diagram was converted to a text fence so it does not break rendering\. Fix the diagram source and restore the mermaid fence\. Parser error: Heuristic: a semicolon inside a label breaks rendering; rephrase the label\. -->\n```text/u,
  );
  assert.match(
    content,
    /````markdown\n```mermaid\nflowchart TD\nexample\[one; two\]\n```\n````/u,
  );
  assert.equal((content.match(/mermaid parse failed/gu) ?? []).length, 1);
});

test("Claims source projection preserves authored sources and replaces only native entries", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  const page = path.join(root, "openwiki", "sources.md");
  await writeFile(
    page,
    "---\ntype: concept\ntitle: Sources\nsources:\n  - id: authored-source\n    resource: repo://AUTHORED.md\n    author: human:owner\n  - id: openwiki-source-obsolete\n    resource: repo://old.md\n---\n\n# Sources\n",
    "utf8",
  );

  await finalizePage(
    root,
    "openwiki/sources.md",
    "openwiki/0.5.0",
    [{ evidence: [{ resource: "repo://README.md#L1-L1" }] }],
    "2026-01-01T00:00:00.000Z",
  );

  const content = await readFile(page, "utf8");
  assert.match(
    content,
    /id: authored-source\n    resource: repo:\/\/AUTHORED\.md\n    author: human:owner/u,
  );
  assert.doesNotMatch(content, /openwiki-source-obsolete/u);
  assert.match(
    content,
    new RegExp(
      `id: openwiki-source-${hash("repo://README.md").slice(7, 31)}\\n    resource: repo://README\\.md`,
      "u",
    ),
  );
});

test("Claims source projection preserves YAML flow mappings", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  const page = path.join(root, "openwiki", "sources.md");
  await writeFile(
    page,
    "---\ntype: concept\ntitle: Sources\nsources: [{ id: authored-source, resource: repo://AUTHORED.md, details: { owner: human } }]\n---\n\n# Sources\n",
    "utf8",
  );

  await finalizePage(
    root,
    "openwiki/sources.md",
    "openwiki/0.5.0",
    [{ evidence: [{ resource: "repo://README.md" }] }],
    "2026-01-01T00:00:00.000Z",
  );

  const content = await readFile(page, "utf8");
  assert.match(content, /id: authored-source/u);
  assert.match(content, /resource: repo:\/\/AUTHORED\.md/u);
  assert.match(content, /owner: human/u);
  assert.match(content, /resource: repo:\/\/README\.md/u);
  assert.equal((content.match(/^sources:/gmu) ?? []).length, 1);
});

test("final Claims source projection covers untouched durable pages", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki", ".claims"), { recursive: true });
  const page = path.join(root, "openwiki", "existing.md");
  await writeFile(
    page,
    "---\ntype: concept\ntitle: Existing\n---\n\n# Existing\n",
    "utf8",
  );
  await writeJson(path.join(root, "openwiki", ".claims", "existing.json"), {
    schemaVersion: 1,
    pageVersion: hash(await readFile(page)),
    verification: { by: "openwiki/0.5.0", at: "2026-01-01T00:00:00.000Z" },
    claims: [
      {
        id: "claim_existing",
        statement: "The existing fixture is documented.",
        evidence: [{ resource: "repo://README.md", version: "fixture" }],
      },
    ],
  });

  await synchronizeClaimSources(root);

  assert.match(
    await readFile(page, "utf8"),
    /id: openwiki-source-[a-f0-9]{24}\n    resource: repo:\/\/README\.md/u,
  );
});

test("final Claims verification projection covers untouched durable pages", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "openwiki", ".claims"), { recursive: true });
  const page = path.join(root, "openwiki", "existing.md");
  await writeFile(
    page,
    "---\ntype: concept\ntitle: Existing\nverified: { by: openwiki/old, at: 2025-01-01T00:00:00Z }\n---\n\n# Existing\n",
    "utf8",
  );
  await writeJson(path.join(root, "openwiki", ".claims", "existing.json"), {
    schemaVersion: 1,
    pageVersion: hash(await readFile(page)),
    verification: { by: "openwiki/0.5.0", at: "2026-01-01T00:00:00.000Z" },
    claims: [
      {
        id: "claim_existing",
        statement: "The existing fixture is documented.",
        evidence: [{ resource: "repo://README.md", version: "fixture" }],
      },
    ],
  });

  await synchronizeClaimsVerification(root);

  const content = await readFile(page, "utf8");
  assert.match(content, /by: openwiki\/0\.5\.0/u);
  assert.doesNotMatch(content, /openwiki\/old/u);
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
  const pageVersion = hash(
    await readFile(path.join(root, "openwiki", "quickstart.md")),
  );
  await writeJson(path.join(root, "openwiki", ".claims", "quickstart.json"), {
    schemaVersion: 1,
    pageVersion,
    claims: [
      {
        id: "a3bd33b5-3545-4551-a84d-82a68d92b3ff",
        statement: "The quickstart exists.",
        evidence: [
          {
            resource: "repo://README.md",
            version: (await resolveRepositoryEvidence(root, "repo://README.md"))
              .version,
          },
        ],
      },
    ],
    verification: { by: "openwiki/0.5.0", at: new Date().toISOString() },
  });
  await writeJson(path.join(root, "openwiki", ".page-manifest.json"), {
    schemaVersion: 1,
    pages: {
      "/openwiki/quickstart.md": {
        gitHead: head,
        sourceFingerprint:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        pageVersion,
        completedBy: "openwiki/0.5.0",
        completedRunId: "a3bd33b5-3545-4551-a84d-82a68d92b3ff",
      },
    },
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

test("a verified complete legacy update seeds native page manifest coverage", async (t) => {
  const root = await fixture(t);
  execFileSync("git", ["config", "user.email", "fixture@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  await mkdir(path.join(root, "openwiki", ".claims"), { recursive: true });
  const page = path.join(root, "openwiki", "quickstart.md");
  await writeFile(
    page,
    "---\ntype: concept\ntitle: Quickstart\n---\n\n# Quickstart\n",
    "utf8",
  );
  const pageVersion = hash(await readFile(page));
  await writeJson(path.join(root, "openwiki", ".claims", "quickstart.json"), {
    schemaVersion: 1,
    pageVersion,
    claims: [
      {
        id: "a3bd33b5-3545-4551-a84d-82a68d92b3ff",
        statement: "The quickstart exists.",
        evidence: [
          {
            resource: "repo://README.md",
            version: (await resolveRepositoryEvidence(root, "repo://README.md"))
              .version,
          },
        ],
      },
    ],
    verification: { by: "openwiki/0.5.0", at: new Date().toISOString() },
  });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "legacy baseline"], {
    cwd: root,
  });
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
  await assert.rejects(readFile(path.join(root, "openwiki", ".run.json")));
  const manifest = JSON.parse(
    await readFile(path.join(root, "openwiki", ".page-manifest.json")),
  );
  assert.equal(manifest.pages["/openwiki/quickstart.md"].gitHead, head);
  assert.match(
    manifest.pages["/openwiki/quickstart.md"].sourceFingerprint,
    /^sha256:/u,
  );
});

test("update planning uses every page's manifest baseline, not only the last run", async (t) => {
  const root = await fixture(t);
  execFileSync("git", ["config", "user.email", "fixture@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  await mkdir(path.join(root, "openwiki", ".claims"), { recursive: true });
  const page = path.join(root, "openwiki", "quickstart.md");
  await writeFile(
    page,
    "---\ntype: concept\ntitle: Quickstart\n---\n\n# Quickstart\n",
    "utf8",
  );
  const pageVersion = hash(await readFile(page));
  await writeJson(path.join(root, "openwiki", ".claims", "quickstart.json"), {
    schemaVersion: 1,
    pageVersion,
    claims: [],
    verification: { by: "openwiki/0.5.0", at: new Date().toISOString() },
  });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "documented baseline"], {
    cwd: root,
  });
  const pageBaseline = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  await writeJson(path.join(root, "openwiki", ".page-manifest.json"), {
    schemaVersion: 1,
    pages: {
      "/openwiki/quickstart.md": {
        gitHead: pageBaseline,
        sourceFingerprint:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        pageVersion,
        completedBy: "openwiki/0.5.0",
        completedRunId: "a3bd33b5-3545-4551-a84d-82a68d92b3ff",
      },
    },
  });
  await writeFile(path.join(root, "README.md"), "# Updated fixture\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "source update"], {
    cwd: root,
  });
  const lastRunHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  await writeJson(path.join(root, "openwiki", ".last-update.json"), {
    updatedAt: new Date().toISOString(),
    command: "update",
    gitHead: lastRunHead,
    model: "openwiki/0.5.0",
    status: "complete",
    language: "en",
  });

  const active = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Update the documentation.",
  });

  assert.match(
    active.hookSpecificOutput.additionalContext,
    /Changed source paths: README.md/u,
  );
  assert.match(
    active.hookSpecificOutput.additionalContext,
    new RegExp(
      `quickstart\\.md \\[base ${pageBaseline}; changed: README\\.md\\]`,
      "u",
    ),
  );
});

test("a docs-only commit fast-forwards native manifest coverage during no-op", async (t) => {
  const root = await fixture(t);
  execFileSync("git", ["config", "user.email", "fixture@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  await mkdir(path.join(root, "openwiki", ".claims"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    "---\ntype: concept\ntitle: Quickstart\n---\n\n# Quickstart\n",
    "utf8",
  );
  const pageVersion = hash(
    await readFile(path.join(root, "openwiki", "quickstart.md")),
  );
  await writeJson(path.join(root, "openwiki", ".claims", "quickstart.json"), {
    schemaVersion: 1,
    pageVersion,
    claims: [
      {
        id: "a3bd33b5-3545-4551-a84d-82a68d92b3ff",
        statement: "The quickstart exists.",
        evidence: [
          {
            resource: "repo://README.md",
            version: (await resolveRepositoryEvidence(root, "repo://README.md"))
              .version,
          },
        ],
      },
    ],
    verification: { by: "openwiki/0.5.0", at: new Date().toISOString() },
  });
  await writeJson(path.join(root, "openwiki", ".page-manifest.json"), {
    schemaVersion: 1,
    pages: {
      "/openwiki/quickstart.md": {
        sourceFingerprint:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        pageVersion,
      },
    },
  });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "baseline"], {
    cwd: root,
  });
  const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  await writeJson(path.join(root, "openwiki", ".last-update.json"), {
    updatedAt: new Date().toISOString(),
    command: "update",
    gitHead: baseline,
    model: "openwiki/0.5.0",
    status: "complete",
    language: "en",
  });
  await writeFile(
    path.join(root, "openwiki", "index.md"),
    "# Navigation\n",
    "utf8",
  );
  execFileSync("git", ["add", "openwiki/index.md"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "docs only"], {
    cwd: root,
  });
  const current = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const result = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Update the documentation.",
  });
  assert.match(result.hookSpecificOutput.additionalContext, /current/u);
  const manifest = JSON.parse(
    await readFile(path.join(root, "openwiki", ".page-manifest.json"), "utf8"),
  );
  assert.equal(manifest.pages["/openwiki/quickstart.md"].gitHead, current);
  assert.match(
    manifest.pages["/openwiki/quickstart.md"].sourceFingerprint,
    /^sha256:[a-f0-9]{64}$/u,
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(root, "openwiki", ".last-update.json"), "utf8"),
    ).gitHead,
    current,
  );
});

test("an explicit language request bypasses a clean native update no-op", async (t) => {
  const root = await fixture(t);
  execFileSync("git", ["config", "user.email", "fixture@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  await mkdir(path.join(root, "openwiki", ".claims"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    "---\ntype: concept\ntitle: Quickstart\n---\n\n# Quickstart\n",
    "utf8",
  );
  const pageVersion = hash(
    await readFile(path.join(root, "openwiki", "quickstart.md")),
  );
  await writeJson(path.join(root, "openwiki", ".claims", "quickstart.json"), {
    schemaVersion: 1,
    pageVersion,
    claims: [
      {
        id: "a3bd33b5-3545-4551-a84d-82a68d92b3ff",
        statement: "The quickstart exists.",
        evidence: [
          {
            resource: "repo://README.md",
            version: (await resolveRepositoryEvidence(root, "repo://README.md"))
              .version,
          },
        ],
      },
    ],
    verification: { by: "openwiki/0.5.0", at: new Date().toISOString() },
  });
  await writeJson(path.join(root, "openwiki", ".page-manifest.json"), {
    schemaVersion: 1,
    pages: {
      "/openwiki/quickstart.md": {
        sourceFingerprint:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        pageVersion,
      },
    },
  });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "baseline"], {
    cwd: root,
  });
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
  const result = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Update the documentation in French.",
  });
  assert.match(result.hookSpecificOutput.additionalContext, /started/u);
  assert.equal(
    JSON.parse(await readFile(path.join(root, "openwiki", ".run.json"), "utf8"))
      .phase,
    "planning",
  );
});

test("finalization preserves completed documentation when source drifts", async (t) => {
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
  await writeIntent(root, "openwiki/quickstart.md", "README.md");
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    "---\ntype: concept\ntitle: Quickstart\n---\n\n# Quickstart\n",
    "utf8",
  );
  invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/quickstart.md" },
  });
  const plannedSource = JSON.parse(
    await readFile(path.join(root, "openwiki", ".run.json"), "utf8"),
  ).sourceFingerprint;
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "changed-after-planning.ts"),
    "export const changed = true;\n",
    "utf8",
  );

  const result = await finish(root);

  assert.match(result.systemMessage, /changed during the run/u);
  await assert.rejects(
    readFile(path.join(root, "openwiki", ".run.json"), "utf8"),
  );
  const update = JSON.parse(
    await readFile(path.join(root, "openwiki", ".last-update.json"), "utf8"),
  );
  assert.equal(update.status, "interrupted");
  assert.equal(update.gitHead, undefined);
  const manifest = JSON.parse(
    await readFile(path.join(root, "openwiki", ".page-manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.pages["/openwiki/quickstart.md"].sourceFingerprint,
    plannedSource,
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

test("source snapshots distinguish staged and unstaged source state", async (t) => {
  const root = await fixture(t);
  execFileSync("git", ["config", "user.email", "fixture@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "baseline"], {
    cwd: root,
  });
  await writeFile(path.join(root, "README.md"), "# Modified fixture\n", "utf8");
  const unstaged = (await sourceSnapshot(root)).fingerprint;
  execFileSync("git", ["add", "README.md"], { cwd: root });
  const staged = (await sourceSnapshot(root)).fingerprint;
  assert.notEqual(staged, unstaged);
});

test("source snapshots include executable modes and symlink targets", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "tool.sh"),
    "#!/bin/sh\necho fixture\n",
    "utf8",
  );
  const regular = (await sourceSnapshot(root)).fingerprint;
  await chmod(path.join(root, "tool.sh"), 0o755);
  const executable = (await sourceSnapshot(root)).fingerprint;
  assert.notEqual(executable, regular);
  await symlink("first-target", path.join(root, "source-link"));
  const firstLink = (await sourceSnapshot(root)).fingerprint;
  await rm(path.join(root, "source-link"));
  await symlink("second-target", path.join(root, "source-link"));
  const secondLink = (await sourceSnapshot(root)).fingerprint;
  assert.notEqual(firstLink, secondLink);
});

test("a resumed run recovers a checkpointed page from durable manifest coverage", async (t) => {
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
  await writeIntent(root, "openwiki/quickstart.md", "README.md");
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    "---\ntype: concept\ntitle: Quickstart\ndescription: Fixture documentation.\n---\n\n# Quickstart\n",
    "utf8",
  );
  invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/quickstart.md" },
  });
  const runFile = path.join(root, "openwiki", ".run.json");
  const interrupted = JSON.parse(await readFile(runFile, "utf8"));
  interrupted.plan.pages[0].status = "pending";
  delete interrupted.plan.pages[0].completedBy;
  await writeJson(runFile, interrupted);

  const resumed = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Resume documentation.",
  });
  assert.match(
    resumed.hookSpecificOutput.additionalContext,
    /All queued pages/u,
  );
  const recovered = JSON.parse(await readFile(runFile, "utf8"));
  assert.equal(recovered.plan.pages[0].status, "complete");
  assert.equal(recovered.plan.pages[0].completedBy, "openwiki/0.2.0");
});

test("a resume rejects completed native work that lost its durable Claims proof", async (t) => {
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
  await writeIntent(root, "openwiki/quickstart.md", "README.md");
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    "---\ntype: concept\ntitle: Quickstart\ndescription: Fixture documentation.\n---\n\n# Quickstart\n",
    "utf8",
  );
  invoke(root, "post-tool", {
    hook_event_name: "PostToolUse",
    cwd: root,
    tool_input: { file_path: "openwiki/quickstart.md" },
  });
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    "---\ntype: concept\ntitle: Quickstart\ndescription: Mutated after checkpoint.\n---\n\n# Quickstart\n",
    "utf8",
  );

  const resumed = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Resume documentation.",
  });
  assert.match(resumed.systemMessage, /lost its durable Claims proof/u);
  assert.equal(
    JSON.parse(await readFile(path.join(root, "openwiki", ".run.json"), "utf8"))
      .plan.pages[0].status,
    "complete",
  );
});

test("a resumed run retries a durable skipped page", async (t) => {
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
  const runFile = path.join(root, "openwiki", ".run.json");
  const interrupted = JSON.parse(await readFile(runFile, "utf8"));
  interrupted.plan.pages[0].status = "skipped";
  await writeJson(runFile, interrupted);

  const stopped = invoke(root, "stop", { hook_event_name: "Stop", cwd: root });
  assert.match(stopped.stopReason, /skipped work/u);
  const resumed = invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Resume documentation.",
  });
  assert.match(
    resumed.hookSpecificOutput.additionalContext,
    /Current page: openwiki\/quickstart\.md/u,
  );
  assert.equal(
    JSON.parse(await readFile(runFile, "utf8")).plan.pages[0].status,
    "pending",
  );
});

test("a stable resume backfills a legacy native target Git head", async (t) => {
  const root = await fixture(t);
  execFileSync("git", ["config", "user.email", "fixture@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "baseline"], {
    cwd: root,
  });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
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
  const runFile = path.join(root, "openwiki", ".run.json");
  const legacy = JSON.parse(await readFile(runFile, "utf8"));
  delete legacy.targetGitHead;
  await writeJson(runFile, legacy);

  invoke(root, "user-prompt", {
    hook_event_name: "UserPromptSubmit",
    cwd: root,
    prompt: "Resume documentation.",
  });
  assert.equal(JSON.parse(await readFile(runFile, "utf8")).targetGitHead, head);
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

function invoke(cwd, action, input, hook = engine) {
  const result = spawnSync(process.execPath, [hook, action], {
    cwd,
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: path.dirname(path.dirname(hook)),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}
