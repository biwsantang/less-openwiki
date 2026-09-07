## Less OpenWiki

This repository ships a native repository-documentation plugin for Codex and
Claude Code. Start with [the native plugin architecture](docs/native-plugin.md)
and the shared skill at
`plugins/less-openwiki/skills/less-openwiki/SKILL.md`.

The `src/`, `integrations/`, and generated `openwiki/` trees are retained as
upstream-reference material. They are not the Less OpenWiki runtime. Do not
restore standalone CLI, MCP, provider-auth, or connector features unless the
task explicitly requires a new native-plugin design.

When changing documentation behavior, run `pnpm plugin:validate`. When merging
upstream, fetch `upstream/main`, generate the migration report with
`pnpm upstream:docs`, and port only the relevant documentation behavior.
