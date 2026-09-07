# Contributing to Less OpenWiki

Less OpenWiki is a native coding-agent documentation plugin. Contributions
should improve the shared skill, its local validators, documentation quality,
or the upstream migration path.

## Scope

Keep each pull request to one of these areas:

- repository documentation workflow and templates;
- plugin compatibility for Codex or Claude Code;
- deterministic validation and migration tooling;
- documentation and workflow maintenance.

Do not add a standalone documentation CLI, an MCP lifecycle server, model
provider configuration, or host-specific installers unless the project
explicitly adopts that broader product direction.

## Before opening a PR

```sh
pnpm plugin:validate
pnpm run format:check
```

If upstream is involved, include the generated upstream migration report and
state which Documentation or Generation behavior changes were carried forward.
Legacy CLI/MCP changes should be recorded as intentionally not migrated unless
the PR has an approved replacement in the native plugin.

## Plugin compatibility

The plugin must keep both manifests synchronized:

- Codex: `plugins/less-openwiki/.codex-plugin/plugin.json`
- Claude Code: `plugins/less-openwiki/.claude-plugin/plugin.json`

Keep the shared workflow in `plugins/less-openwiki/skills/less-openwiki/`.
Both hosts use their own model sessions and repository tools; the plugin must
not require separate provider credentials.
