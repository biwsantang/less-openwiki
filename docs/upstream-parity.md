# Upstream parity and maintenance

Less OpenWiki preserves the repository-documentation workflow as a native
coding-agent plugin. This matrix is a maintainer aid: it identifies the
observable documentation behavior that must remain compatible and the native
component that enforces it.

| Repository documentation behavior                                                   | Native implementation                                                                       | Regression evidence                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Start, resume, mode/language conflict checks, and no-change updates                 | Prompt/session hooks with `runtime/lifecycle.mjs`                                           | Lifecycle, language, no-op, and resume cases                           |
| Focused semantic plans, repository instructions, and ordered page assignments       | Private plan intent plus durable active-job hook context                                    | Plan validation, instruction, and queue-order cases                    |
| Page checkpointing, Claims reconciliation, and durable per-page coverage            | Post-write hook with `claims.mjs`, `okf.mjs`, and the page manifest                         | Claims, checkpoint, manifest, and proof-recovery cases                 |
| Repository evidence versions and read boundary                                      | `evidence.mjs` and `.openwikiignore` processing                                             | Whole-file, line-range, traversal, symlink, and ignore cases           |
| Incremental source review                                                           | Source snapshots and per-page Git baselines in `storage.mjs` and `lifecycle.mjs`            | Source-drift, mixed-baseline, staged/unstaged, and docs-only cases     |
| OKF repair, provenance, verification, sources, links, Mermaid fallback, and indexes | `okf.mjs`                                                                                   | Structured YAML/OKF, provenance, link, Mermaid, and finalization cases |
| Abandoned page work                                                                 | `{ "action": "skip" }` private page intent, rollback snapshot, and interrupted finalization | Existing-page and newly-planned-page skip cases                        |
| Codex and Claude Code lifecycle integration                                         | Shared hook adapter plus both plugin manifests and marketplaces                             | Native plugin, Codex, and Claude validation commands                   |

## Native boundary

The plugin deliberately uses the host agent's normal prompt and repository
tools. It does not publish a separate command-line interface, MCP server, or
background process. Private intents and the bundled runtime are implementation
details used by required hooks to make the same repository files and lifecycle
guarantees durable.

The visualizer/export surface is likewise not part of this native
repository-documentation workflow. Windows portability is outside this fork's
supported scope; hook commands target POSIX host environments.

## Reviewing upstream changes

Fetch the configured upstream remote, then generate the report from the branch
being maintained:

```sh
git fetch upstream main
pnpm upstream:docs --base HEAD --upstream upstream/main --output upstream-docs-report.md
```

Route each report entry with the matrix above:

| Upstream change area                                                     | Native destination                                                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Documentation behavior, Claims, OKF, source snapshots, or page manifests | `plugins/less-openwiki/runtime/` and `test/native-plugin/`                             |
| Host-facing workflow or instructions                                     | `skills/openwiki/SKILL.md`, `docs/`, and `README.md`                                   |
| Hook event contract or packaging                                         | `hooks/`, both manifests, marketplaces, and plugin validation                          |
| Removed transport or visualization surface                               | Record a maintainer decision here only if it affects repository-documentation behavior |

After a migration change, run:

```sh
pnpm plugin:test
pnpm format:check
pnpm plugin:validate
claude plugin validate plugins/less-openwiki
pnpm upstream:docs
```

The project-local native suite is the behavioral gate. The upstream test
command includes intentionally absent transport and visualizer components, so
it is not the native plugin's parity gate.
