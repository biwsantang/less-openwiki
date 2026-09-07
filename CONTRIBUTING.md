# Contributing to Less OpenWiki

Less OpenWiki is a native coding-agent documentation plugin. Contributions
improve the shared skill, lifecycle hooks, deterministic engine, documentation,
or upstream maintenance path.

## Scope

Keep each pull request focused on one of these areas:

- repository documentation workflow and templates;
- Codex or Claude Code package compatibility;
- lifecycle state, validation, Claims, indexes, provenance, or recovery;
- upstream-change review tooling;
- documentation and workflow maintenance.

## Before opening a PR

```sh
pnpm plugin:validate
pnpm plugin:test
pnpm run format:check
```

If upstream is involved, include the generated upstream-change report and state
which component receives the change: shared skill, hook engine, workflow,
package metadata, or regression test.

## Plugin compatibility

Keep the manifests and hook package synchronized:

- Codex: `plugins/less-openwiki/.codex-plugin/plugin.json`
- Claude Code: `plugins/less-openwiki/.claude-plugin/plugin.json`
- shared hooks: `plugins/less-openwiki/hooks/hooks.json`

Both hosts use the shared workflow and deterministic engine. Preserve the
repository output contracts described in [native plugin
architecture](docs/native-plugin.md).
