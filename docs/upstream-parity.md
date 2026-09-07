# Upstream repository-wiki migration matrix

Less OpenWiki preserves the useful repository-documentation practices from
OpenWiki while deliberately removing its executable lifecycle protocol.

| Upstream repository-wiki behavior                                       | Skill-only implementation                        | Status                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------- |
| Repository research and focused semantic taxonomy                       | `SKILL.md` and research reference                | Preserved                                |
| Page purpose, source paths, related topics, and update review           | In-task plan and ordinary page/source references | Preserved as agent work                  |
| Page-quality guidance                                                   | Research and authoring reference                 | Preserved                                |
| Basic OKF-style front matter and navigation                             | Markdown-format reference and `quickstart.md`    | Preserved as plain Markdown              |
| `INSTRUCTIONS.md`, `.openwikiignore`, root routing blocks               | Maintenance reference                            | Preserved as agent work                  |
| Initialize, update, reinitialize, and stale-doc repair                  | Maintenance and update instructions              | Preserved as agent work                  |
| Ordered page queue, run resume, rollback, and automatic finalization    | None                                             | Intentionally removed                    |
| Claims IDs, evidence versions, sidecars, and stale-Claim reconciliation | Visible source references in Markdown            | Simplified; deterministic Claims removed |
| Manifest coverage, source snapshots, and formal no-op state             | Git review and explicit completion report        | Simplified; generated metadata removed   |
| Host lifecycle integration                                              | None                                             | Intentionally removed; no hooks or MCP   |

## Explicitly excluded upstream product surfaces

- Standalone CLI and provider/auth configuration.
- MCP server and host integration installer.
- Personal knowledge mode and external connectors.
- Visualizer/export server.
- Cron and CI documentation updater.
- OpenCode and Cursor packaging.

These surfaces are outside the Codex-and-Claude-Code repository skill. Do not
reintroduce them indirectly through hooks, scripts that create target state, or
hidden runtime folders.

## Reviewing upstream changes

```sh
git fetch upstream main
pnpm upstream:docs --base HEAD --upstream upstream/main --output upstream-docs-report.md
```

Review documentation and generation-behavior groups first. Migrate a relevant
repository-wiki practice into `SKILL.md` or a narrowly scoped reference. When a
change depends on an upstream CLI, MCP protocol, generated Claim state, or
background service, record it as excluded unless the plugin boundary is changed
deliberately.

After a migration change, run:

```sh
pnpm plugin:validate
pnpm format:check
pnpm upstream:docs
```
