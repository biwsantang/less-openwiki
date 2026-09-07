## Less OpenWiki

This repository ships a skill-only repository-documentation plugin for Codex
and Claude Code. Start with [the plugin architecture](docs/native-plugin.md)
and the shared skill at `plugins/less-openwiki/skills/openwiki/SKILL.md`.

The skill owns planning, source research, Markdown authoring, update review,
and ordinary wiki validation. It creates no hidden lifecycle state and exposes
no hook, CLI, MCP, daemon, or generated Claims protocol.

When changing documentation behavior, run `pnpm plugin:validate`. When merging
upstream, fetch `upstream/main`, generate the report with `pnpm upstream:docs`,
and map relevant repository-wiki behavior into the shared skill, its references,
documentation, and validation.
