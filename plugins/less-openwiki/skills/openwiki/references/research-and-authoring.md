# Research and authoring

Research before writing. Start with repository guidance, manifests, entry
points, and existing wiki pages. Follow the concrete code paths needed to
explain a page's subject: callers and callees, state and persistence owners,
configuration, error handling, integration boundaries, and focused tests.

Use a page only for a meaningful system, concept, workflow, operation,
integration, or testing concern. Do not create a page merely to list symbols or
mirror a source directory.

For factual prose, make the supporting repository evidence visible. Cite paths
in prose, Markdown links, or the page's `sources` front-matter list. Prefer
bounded references such as `src/auth/session.ts:40-82` when practical. A source
reference should support the statement it accompanies; do not claim behavior
that the current source and tests do not establish.

For a substantial page, explain the relevant subset of:

- responsibility and ownership;
- runtime or build entry points;
- control flow and data flow;
- state, persistence, and ordering;
- invariants and failure behavior;
- configuration, security, and operational consequences;
- integration and extension boundaries; and
- representative tests.

Preserve accurate unaffected content during an update. When the source
contradicts a page, revise or remove the affected statement and its source
reference in the same change.
