## Less OpenWiki

This repository ships a native repository-documentation plugin for Codex and
Claude Code. Start with [the plugin architecture](docs/native-plugin.md), the
shared skill at `plugins/less-openwiki/skills/less-openwiki/SKILL.md`, and the
hook engine at `plugins/less-openwiki/hooks/less-openwiki-hook.mjs`.

The skill owns research and authoring. The hooks own run state, validation,
Claims sidecars, indexes, provenance, interruption, and finalization. Keep
those responsibilities separate so documentation runs remain resumable.

When changing documentation behavior, run `pnpm plugin:validate` and
`pnpm plugin:test`. When merging upstream, fetch `upstream/main`, generate the
report with `pnpm upstream:docs`, and map each relevant change to the skill,
hooks, engine, workflow, or test suite.
