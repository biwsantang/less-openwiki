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
  const generated = next.endsWith("\n") ? next : `${next}\n`;
  const verified = synchronizeVerification(generated, actor);
  if (verified !== content) await writeFile(file, verified, "utf8");
}

function synchronizeVerification(content, actor) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (!match) return content;
  const retained = [];
  const inline =
    /^verified:\s*\{\s*by:\s*([^,}]+)(?:,\s*at:\s*([^}]+))?\s*\}\s*$/mu.exec(
      match[1],
    );
  const verified = /^verified:\n((?:^[ \t].*(?:\n|$))*)/mu.exec(match[1]);
  if (inline && !inline[1].trim().startsWith("openwiki/")) {
    retained.push(`  - by: ${inline[1].trim()}`);
    if (inline[2]?.trim()) retained.push(`    at: ${inline[2].trim()}`);
  } else if (verified) {
    const entries = verified[1].split(/\r?\n/u);
    let event = [];
    const flush = () => {
      if (
        event.length &&
        !event.some((line) => /^\s*(?:-\s*)?by:\s*openwiki\//u.test(line))
      )
        retained.push(...event);
      event = [];
    };
    for (const line of entries) {
      if (/^\s*-\s*by:/u.test(line) && event.length) flush();
      if (line.trim()) event.push(line);
    }
    flush();
  }
  const clean = match[1]
    .replace(/^verified:\s*\{[^\n]*\}\s*\n?/mu, "")
    .replace(/^verified:\n(?:^[ \t].*(?:\n|$))*/mu, "")
    .trimEnd();
  const existing = retained.length ? `${retained.join("\n")}\n` : "";
  const block = `verified:\n${existing}  - by: ${actor}\n    at: ${new Date().toISOString()}\n`;
  return content.replace(
    /^---\r?\n([\s\S]*?)\r?\n---/u,
    `---\n${clean}\n${block}---`,
  );
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
  await validateInternalLinks(root);
  await degradeInvalidMermaid(root);
}

async function validateInternalLinks(root) {
  const wikiRoot = path.join(root, "openwiki");
  for (const file of await markdownFiles(wikiRoot)) {
    const original = await readFile(file, "utf8");
    const cleaned = original.replace(
      /^\s*<!--\s*openwiki:\s*broken internal link\b.*?-->\s*\n?/gmu,
      "",
    );
    const lines = cleaned.split(/\r?\n/u);
    const stamped = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const match of line.matchAll(/\[([^\]]*)\]\(([^)]+)\)/gu)) {
        if (match.index !== undefined && line[match.index - 1] === "!")
          continue;
        const href = match[2].replace(/\s+(["']).*\1\s*$/u, "").trim();
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(href)) continue;
        const hashIndex = href.indexOf("#");
        const target = hashIndex === -1 ? href : href.slice(0, hashIndex);
        const anchor =
          hashIndex === -1
            ? undefined
            : decodeURIComponent(href.slice(hashIndex + 1));
        const absolute = target.startsWith("/")
          ? path.resolve(root, `.${target}`)
          : path.resolve(path.dirname(file), target || path.basename(file));
        if (!inside(root, absolute) || !(await exists(absolute))) {
          stamped.push({
            line: index,
            message: `target \"${target || "#"}\" does not exist`,
          });
          continue;
        }
        if (anchor && absolute.toLowerCase().endsWith(".md")) {
          const anchors = headingAnchors(await readFile(absolute, "utf8"));
          if (!anchors.has(anchor))
            stamped.push({
              line: index,
              message: `heading anchor \"${anchor}\" does not exist`,
            });
        }
      }
    }
    if (stamped.length === 0) {
      if (cleaned !== original) await writeFile(file, cleaned, "utf8");
      continue;
    }
    const output = [...lines];
    for (const issue of [...stamped].reverse())
      output.splice(
        issue.line,
        0,
        `<!-- openwiki: broken internal link: ${issue.message}. Repair this link. -->`,
      );
    await writeFile(
      file,
      `${output.join("\n").replace(/\n*$/u, "")}\n`,
      "utf8",
    );
  }
}

async function degradeInvalidMermaid(root) {
  for (const file of await markdownFiles(path.join(root, "openwiki"))) {
    const original = await readFile(file, "utf8");
    const lines = original.split("\n");
    const changes = [];
    for (let index = 0; index < lines.length; index += 1) {
      const open = /^(\s*)(`{3,})\s*mermaid\s*$/iu.exec(lines[index]);
      if (!open) continue;
      let close = index + 1;
      while (
        close < lines.length &&
        !new RegExp(`^${open[1]}${open[2]}\\s*$`).test(lines[close])
      )
        close += 1;
      if (close >= lines.length) continue;
      const body = lines.slice(index + 1, close).join("\n");
      if (mermaidError(body))
        changes.push({
          open: index,
          close,
          indent: open[1],
          marker: open[2],
          body,
        });
      index = close;
    }
    if (changes.length === 0) continue;
    for (const change of changes.reverse())
      lines.splice(
        change.open,
        change.close - change.open + 1,
        `${change.indent}<!-- openwiki: mermaid parse failed and this diagram was converted to a text fence so it does not break rendering. Fix the diagram source and restore the mermaid fence. -->`,
        `${change.indent}${change.marker}text`,
        ...change.body.split("\n"),
        `${change.indent}${change.marker}`,
      );
    await writeFile(file, lines.join("\n"), "utf8");
  }
}

function mermaidError(body) {
  const first = body.trim().split(/\s+/u)[0]?.toLowerCase();
  if (
    (first === "flowchart" || first === "graph") &&
    (/(?:^|\n|\s)end\s*[[({]/u.test(body) ||
      /-->\s*end\s*(?:$|\n|;)/mu.test(body))
  )
    return true;
  return /[[({][^\])}]*[;< >][^\])}]*[\])}]/u.test(body);
}
function headingAnchors(content) {
  const counts = new Map();
  const result = new Set();
  for (const line of content.split(/\r?\n/u)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!match) continue;
    const base = match[2]
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
      .replace(/\s/gu, "-");
    if (!base) continue;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  return result;
}
async function markdownFiles(root) {
  if (!(await isDirectory(root))) return [];
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) result.push(...(await markdownFiles(file)));
    else if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      !["index.md", "log.md", "instructions.md"].includes(
        entry.name.toLowerCase(),
      )
    )
      result.push(file);
  }
  return result.sort();
}
function inside(root, candidate) {
  const value = path.relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !path.isAbsolute(value));
}
async function exists(file) {
  try {
    await (await import("node:fs/promises")).lstat(file);
    return true;
  } catch {
    return false;
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
