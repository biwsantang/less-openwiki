# Development

Less OpenWiki is developed as a native coding-agent plugin, not as a standalone
CLI or MCP service.

## Plugin layout

- `plugins/less-openwiki/.codex-plugin/plugin.json` is the Codex manifest.
- `plugins/less-openwiki/.claude-plugin/plugin.json` is the Claude Code
  manifest.
- `plugins/less-openwiki/skills/less-openwiki/SKILL.md` is the shared workflow.
- `plugins/less-openwiki/scripts/` contains dependency-free validation and
  upstream-migration tools.
- `.agents/plugins/marketplace.json` and `.claude-plugin/marketplace.json`
  publish the plugin from this repository.

Validate the distribution and existing repository documentation with:

```sh
pnpm plugin:validate
```

## Tracking upstream

The legacy source tree remains only to make upstream feature migrations
auditable. It is not a supported runtime.

```sh
git fetch upstream main
pnpm upstream:docs -- --base HEAD --upstream upstream/main --output upstream-docs-report.md
```

Review the report with the native skill. Port documentation behavior only when
it fits the native-agent model; do not revive standalone CLI, MCP, or
provider-auth surfaces by accident.

## Editing the skill

Keep `SKILL.md` focused on repository documentation. It should direct the host
agent to research, author, and validate docs through native tools. It must not
assume an OpenWiki MCP server, a bundled model, or user API keys.

After editing plugin files, run `pnpm plugin:validate`. Start a new Codex or
Claude Code session after reinstalling a plugin so the host reloads its skill.
