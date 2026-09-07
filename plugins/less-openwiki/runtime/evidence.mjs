import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { loadOpenWikiIgnore } from "./storage.mjs";

const RANGE_CONTEXT_LINE_COUNT = 3;
const LINE_RANGE_VERSION_PREFIX = "repo-lines-v1:sha256:";

/** Resolves OpenWiki's repository evidence resources and preserves its V1 versions. */
export async function resolveRepositoryEvidence(
  root,
  resource,
  previousVersion,
) {
  const parsed = parseResource(resource);
  if ((await loadOpenWikiIgnore(root))(parsed.path))
    throw new Error(
      `Evidence path is excluded by .openwikiignore: ${parsed.path}`,
    );
  const absolute = path.resolve(root, parsed.path);
  if (!isWithin(root, absolute))
    throw new Error(`Evidence path escapes the repository: ${resource}`);
  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) return null;
  const physicalRoot = await realpath(root);
  const physical = await realpath(absolute);
  if (
    !isWithin(physicalRoot, physical) ||
    physical !== path.resolve(physicalRoot, parsed.path)
  )
    throw new Error(
      `Evidence path traverses a symbolic link or filesystem alias: ${parsed.path}`,
    );
  const source = await readFile(physical, "utf8");
  if (!parsed.range)
    return {
      resource: formatResource(parsed),
      version: `repo-file-v1:sha256:${hashText(source)}`,
      content: source,
    };
  return resolveLineRange(
    formatResource(parsed),
    source,
    parsed.range.startLine,
    parsed.range.endLine,
    previousVersion,
  );
}

function parseResource(value) {
  if (typeof value !== "string" || !value.startsWith("repo://"))
    throw new Error(`Unsupported evidence resource: ${value}`);
  const body = value.slice("repo://".length);
  const index = body.indexOf("#");
  let decoded;
  let fragment;
  try {
    decoded = decodeURIComponent(index === -1 ? body : body.slice(0, index));
    fragment =
      index === -1 ? undefined : decodeURIComponent(body.slice(index + 1));
  } catch {
    throw new Error(
      `Evidence resource contains invalid percent encoding: ${value}`,
    );
  }
  if (containsControlCharacter(decoded) || containsControlCharacter(fragment))
    throw new Error(`Evidence resource contains a control character: ${value}`);
  const normalized = path.posix
    .normalize(decoded.replace(/\\/gu, "/"))
    .replace(/^\.\//u, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /^[a-z]:\//iu.test(normalized) ||
    normalized.toLowerCase() === ".git" ||
    normalized.toLowerCase().startsWith(".git/") ||
    normalized.toLowerCase() === "openwiki" ||
    normalized.toLowerCase().startsWith("openwiki/")
  )
    throw new Error(
      `Evidence path must remain inside the repository: ${value}`,
    );
  if (fragment === undefined) return { path: normalized };
  const match = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/u.exec(fragment);
  if (!match)
    throw new Error(
      `Evidence fragment must be a line range such as #L10-L24: ${value}`,
    );
  const startLine = Number(match[1]);
  const endLine = Number(match[2] ?? match[1]);
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    endLine < startLine
  )
    throw new Error(`Evidence line range is invalid: ${value}`);
  return { path: normalized, range: { startLine, endLine } };
}

