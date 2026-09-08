# Less OpenWiki

Less OpenWiki is a skill-only repository documentation plugin for Codex and
Claude Code. It helps the coding agent research a repository and create a
focused, source-grounded Markdown wiki under `wiki/`.

There is no MCP server, public CLI, daemon, required hook, or hidden lifecycle
state. The wiki remains ordinary repository content that people and agents can
read and maintain directly.

## What it does

- Initializes or updates a focused `wiki/` documentation map.
- Plans around meaningful architecture, workflows, operations, integrations, and
  tests instead of mirroring directories.
- Grounds factual text in current repository source and tests.
- Maintains plain front matter, navigation, `quickstart.md`, and optional root
  `AGENTS.md` / `CLAUDE.md` routing guidance.
- Honors repository-owned `wiki/INSTRUCTIONS.md` and `.openwikiignore`.
- Repairs stale documentation by reviewing current Markdown and source changes.
- Produces an upstream migration report for plugin maintainers.

It deliberately does not create `wiki/.run.json`, `.intents/`, `.claims/`,
`.page-manifest.json`, `.last-update.json`, or `.rollback/`.

## Install

### Codex

This repository contains a Codex marketplace at
`.agents/plugins/marketplace.json`.

```sh
codex plugin marketplace add .
codex plugin add less-openwiki@less-openwiki
```

Start a new repository task and invoke `$openwiki`, or ask Codex to initialize,
update, or repair the repository documentation.

### Claude Code

This repository also contains a Claude Code marketplace and plugin manifest.

```text
/plugin marketplace add biwsantang/less-openwiki
/plugin install less-openwiki@less-openwiki
```

Invoke `/less-openwiki:openwiki`, or ask Claude Code to initialize, update, or
repair repository documentation.

## Use

Typical prompts are:

```text
Initialize documentation for this repository.
Update the documentation for the current source changes.
Review and repair stale pages in wiki/.
```

The skill keeps its plan in the task conversation and writes ordinary Markdown.
Before it reports completion, it reviews links, source references, navigation,
and front matter. It reports the evidence reviewed rather than claiming an
automatic lifecycle or machine-certified no-op.

## Upstream change review

The original OpenWiki project remains the reference for repository-wiki quality,
not for transport or runtime architecture. Fetch upstream and generate a report
when maintaining this fork:

```sh
git fetch upstream main
pnpm upstream:docs --base HEAD --upstream upstream/main --output upstream-docs-report.md
```

Use the [upstream parity matrix](docs/upstream-parity.md) to route relevant
repository-wiki behavior into the skill or its references. CLI, MCP, personal
knowledge, connectors, visualizer, and scheduling features are intentionally
out of scope.

## Validation and development

```sh
pnpm plugin:validate
pnpm format:check
pnpm upstream:docs
```

`plugin:validate` checks the marketplaces, manifests, skill-only package shape,
and the repository's plain Markdown wiki. See the [skill-only architecture](docs/native-plugin.md)
for the component model.

## License

MIT.
