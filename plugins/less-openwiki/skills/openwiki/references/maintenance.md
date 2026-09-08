# Maintenance

## New wiki

Create `wiki/quickstart.md` and a focused set of pages for the repository's
important systems and workflows. Create `wiki/INSTRUCTIONS.md` only when
the user asks for repository-specific documentation guidance; otherwise leave
it absent. Never overwrite an existing instructions file.

## Reinitialization

Only replace existing wiki pages after the user explicitly asks to initialize
again, regenerate, or reinitialize. Preserve `wiki/INSTRUCTIONS.md` and
any clearly user-authored pages unless the user explicitly includes them in the
replacement scope. When ownership is unclear, ask before deleting content.

## Updates

Read the existing page before changing it. Use `git log`, `git diff`, and the
page's source references to identify likely affected pages. Review source and
tests before changing factual text. A source change can require updating more
than one conceptual page.

## Root agent routing

When the repository benefits from it, add this line to each root guidance file
when it is absent:

```markdown
Read `wiki/quickstart.md` for the repository documentation map.
```

Preserve all existing guidance. If the file has conflicting routing guidance,
ask before replacing it; never infer ownership of surrounding text.

## Completion

Before reporting completion, review the diff, verify links and source paths,
and state what was checked. The absence of a state file is intentional: report
an evidence-based review result, not a machine-certified lifecycle status.
