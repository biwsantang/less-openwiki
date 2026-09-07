# Less OpenWiki

Less OpenWiki is a native repository-documentation plugin for **Codex** and
**Claude Code**. Your coding agent researches the repository, writes Markdown,
and validates the result with its own authenticated model and local tools.

It intentionally does **not** run an OpenWiki CLI, configure model providers,
or start an MCP server.

## What it does

- Initializes and updates an `openwiki/` documentation map for a repository.
- Produces focused architecture, workflow, operations, integration, and testing
  pages rather than a directory-by-directory inventory.
- Maintains a `quickstart.md` routing page and repository agent instructions.
- Requires factual pages to have portable `type`, `title`, and `description`
  front matter.
- Validates documentation before the agent reports completion.
- Reports upstream documentation, generation, workflow, and legacy-runtime
  changes so this fork can be reconciled deliberately.

## Install

### Codex

This repository contains a Codex marketplace at
`.agents/plugins/marketplace.json`. Add the repository as a local marketplace,
install `less-openwiki`, and start a new Codex thread.

```sh
codex plugin marketplace add .
codex plugin add less-openwiki@less-openwiki
```

Invoke it explicitly with `$less-openwiki`, or ask Codex to initialize or update
repository documentation.

### Claude Code

This repository also contains a Claude Code marketplace and plugin manifest.

```text
/plugin marketplace add biwsantang/less-openwiki
/plugin install less-openwiki@less-openwiki
```

Invoke `/less-openwiki:less-openwiki`, or ask Claude Code to initialize or
update the repository documentation.

## Use

Typical prompts are:

```text
Initialize documentation for this repository.
Update the documentation for the current source changes.
Review the upstream documentation migration report and apply the relevant changes.
```

The skill uses `openwiki/` as the default documentation directory. It honors
`openwiki/INSTRUCTIONS.md` and `.openwikiignore` when they exist.

## Upstream documentation migration

The original OpenWiki implementation remains in this fork as an
**upstream-reference source tree**. It is not part of the native plugin's
runtime. Keeping it in place makes upstream changes inspectable instead of
silently losing useful documentation behavior.

Fetch upstream, generate a report, then use the native skill to migrate the
documentation-relevant changes:

```sh
git fetch upstream main
pnpm upstream:docs -- --base HEAD --upstream upstream/main --output upstream-docs-report.md
```

The report separates incoming changes into Documentation, Generation behavior,
Workflows, Tests, Legacy CLI/MCP, and Supporting code. Native-plugin migration
does not automatically restore CLI/MCP behavior.

## Deliberately out of scope

- Standalone `openwiki` commands, terminal UI, and provider credential setup.
- The OpenWiki MCP server and host-specific integration installers.
- Personal knowledge mode, OAuth connectors, ngrok, and connector scheduling.
- Automatic scheduled LLM documentation rewrites.

These features depended on a second agent runtime or external integrations.
They can be designed as separate opt-in plugins later without complicating the
repository-documentation workflow.

## Validation and development

```sh
pnpm plugin:validate
pnpm upstream:docs
```

`plugin:validate` checks both plugin manifests, both marketplaces, the native
skill, and the repository wiki front matter. See
[native plugin architecture](docs/native-plugin.md) for the compatibility and
maintenance model.

## License

MIT. The upstream-reference source is retained under its original MIT license.
