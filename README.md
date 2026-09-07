# Less OpenWiki

Less OpenWiki turns a coding agent into a reliable repository-documentation
partner for Codex and Claude Code. It researches the repository, writes a
focused `openwiki/` knowledge base, and maintains durable documentation state
as the work proceeds.

## What it does

- Initializes and updates an `openwiki/` documentation map.
- Starts initialization from a clean generated wiki target while preserving the
  repository-owned `openwiki/INSTRUCTIONS.md` guidance; a clear initialize or
  reinitialize request intentionally replaces existing generated pages.
- Writes focused architecture, workflow, operations, integration, and testing
  pages rather than a directory-by-directory inventory.
- Creates a semantic page plan, then runs it as a resumable, ordered queue.
- Reviews source changes from each page's own saved source baseline, preserving
  correct incremental updates after partial or resumed runs.
- Reconciles material Claims against repository evidence, then projects
  provenance and sources into pages and the page manifest.
- Detects source drift, preserves validated completed pages while marking their
  source checkpoint interrupted for reconciliation, rebuilds indexes, and
  validates pages before completion.
- Restores a failed page attempt to its pre-run Markdown and Claims snapshot,
  retaining prior coverage while recording the remaining run as interrupted.
- Applies the same structured YAML/OKF metadata checks in both supported hosts,
  including provenance, verification, sources, lifecycle status, and timestamps.
- Keeps a `quickstart.md` routing page and repository agent instructions
  current.
- Produces a reviewable upstream-change report for maintainers.

## Install

### Codex

This repository contains a Codex marketplace at
`.agents/plugins/marketplace.json`.

```sh
codex plugin marketplace add .
codex plugin add less-openwiki@less-openwiki
```

Start a new Codex thread, invoke `$less-openwiki`, or ask Codex to initialize
or update repository documentation. Review and trust the plugin hooks when
Codex asks; they keep documentation runs durable across the full lifecycle.

### Claude Code

This repository also contains a Claude Code marketplace and plugin manifest.

```text
/plugin marketplace add biwsantang/less-openwiki
/plugin install less-openwiki@less-openwiki
```

Invoke `/less-openwiki:less-openwiki`, or ask Claude Code to initialize or
update repository documentation.

## Use

Typical prompts are:

```text
Initialize documentation for this repository.
Update the documentation for the current source changes.
Resume the interrupted documentation update.
```

The workflow uses `openwiki/` as its default documentation directory. It
honors `openwiki/INSTRUCTIONS.md` and `.openwikiignore` when they exist.

## Upstream change review

Fetch upstream and generate a review report whenever maintaining the fork:

```sh
git fetch upstream main
pnpm upstream:docs --base HEAD --upstream upstream/main --output upstream-docs-report.md
```

The report classifies incoming work by documentation, generation behavior,
workflows, tests, runtime adapters, and supporting code. Review it with the
plugin and carry relevant behavior into the shared skill, lifecycle hooks, or
engine as appropriate.

## Validation and development

```sh
pnpm plugin:validate
pnpm plugin:test
pnpm upstream:docs
```

`plugin:validate` checks the marketplaces, manifests, skill, hook package, and
repository wiki. `plugin:test` exercises lifecycle checkpointing, source drift,
Claims sidecars, manifest generation, and finalization. See [native plugin
architecture](docs/native-plugin.md) for the component model.

## License

MIT.
