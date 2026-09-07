# Native Plugin Architecture

Less OpenWiki packages one documentation workflow for Codex and Claude Code.
The host agent researches and writes; the plugin provides the durable lifecycle
around that work.

```text
documentation request
        │
        ▼
shared skill ──► research and page authoring
        │                    │
        ▼                    ▼
required hooks ─────► state, Claims, indexes, validation, provenance
        │
        ▼
resumable completion
```

## Lifecycle

The hook engine runs at the native lifecycle points supplied by each host:

| Event                                 | Outcome                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `SessionStart` and `UserPromptSubmit` | Load or begin the durable documentation run.                                      |
| `PreToolUse`                          | Keep generated-page work on the assigned page and protect lifecycle-owned state.  |
| `PostToolUse`                         | Validate the page, synchronize its Claims sidecar, and checkpoint queue progress. |
| `Stop`                                | Finalize only when every queued page is valid; otherwise keep the run active.     |
| `SessionEnd`                          | Persist an interrupted checkpoint for the next session.                           |

The engine is an ordinary module invoked by these hooks. It has no background
service and no user-facing control surface. Its durable repository outputs are:

- `openwiki/.run.json` while a run is active;
- `openwiki/.claims/` for page grounding state;
- `openwiki/.page-manifest.json` for completed-page coverage; and
- `openwiki/.last-update.json` after completion or interruption.

The skill never edits those files directly. It reads the hook-provided current
page, researches repository evidence, and writes that page's Markdown.

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
