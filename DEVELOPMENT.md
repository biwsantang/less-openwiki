# Development

Less OpenWiki is a skill-only repository documentation plugin.

## Plugin layout

- `plugins/less-openwiki/.codex-plugin/plugin.json` is the Codex manifest.
- `plugins/less-openwiki/.claude-plugin/plugin.json` is the Claude Code
  manifest.
- `plugins/less-openwiki/skills/openwiki/SKILL.md` is the shared workflow.
- `plugins/less-openwiki/skills/openwiki/references/` contains focused guidance
  for research, maintenance, and Markdown formatting.
- `.agents/plugins/marketplace.json` and `.claude-plugin/marketplace.json`
  publish the plugin from this repository.
- `scripts/validate-wiki.mjs` checks plain wiki structure and front matter.
- `scripts/upstream-docs-report.mjs` reports upstream changes for maintainers.

Validate the distribution with:

```sh
pnpm plugin:validate
pnpm format:check
```

## Documentation changes

Keep responsibilities direct:

- The skill directs research, planning, writing, and update review.
- References provide detailed guidance only when the task needs it.
- Generated output is ordinary Markdown and optional marker-owned routing blocks.
- The agent reports evidence reviewed; it does not claim hidden lifecycle state,
  automatic rollback, or a machine-certified no-op.

Do not create `.run.json`, `.intents/`, `.claims/`, `.page-manifest.json`,
`.last-update.json`, or `.rollback/` beneath a target wiki.

## Tracking upstream

```sh
git fetch upstream main
pnpm upstream:docs --base HEAD --upstream upstream/main --output upstream-docs-report.md
```

Review the report with the shared skill. Route repository-wiki behavior into the
skill, a reference, user documentation, validation, or a deliberate exclusion.
The upstream CLI, MCP lifecycle, personal knowledge features, connectors,
visualizer, and scheduler remain reference material rather than plugin targets.

After editing plugin files, validate the package and start a new Codex or Claude
Code session after reinstalling the plugin so the host reloads the skill.
