# Skill-only architecture

Less OpenWiki packages one repository-documentation skill for Codex and Claude
Code. The host agent researches the repository, plans the documentation in the
task, writes ordinary Markdown, and reviews the completed diff.

```text
documentation request
        │
        ▼
shared skill ──► repository research and in-task plan
        │
        ▼
plain Markdown ──► focused pages, source references, quickstart, navigation
        │
        ▼
agent review ──► links, source paths, front matter, and changed pages
```

## Deliberate boundary

The plugin has no MCP server, public CLI, daemon, hooks, page queue, Claims
sidecars, or generated lifecycle state. It never creates these files or
directories beneath a target wiki:

```text
.run.json
.intents/
.claims/
.page-manifest.json
.last-update.json
.rollback/
```

This keeps a target repository's `wiki/` folder understandable without
knowing anything about Less OpenWiki. The cost is explicit: run completion,
incremental review, and factual source grounding are coding-agent work, not a
deterministic state machine.

## Workflow

1. The skill resolves the Git root and reads repository guidance, source, tests,
   existing pages, `wiki/INSTRUCTIONS.md`, and `.openwikiignore`.
2. It makes a concise page plan in the task conversation.
3. It authors or revises ordinary Markdown pages with simple front matter and
   visible source references.
4. It maintains `quickstart.md` and, when useful, marker-owned routing blocks
   in root `AGENTS.md` and `CLAUDE.md`.
5. It reviews the diff, links, source paths, and navigation before reporting the
   work completed.

For updates, the agent compares source history and current source with the
existing pages. A clean review can report that no edits were needed, but it does
not write a state file or claim a machine-verified no-op. An interrupted effort
is resumed by reviewing the existing Markdown, not by recovering a private run.

## Packaging

```text
plugins/less-openwiki/
├── .codex-plugin/plugin.json
├── .claude-plugin/plugin.json
└── skills/openwiki/
    ├── SKILL.md
    └── references/
        ├── maintenance.md
        ├── markdown-format.md
        └── research-and-authoring.md
```

The Codex manifest exposes only `skills`. Claude Code discovers the same skill
directory through its plugin package. Both marketplaces point at this one
package, so `/openwiki` has the same documentation workflow in both hosts.

## Upstream maintenance

The upstream project remains a source of repository-wiki behavior and quality
standards. Its CLI, MCP lifecycle protocol, personal knowledge features,
connectors, visualizer, and scheduled updater are not migration targets.

`scripts/upstream-docs-report.mjs` groups changes from `upstream/main` for
maintainer review. Route repository documentation behavior to the skill or its
references; record intentionally excluded product surfaces in
`docs/upstream-parity.md`.
