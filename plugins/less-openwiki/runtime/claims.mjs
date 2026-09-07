import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hash, isFile, now, relative } from "./storage.mjs";

export function claimsPath(root, page) {
  return path.join(
    root,
    "openwiki",
    ".claims",
    page.slice("openwiki/".length).replace(/\.md$/u, ".json"),
  );
}

export async function preflightClaims(root) {
  const issues = [];
  const claimsRoot = path.join(root, "openwiki", ".claims");
  if (!(await isFile(claimsRoot)) && !(await directoryExists(claimsRoot)))
    return issues;
  for (const file of await jsonFiles(claimsRoot)) {
    const sidecar = JSON.parse(await readFile(file, "utf8"));
    const page = `openwiki/${relative(claimsRoot, file).replace(/\.json$/u, ".md")}`;
    for (const claim of sidecar.claims ?? []) {
      for (const evidence of claim.evidence ?? []) {
        const current = await resolveEvidence(root, evidence.resource);
        if (!current)
          issues.push({
            page: `/${page}`,
            kind: "unresolved",
            claimId: claim.id,
            resources: [evidence.resource],
          });
        else if (current.version !== evidence.version)
          issues.push({
            page: `/${page}`,
            kind: "stale",
            claimId: claim.id,
            resources: [evidence.resource],
          });
      }
    }
  }
  return issues.sort((a, b) =>
    `${a.page}:${a.claimId}`.localeCompare(`${b.page}:${b.claimId}`),
  );
}

export async function reconcileClaims(root, page, intent, actor) {
  const file = claimsPath(root, page);
  const existing = (await loadClaims(file))?.claims ?? [];
  const proposed = intent?.claims;
  if (!Array.isArray(proposed) || proposed.length === 0)
    throw new Error(
      `${page} needs a private page intent with at least one material Claim and repository evidence`,
    );
  const byId = new Map(existing.map((claim) => [claim.id, claim]));
  const retracted = new Set(intent.retractedClaimIds ?? []);
  const next = [];
  for (const raw of proposed) {
    const statement = String(raw.statement ?? "").trim();
    if (!statement) throw new Error(`Claim statement is empty for ${page}`);
    const resources = [
      ...new Set(
        (raw.evidence ?? [])
          .map((item) => (typeof item === "string" ? item : item?.resource))
          .filter(Boolean),
      ),
    ].sort();
    if (resources.length === 0)
      throw new Error(`Claim requires evidence for ${page}`);
    const evidence = [];
    for (const resource of resources) {
      const resolved = await resolveEvidence(root, resource);
      if (!resolved)
        throw new Error(`Claim evidence cannot be resolved: ${resource}`);
      evidence.push({ resource: resolved.resource, version: resolved.version });
    }
    const current = raw.id
      ? byId.get(raw.id)
      : existing.find(
          (claim) =>
            claim.statement === statement &&
            sameEvidence(claim.evidence, evidence),
        );
    next.push({ id: current?.id ?? randomUUID(), statement, evidence });
  }
  for (const claim of existing) {
    if (retracted.has(claim.id)) continue;
    if (
      !next.some((candidate) => candidate.id === claim.id) &&
      !intent?.replaceAll
    )
      next.push(claim);
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ schemaVersion: 1, pageVersion: hash(await readFile(path.join(root, page))), claims: next, verification: { by: actor, at: now() } }, null, 2)}\n`,
  );
  return next;
}

export async function removeClaims(root, page) {
  await rm(claimsPath(root, page), { force: true });
}

export async function projectClaimSources(root, page, claims) {
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

async function resolveEvidence(root, raw) {
  if (typeof raw !== "string" || !raw.startsWith("repo://"))
    throw new Error(`unsupported evidence resource: ${raw}`);
  const [encodedPath, fragment] = raw.slice("repo://".length).split("#", 2);
  let decoded;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    throw new Error(`invalid evidence resource: ${raw}`);
  }
  const normalized = path.posix
    .normalize(decoded.replace(/\\/gu, "/"))
    .replace(/^\.\//u, "");
  if (
    !normalized ||
    normalized.startsWith("../") ||
    normalized === "openwiki" ||
    normalized.startsWith("openwiki/") ||
    normalized === ".git" ||
    normalized.startsWith(".git/")
  )
    throw new Error(`unsafe evidence resource: ${raw}`);
  const file = path.resolve(root, normalized);
  if (
    !file.startsWith(`${path.resolve(root)}${path.sep}`) ||
    !(await isFile(file))
  )
    return null;
  const content = await readFile(file, "utf8");
  let selected = content;
  let canonical = `repo://${normalized.split("/").map(encodeURIComponent).join("/")}`;
  if (fragment !== undefined) {
    const match = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/u.exec(fragment);
    if (!match) throw new Error(`invalid evidence range: ${raw}`);
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    const lines = content.split(/\r?\n/u);
    if (end < start || end > lines.length) return null;
    selected = lines.slice(start - 1, end).join("\n");
    canonical += `#L${start}-L${end}`;
  }
  return { resource: canonical, version: hash(selected) };
}

function sameEvidence(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value.resource === right[index].resource &&
        value.version === right[index].version,
    )
  );
}
async function loadClaims(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.claims))
      throw new Error("invalid claims schema");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
async function directoryExists(file) {
  try {
    return (await (await import("node:fs/promises")).lstat(file)).isDirectory();
  } catch {
    return false;
  }
}
async function jsonFiles(directory) {
  const { readdir } = await import("node:fs/promises");
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await jsonFiles(child)));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(child);
  }
  return out.sort();
}
