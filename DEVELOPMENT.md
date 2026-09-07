# Development

Less OpenWiki is a native coding-agent documentation plugin.

## Plugin layout

- `plugins/less-openwiki/.codex-plugin/plugin.json` is the Codex manifest.
- `plugins/less-openwiki/.claude-plugin/plugin.json` is the Claude Code
  manifest.
- `plugins/less-openwiki/skills/less-openwiki/SKILL.md` is the shared workflow.
- `plugins/less-openwiki/hooks/hooks.json` binds host lifecycle events to the
  shared hook engine.
- `plugins/less-openwiki/hooks/less-openwiki-hook.mjs` owns deterministic
  state, validation, Claims sidecars, indexes, provenance, and recovery.
- `plugins/less-openwiki/scripts/` contains validation and upstream-review
  tooling.
- `.agents/plugins/marketplace.json` and `.claude-plugin/marketplace.json`
  publish the plugin from this repository.

Validate the distribution and its lifecycle behavior with:

```sh
pnpm plugin:validate
pnpm plugin:test
```

## Lifecycle changes

Keep the boundary clear:

- The skill directs repository research and Markdown authoring.
- Hooks translate host events into the engine's deterministic actions.
- The engine writes `openwiki/.run.json`, `.claims`, indexes, manifests,
  provenance, and update metadata.

Update the engine and its regression tests together whenever any lifecycle
invariant changes. Check both hosts' hook schemas after changing
`hooks/hooks.json`.

## Tracking upstream

```sh
git fetch upstream main
pnpm upstream:docs --base HEAD --upstream upstream/main --output upstream-docs-report.md
```

Review the report with the shared skill. Route documentation changes to the
skill and user docs, generation behavior to the engine and tests, workflows to
CI, and adapter changes to the appropriate host package.

After editing plugin files, run the validation commands and start a new Codex
or Claude Code session after reinstalling the plugin so the host reloads it.
