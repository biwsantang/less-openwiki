import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const START = "<!-- OPENWIKI:START -->";
const END = "<!-- OPENWIKI:END -->";
const FILES = ["AGENTS.md", "CLAUDE.md"];

/**
 * Refresh the upstream-compatible, marker-owned repository guidance. Prepare
 * both files before writing either one so malformed markers never leave a
 * partially-updated pair behind.
 */
export async function ensureCodeModeAgentSnippets(root) {
  const snippets = {
    "AGENTS.md": agentsSnippet(),
    "CLAUDE.md": claudeSnippet(),
  };
  const updates = await Promise.all(
    FILES.map((name) => prepare(path.join(root, name), snippets[name])),
  );
  await Promise.all(
    updates.map(({ file, content }) => writeFile(file, content, "utf8")),
  );
}

export function isManagedAgentFile(root, file) {
  return FILES.some((name) => file === path.join(root, name));
}

async function prepare(file, snippet) {
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if (start === -1 && end === -1)
    return {
      file,
      content: `${current.trimEnd()}${current.trim().length ? "\n\n" : ""}${snippet}\n`,
    };
  if (
    start === -1 ||
    end <= start ||
    start !== current.lastIndexOf(START) ||
    end !== current.lastIndexOf(END)
  )
    throw new Error(
      `Cannot update ${path.basename(file)} because its OpenWiki managed markers are malformed or duplicated. Repair or remove the markers and retry; both repository instruction files were left unchanged.`,
    );
  return {
    file,
    content: `${current.slice(0, start)}${snippet}${current.slice(end + END.length)}`,
  };
}

function agentsSnippet() {
  return `${START}

## OpenWiki

This repository has a generated \`openwiki/\` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

${END}`;
}

function claudeSnippet() {
  return `${START}

## OpenWiki

See [AGENTS.md](AGENTS.md) for OpenWiki agent instructions.

${END}`;
}
