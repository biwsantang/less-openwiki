# Native Plugin Architecture

## Product boundary

Less OpenWiki is a documentation workflow packaged as a Codex plugin and a
Claude Code plugin. The host agent supplies its model, file tools, Git access,
and approval policy. The plugin supplies the repeatable documentation method,
deterministic validation, and upstream migration reporting.

```text
Host agent + Less OpenWiki skill
          │
          ├── repository research and Markdown authoring
          ├── validate-wiki.mjs
          └── upstream-docs-report.mjs
```

There is no standalone `openwiki` command, local MCP lifecycle service, or
second provider/model configuration in this distribution.

## Compatibility

The plugin root contains both manifests and one shared skill:

| Host        | Manifest                     | Marketplace                        |
| ----------- | ---------------------------- | ---------------------------------- |
| Codex       | `.codex-plugin/plugin.json`  | `.agents/plugins/marketplace.json` |
| Claude Code | `.claude-plugin/plugin.json` | `.claude-plugin/marketplace.json`  |

The shared skill uses only host-native repository capabilities, so it avoids a
host-specific tool protocol. Host-specific hooks remain optional and must only
validate or provide status; they must not become a second agent runtime.

## Upstream migration contract

The `upstream-docs-report.mjs` script compares the merge base of a local base
ref and an upstream ref with the upstream side. This yields the upstream changes
that arrived after the branches diverged, even when the fork has native-plugin
changes of its own.

The report classifies files so migration stays intentional:

- **Documentation** and **Generation behavior** are candidates for porting into
  the skill or validators.
- **Workflows** are candidates when they verify the plugin or report upstream
  drift without running an LLM.
- **Legacy CLI/MCP** changes are tracked but excluded by default.

The scheduled workflow creates the report as a GitHub Actions summary and
artifact. It does not modify documentation or open a pull request; an agent or
maintainer reviews the report before migrating behavior.
