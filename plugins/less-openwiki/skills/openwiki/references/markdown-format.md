# Markdown format

Every factual page begins with simple YAML front matter:

```yaml
---
type: architecture
title: Authentication flow
description: How the repository authenticates requests and owns session state.
tags: [authentication, sessions]
sources:
  - src/auth/session.ts
  - test/auth/session.test.ts
---
```

Use a short descriptive `type`, a retrieval-friendly `title` and `description`,
and stable English tags. `sources` is optional but recommended for factual
pages. It is ordinary user-visible Markdown metadata, not generated provenance.

Use relative Markdown links for wiki navigation. Keep `quickstart.md` as the
entry page: explain the wiki's purpose and link readers to the most useful
concept, architecture, workflow, operations, integration, and testing pages.

Link only to files that exist. If a source location is uncertain or volatile,
cite the file rather than inventing an exact line range.
