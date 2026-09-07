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

| Event                                 | Outcome                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `SessionStart` and `UserPromptSubmit` | Load or begin the run when the session itself has a Git worktree.                                         |
| `PreToolUse`                          | Resolve an explicit OpenWiki file target, bind a projectless task, protect state, and bootstrap planning. |
| `PostToolUse`                         | Consume semantic intent, validate, reconcile Claims, and checkpoint the bound worktree.                   |
| `Stop`                                | Finalize valid queued work for the session-bound worktree.                                                |
| `SessionEnd`                          | Persist an interrupted checkpoint and clear the ephemeral session binding.                                |

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

### Projectless tasks and target binding

Codex supplies hooks with the task's session CWD, which may be a projectless
folder even when the agent later edits a repository elsewhere. For a
projectless task, Less OpenWiki deliberately does not select a repository from
prompt text or by parsing shell commands. Its first structured edit of an
absolute `openwiki/.intents/plan.json` path resolves one Git worktree, starts
the lifecycle there, and creates an owner-only temporary session binding from
the host session ID to that run. Post-tool, stop, and session-end events use
that binding. It is cleared when the run completes or the session ends and
expires if left behind after a host crash.

An operation that targets multiple Git worktrees, escapes the chosen
`openwiki/` directory through a symlink, or mixes source edits with OpenWiki
writes is denied before it can create lifecycle state. A projectless task can
therefore safely document one explicitly selected repository without a CLI,
MCP server, daemon, or global “current repository” setting.

At the same startup boundary, the runtime maintains upstream-compatible
`<!-- OPENWIKI:START -->` / `<!-- OPENWIKI:END -->` blocks in root `AGENTS.md`
and `CLAUDE.md`. It creates either file when missing, replaces only one valid
existing block, preserves surrounding user content, and refuses to write
either file when one has malformed or duplicated markers.

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

If a repository contains private intents but no `.run.json`, those files were
never accepted lifecycle state. The first repair activation snapshots them in
`openwiki/.recovery/<run-id>/` and starts a `repair` planning run. The agent
must submit a fresh semantic plan; old intents are evidence for recovery, not
trusted instructions that can be silently consumed. Existing factual pages are
retained for validation and Claims reconstruction.

An explicit initialize or reinitialize request replaces existing generated wiki
state (pages, indexes, logs, sidecars, and lifecycle metadata) with a clean
generation target. The lifecycle takes a private, recoverable backup until the
new run state and interrupted metadata are durable, and preserves only
repository-owned `openwiki/INSTRUCTIONS.md` when it is a regular file. This is
the same reset boundary used by the upstream repository lifecycle. Its trimmed
contents are persisted as the run's repository instructions and repeated in
planning and active-page hook context, so a resumed host retains the same
guidance.

Update planning derives a source-review window for each factual page from that
page's saved manifest Git revision, rather than assuming the most recent wiki
run covered every page. The hook provides those grouped windows in its planning
context; a page without a saved revision is explicitly marked for a full review.
This preserves correct incremental updates after partially completed or resumed
runs.

Before a clean update is reported as a no-op, the lifecycle re-snapshots source
after advancing manifest coverage. If source moved during that durable write,
it starts a normal interrupted update instead of publishing stale “current”
metadata.

When a host provides a `language` value, it is validated as a BCP-47 code before
any run state is written. A resumed run cannot switch languages; use a new
update after the active run has completed or been reconciled. Conversational
language requests remain representable in the semantic plan.

On a stable resume, legacy run state that lacks its target Git revision is
backfilled from the current repository head before page coverage is reconciled.
Source drift instead replaces the old plan and establishes a new target.

For a completed legacy update that predates the per-page manifest, verified
current Claims seed missing page entries from the recorded successful Git head.
Unverifiable pages deliberately remain uncovered and enter the full-review
queue rather than receiving guessed coverage.

Resume re-proves every completed job against its current Markdown and Claims
sidecar. If the proof was lost, the run fails closed instead of publishing a
page that was edited after its checkpoint; valid deterministic finalizer
rewrites are re-recorded with the original page producer.

While generating or resuming, the hook also supplies the complete current page
job: its title, purpose, repository seed paths, related pages, and any planner
instructions, plus the existing Claim count and any stale or unresolved Claim
identifiers. This gives a fresh host session the same focused work context as
the upstream worker queue without exposing a separate command surface.
For an intentional change to a currently healthy Claim, the host can read the
current page sidecar to inspect its IDs and evidence; hooks continue to reserve
all durable Claims writes for reconciliation.

When a page attempt must be abandoned, the host writes its current private
intent as `{ "action": "skip" }`. The hook restores the exact Markdown and
Claims snapshot from before page work, keeps its prior manifest coverage, then
finalizes any remaining completed pages with an `interrupted` checkpoint. It
clears the active run, so a later update plans the skipped page again rather
than publishing the partial attempt as complete.

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
both call the same engine and write the same repository state. Codex hooks are
explicitly declared in its manifest and must be reviewed and trusted in
`/hooks` before they can run.

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

See the [upstream parity matrix](upstream-parity.md) for the maintained mapping
between repository-documentation behavior, native components, and regression
coverage.
