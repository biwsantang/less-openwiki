import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hash, isFile, now, relative } from "./storage.mjs";
import { resolveRepositoryEvidence } from "./evidence.mjs";

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
        const current = await resolveRepositoryEvidence(
          root,
          evidence.resource,
          evidence.version,
        );
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
  const proposed = intent?.claims ?? [];
  const confirmed = intent?.confirmedClaimIds ?? [];
  const retracted = intent?.retractedClaimIds ?? [];
  if (
    !Array.isArray(proposed) ||
    !Array.isArray(confirmed) ||
    !Array.isArray(retracted) ||
    (proposed.length === 0 && confirmed.length === 0 && retracted.length === 0)
  )
    throw new Error(
      `${page} needs a private page intent with a Claim decision and repository evidence`,
    );
  const byId = new Map(existing.map((claim) => [claim.id, claim]));
  if (byId.size !== existing.length)
    throw new Error(`${page} has duplicate persisted Claim identifiers`);
  const decisions = new Set();
  const retractedIds = new Set(retracted.map((id) => String(id).trim()));
  for (const id of confirmed.map((value) => String(value).trim())) {
    if (!byId.has(id))
      throw new Error(`Claim ${id || "(empty)"} is not owned by ${page}`);
    if (decisions.has(id))
      throw new Error(
        `Claim ${id} has more than one reconciliation decision for ${page}`,
      );
    decisions.add(id);
  }
  for (const id of retractedIds) {
    if (!byId.has(id))
      throw new Error(`Claim ${id || "(empty)"} is not owned by ${page}`);
    if (decisions.has(id))
      throw new Error(
        `Claim ${id} has more than one reconciliation decision for ${page}`,
      );
    decisions.add(id);
  }
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
      const resolved = await resolveRepositoryEvidence(root, resource);
      if (!resolved)
        throw new Error(`Claim evidence cannot be resolved: ${resource}`);
      evidence.push({ resource: resolved.resource, version: resolved.version });
    }
    const requestedId = raw.id ? String(raw.id).trim() : undefined;
    const current = requestedId
      ? byId.get(requestedId)
      : existing.find(
          (claim) =>
            claim.statement === statement &&
            sameEvidence(claim.evidence, evidence),
        );
    if (requestedId && !current)
      throw new Error(`Claim ${requestedId} is not owned by ${page}`);
    if (current) {
      if (decisions.has(current.id))
        throw new Error(
          `Claim ${current.id} has more than one reconciliation decision for ${page}`,
        );
      decisions.add(current.id);
    }
    next.push({ id: current?.id ?? randomUUID(), statement, evidence });
  }
  for (const claim of existing) {
    if (await claimHasEvidenceIssue(root, claim)) {
      if (!decisions.has(claim.id))
        throw new Error(
          `Claim ${claim.id} is stale or unresolved and requires an explicit confirm, update, or retraction`,
        );
    }
    if (retractedIds.has(claim.id)) continue;
    if (
      !next.some((candidate) => candidate.id === claim.id) &&
      !intent?.replaceAll
    )
      next.push(claim);
  }
  if (next.length === 0)
    throw new Error(
      `Completed factual page ${page} must retain or establish at least one material Claim.`,
    );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ schemaVersion: 1, pageVersion: hash(await readFile(path.join(root, page))), claims: next, verification: { by: actor, at: now() } }, null, 2)}\n`,
  );
  return next;
}

async function claimHasEvidenceIssue(root, claim) {
  for (const evidence of claim.evidence ?? []) {
    const current = await resolveRepositoryEvidence(
      root,
      evidence.resource,
      evidence.version,
    );
    if (!current || current.version !== evidence.version) return true;
  }
  return false;
}

export async function removeClaims(root, page) {
  await rm(claimsPath(root, page), { force: true });
}

/** Refreshes the sidecar after deterministic OKF projection changes page bytes. */
export async function refreshClaimsPageVersion(root, page) {
  const file = claimsPath(root, page);
  const persisted = await loadClaims(file);
  if (!persisted) return;
  persisted.pageVersion = hash(await readFile(path.join(root, page)));
  await writeFile(file, `${JSON.stringify(persisted, null, 2)}\n`);
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
