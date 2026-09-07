# Native Plugin Architecture

Less OpenWiki packages one documentation workflow for Codex and Claude Code.
The host agent researches and writes; the plugin provides the durable lifecycle
around that work.

```text
documentation request
        │
        ▼
shared skill ──► semantic plan, Claims intent, and page authoring
        │                    │
        ▼                    ▼
required hooks ─────► state, Claims, indexes, validation, provenance
        │
        ▼
resumable completion
```

## Lifecycle

The hook engine runs at the native lifecycle points supplied by each host:

| Event                                 | Outcome                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `SessionStart` and `UserPromptSubmit` | Load or begin the durable documentation run.                                  |
| `PreToolUse`                          | Protect lifecycle state and permit only the plan or current page work.        |
| `PostToolUse`                         | Consume semantic intent, validate, reconcile Claims, and checkpoint progress. |
| `Stop`                                | Finalize only when every queued page is valid; otherwise keep the run active. |
| `SessionEnd`                          | Persist an interrupted checkpoint for the next session.                       |

The hook adapter is intentionally thin. It invokes three ordinary internal
modules: lifecycle (state, planning, snapshot, checkpoint and rollback),
Claims (evidence and reconciliation), and OKF (front matter, provenance,
sources, indexes and links). They have no background service and no user-facing
control surface. Pre- and post-tool hooks receive every tool event; the runtime
only intervenes when the event names lifecycle state, a private intent, or a
generated documentation page. Durable repository outputs are:

- `openwiki/.run.json` while a run is active;
- `openwiki/.claims/` for page grounding state;
- `openwiki/.page-manifest.json` for completed-page coverage; and
- `openwiki/.last-update.json` after completion or interruption.

The hook package includes its pinned YAML reader, so OKF front matter is
interpreted consistently on a clean Codex or Claude Code installation without
an additional host-level package installation. Its bundled-dependency notice is
kept beside the runtime artifact.

The skill uses temporary, hook-consumed intent files while a run is active: a
semantic plan first, then a page-local Claims intent before each factual page.
For updates, the plan may intentionally omit pages: the lifecycle deterministically
adds work required to reconcile stale Claims and to complete a language rewrite.
They are removed at checkpoints and never become documentation output. The
skill does not edit durable lifecycle files directly.

Before an update begins, the lifecycle normalizes any factual page that lacks
usable OKF front matter into a minimal, explicitly code-derived record. Existing
usable metadata remains unchanged, so the update can enrich it without a manual
format-conversion step. The same deterministic repair runs before each page
checkpoint and finalization, before Claims and page-manifest coverage become
durable.

At every checkpoint and final completion, the lifecycle validates the full OKF
metadata contract—not only the presence of a page type. This includes structured
YAML, provenance and verification events, source mappings, tags, lifecycle
status, and absolute timestamps.

If repository source changes after all page jobs have been checkpointed, the
finalizer still validates and preserves the completed documentation. It retains
the run's planned source checkpoint and records `.last-update.json` as
`interrupted`, which requires the next documentation request to reconcile the
new source rather than incorrectly reporting the wiki as current.

## Host packaging

| Host        | Manifest                     | Marketplace                        | Hook package       |
| ----------- | ---------------------------- | ---------------------------------- | ------------------ |
| Codex       | `.codex-plugin/plugin.json`  | `.agents/plugins/marketplace.json` | `hooks/hooks.json` |
| Claude Code | `.claude-plugin/plugin.json` | `.claude-plugin/marketplace.json`  | `hooks/hooks.json` |

The package uses each host's native hook payload and policy response shape, but
both call the same engine and write the same repository state.

## Upstream maintenance

`upstream-docs-report.mjs` compares the merge base of the current branch and
the configured upstream branch, then groups upstream changes by the component
that should receive them:

| Incoming change     | Primary destination                          |
| ------------------- | -------------------------------------------- |
| Documentation       | Shared skill and user documentation          |
| Generation behavior | Hook engine and lifecycle tests              |
| Workflows           | Repository workflows and validation          |
| Tests               | Compatibility fixtures and regression tests  |
| Runtime adapters    | Host packaging or a documented design review |
| Supporting code     | Maintainer review                            |

The scheduled workflow publishes this report as a GitHub Actions summary and
artifact. Maintainers review it before changing the plugin, so behavior changes
remain explicit and testable.