function containsControlCharacter(value) {
  return [...(value ?? "")].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function formatResource({ path: file, range }) {
  const encoded = file.split("/").map(encodeURIComponent).join("/");
  return `repo://${encoded}${range ? `#L${range.startLine}-L${range.endLine}` : ""}`;
}
function isWithin(root, candidate) {
  const result = path.relative(root, candidate);
  return (
    result.length > 0 &&
    result !== ".." &&
    !result.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(result)
  );
}

function resolveLineRange(
  resource,
  source,
  startLine,
  endLine,
  previousVersion,
) {
  const lines = splitLines(source);
  const hinted =
    endLine <= lines.length
      ? { startIndex: startLine - 1, endIndexExclusive: endLine }
      : null;
  const previous = parseLineRangeVersion(previousVersion);
  if (!previous || !previousVersion)
    return hinted ? createLineRange(resource, lines, hinted) : null;
  const unchanged = locateUnchanged(lines, hinted, previous);
  if (unchanged)
    return {
      resource,
      version: previousVersion,
      content: contentAt(lines, unchanged),
    };
  const changed = locateChanged(lines, previous.metadata);
  return changed ? createLineRange(resource, lines, changed) : null;
}

function splitLines(source) {
  const lines = [];
  for (let start = 0; start < source.length;) {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline + 1;
    lines.push(source.slice(start, end));
    start = end;
  }
  return lines;
}
function createLineRange(resource, lines, span) {
  const content = contentAt(lines, span);
  return {
    resource,
    version: formatLineRangeVersion(content, lines, span),
    content,
  };
}
function contentAt(lines, span) {
  return lines.slice(span.startIndex, span.endIndexExclusive).join("");
}
function locateUnchanged(lines, hinted, previous) {
  const { metadata } = previous;
  if (
    hinted &&
    hinted.endIndexExclusive - hinted.startIndex ===
      metadata.selectedLineCount &&
    hashText(contentAt(lines, hinted)) === previous.contentHash
  )
    return hinted;
  const candidates = [];
  const hashes = lines.map(hashText);
  for (
    let start = 0;
    start + metadata.selectedLineCount <= lines.length;
    start += 1
  ) {
    const candidate = {
      startIndex: start,
      endIndexExclusive: start + metadata.selectedLineCount,
    };
    if (
      hashes[candidate.startIndex] === metadata.firstSelectedLineHash &&
      hashes[candidate.endIndexExclusive - 1] ===
        metadata.lastSelectedLineHash &&
      hashText(contentAt(lines, candidate)) === previous.contentHash
    )
      candidates.push(candidate);
  }
  if (candidates.length === 1) return candidates[0];
  const contextual = candidates.filter((candidate) =>
    hasContext(lines, candidate, metadata),
  );
  return contextual.length === 1 ? contextual[0] : null;
}
function locateChanged(lines, metadata) {
  const starts = boundaries(
    lines,
    metadata.precedingContextLineCount,
    metadata.precedingContextHash,
    "before",
  );
  const ends = boundaries(
    lines,
    metadata.followingContextLineCount,
    metadata.followingContextHash,
    "after",
  );
  const results = [];
  for (const startIndex of starts)
    for (const endIndexExclusive of ends)
      if (endIndexExclusive > startIndex) {
        results.push({ startIndex, endIndexExclusive });
        if (results.length > 1) return null;
      }
  return results[0] ?? null;
}
function boundaries(lines, count, expected, side) {
  if (count === 0) return [side === "before" ? 0 : lines.length];
  const result = [];
  for (let start = 0; start + count <= lines.length; start += 1)
    if (hashText(lines.slice(start, start + count).join("")) === expected)
      result.push(side === "before" ? start + count : start);
  return result;
}
function hasContext(lines, span, metadata) {
  const before =
    metadata.precedingContextLineCount === 0
      ? span.startIndex === 0
      : span.startIndex >= metadata.precedingContextLineCount &&
        hashText(
          lines
            .slice(
              span.startIndex - metadata.precedingContextLineCount,
              span.startIndex,
            )
            .join(""),
        ) === metadata.precedingContextHash;
  const after =
    metadata.followingContextLineCount === 0
      ? span.endIndexExclusive === lines.length
      : span.endIndexExclusive + metadata.followingContextLineCount <=
          lines.length &&
        hashText(
          lines
            .slice(
              span.endIndexExclusive,
              span.endIndexExclusive + metadata.followingContextLineCount,
            )
            .join(""),
        ) === metadata.followingContextHash;
  return before && after;
}
function formatLineRangeVersion(content, lines, span) {
  const before = Math.max(0, span.startIndex - RANGE_CONTEXT_LINE_COUNT);
  const after = Math.min(
    lines.length,
    span.endIndexExclusive + RANGE_CONTEXT_LINE_COUNT,
  );
  const metadata = {
    selectedLineCount: span.endIndexExclusive - span.startIndex,
    firstSelectedLineHash: hashText(lines[span.startIndex]),
    lastSelectedLineHash: hashText(lines[span.endIndexExclusive - 1]),
    precedingContextLineCount: span.startIndex - before,
    precedingContextHash: hashText(
      lines.slice(before, span.startIndex).join(""),
    ),
    followingContextLineCount: after - span.endIndexExclusive,
    followingContextHash: hashText(
      lines.slice(span.endIndexExclusive, after).join(""),
    ),
  };
  return `${LINE_RANGE_VERSION_PREFIX}${hashText(content)}:${Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url")}`;
}
function parseLineRangeVersion(value) {
  if (typeof value !== "string" || !value.startsWith(LINE_RANGE_VERSION_PREFIX))
    return null;
  const body = value.slice(LINE_RANGE_VERSION_PREFIX.length);
  const index = body.indexOf(":");
  if (index === -1 || !/^[a-f0-9]{64}$/u.test(body.slice(0, index)))
    return null;
  try {
    const metadata = JSON.parse(
      Buffer.from(body.slice(index + 1), "base64url").toString("utf8"),
    );
    if (
      !metadata ||
      Object.keys(metadata).length !== 7 ||
      !Number.isSafeInteger(metadata.selectedLineCount) ||
      metadata.selectedLineCount < 1 ||
      !Number.isSafeInteger(metadata.precedingContextLineCount) ||
      metadata.precedingContextLineCount < 0 ||
      metadata.precedingContextLineCount > 3 ||
      !Number.isSafeInteger(metadata.followingContextLineCount) ||
      metadata.followingContextLineCount < 0 ||
      metadata.followingContextLineCount > 3 ||
      ![
        metadata.firstSelectedLineHash,
        metadata.lastSelectedLineHash,
        metadata.precedingContextHash,
        metadata.followingContextHash,
      ].every((entry) => /^[a-f0-9]{64}$/u.test(entry))
    )
      return null;
    return { contentHash: body.slice(0, index), metadata };
  } catch {
    return null;
  }
}
function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}
