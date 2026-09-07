import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hash, isDirectory, relative } from "./storage.mjs";

/** Applies page-local provenance and Claims-source projections after Claims succeeds. */
export async function finalizePage(root, page, actor, claims) {
  await projectClaimSources(root, page, claims);
  const file = path.join(root, page);
  const content = await readFile(file, "utf8");
  const next = content.replace(
    /^---\r?\n([\s\S]*?)\r?\n---/u,
    (_all, frontmatter) =>
      `---\n${frontmatter.replace(/^generated:\n(?:[ \t].*\n?)*/mu, "").trimEnd()}\ngenerated:\n  by: ${actor}\n  at: ${new Date().toISOString()}\n---`,
  );
  if (next !== content)
    await writeFile(file, next.endsWith("\n") ? next : `${next}\n`, "utf8");
}

/** Builds deterministic index pages after all factual pages and Claims validate. */
export async function finalizeWiki(root) {
  const wikiRoot = path.join(root, "openwiki");
  for (const directory of await directories(wikiRoot)) {
    const entries = await readdir(directory, { withFileTypes: true });
    const links = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          entry.name !== "index.md" &&
          !entry.name.startsWith("."),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (entry) =>
          `- [${title(entry.name.replace(/\.md$/u, ""))}](${encodeURIComponent(entry.name)})`,
      );
    const children = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (entry) =>
          `- [${title(entry.name)}](${encodeURIComponent(entry.name)}/)`,
      );
    if (!links.length && !children.length) continue;
    const label = relative(wikiRoot, directory) || "Documentation";
    await writeFile(
      path.join(directory, "index.md"),
      `---\ntype: index\ntitle: ${title(label)}\ndescription: Documentation navigation.\n---\n\n# ${title(label)}\n\n${[...children, ...links].join("\n")}\n`,
      "utf8",
    );
  }
}

async function projectClaimSources(root, page, claims) {
  const file = path.join(root, page);
  const content = await readFile(file, "utf8");
  const resources = [
    ...new Set(
      claims.flatMap((claim) =>
        claim.evidence.map(({ resource }) => resource.replace(/#.*/u, "")),
      ),
    ),
  ].sort();
  const sourceLines = resources
    .map(
      (resource) =>
        `  - id: openwiki-source-${hash(resource).slice("sha256:".length, 24)}\n    resource: ${resource}`,
    )
    .join("\n");
  const next = content.match(/^---\r?\n([\s\S]*?)\r?\n---/u)
    ? content.replace(
        /^---\r?\n([\s\S]*?)\r?\n---/u,
        (_all, frontmatter) =>
          `---\n${frontmatter.replace(/^sources:\n(?:[ \t].*\n?)*/mu, "").trimEnd()}\nsources:\n${sourceLines}\n---`,
      )
    : content;
  if (next !== content) await writeFile(file, next, "utf8");
}

async function directories(root) {
  if (!(await isDirectory(root))) return [];
  const out = [root];
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.name.startsWith("."))
      out.push(...(await directories(path.join(root, entry.name))));
  return out.sort();
}
function title(value) {
  return value
    .split(/[\\/]/u)
    .map((part) =>
      part
        .replace(/[-_]/gu, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase()),
    )
    .join(" / ");
}
