# Contributing to Less OpenWiki

Less OpenWiki is a skill-only repository documentation plugin for Codex and
Claude Code. Contributions improve the shared skill, its references,
documentation, marketplace packages, validation, or upstream-review tooling.

## Scope

Keep each pull request focused on one of these areas:

- repository documentation workflow, references, and templates;
- Codex or Claude Code skill package compatibility;
- Markdown quality, source grounding, navigation, and update guidance;
- upstream-change review tooling; or
- documentation and workflow maintenance.

Do not add hooks, MCP servers, a public CLI, background processes, or generated
wiki lifecycle state unless the project boundary is intentionally reconsidered.

## Before opening a PR

```sh
pnpm plugin:validate
pnpm format:check
```

If upstream is involved, include the generated upstream-change report and state
whether the change belongs in the shared skill, a skill reference,
documentation, package metadata, or validation.

## Plugin compatibility

Keep the manifests and shared skill aligned:

- Codex: `plugins/less-openwiki/.codex-plugin/plugin.json`
- Claude Code: `plugins/less-openwiki/.claude-plugin/plugin.json`
- workflow: `plugins/less-openwiki/skills/openwiki/`

Both hosts use the same plain-Markdown output contract described in the
[skill-only architecture](docs/native-plugin.md).
