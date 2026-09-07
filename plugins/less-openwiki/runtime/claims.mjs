import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  hash,
  isFactualPage,
  isFile,
  now,
  relative,
  writeJson,
} from "./storage.mjs";
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
  const resolutions = new Map();
  const owners = new Map();
  const claimsRoot = path.join(root, "openwiki", ".claims");
  if (!(await isFile(claimsRoot)) && !(await directoryExists(claimsRoot)))
    return issues;
  for (const file of await jsonFiles(claimsRoot)) {
    const sidecar = await loadClaims(file, { required: true });
    const page = `openwiki/${relative(claimsRoot, file).replace(/\.json$/u, ".md")}`;
    if (!isFactualPage(page) || !(await isFile(path.join(root, page))))
      continue;
    for (const claim of sidecar.claims ?? []) {
      const owner = owners.get(claim.id);
      if (owner && owner !== page)
        throw new Error(
          `Duplicate Claim identifier ${claim.id} across ${owner} and ${page}`,
        );
      owners.set(claim.id, page);
      const changed = [];
      const unresolved = [];
      for (const evidence of claim.evidence ?? []) {
        const key = `${evidence.resource}\0${evidence.version}`;
        let current = resolutions.get(key);
        if (current === undefined) {
          current = await resolveRepositoryEvidence(
            root,
            evidence.resource,
            evidence.version,
          );
          resolutions.set(key, current ?? null);
        }
        if (!current) unresolved.push(evidence.resource);
        else if (current.version !== evidence.version)
          changed.push(evidence.resource);
      }
      if (unresolved.length)
        issues.push({
          page: `/${page}`,
          kind: "unresolved",
          claimId: claim.id,
          resources: [...new Set(unresolved)].sort(),
        });
      else if (changed.length)
        issues.push({
          page: `/${page}`,
          kind: "stale",
          claimId: claim.id,
          resources: [...new Set(changed)].sort(),
        });
    }
  }
  return issues.sort((a, b) =>
    `${a.page}:${a.kind}:${a.claimId}`.localeCompare(
      `${b.page}:${b.kind}:${b.claimId}`,
    ),
  );
}

/** Removes valid factual sidecars whose page was deleted, after a full run. */
export async function removeOrphanClaims(root) {
  const claimsRoot = path.join(root, "openwiki", ".claims");
  if (!(await directoryExists(claimsRoot))) return;
  for (const file of await jsonFiles(claimsRoot)) {
    await loadClaims(file, { required: true });
    const page = `openwiki/${relative(claimsRoot, file).replace(/\.json$/u, ".md")}`;
    if (isFactualPage(page) && !(await isFile(path.join(root, page))))
      await rm(file, { force: true });
  }
}

export async function reconcileClaims(root, page, intent, actor, at = now()) {
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
  await assertClaimOwnershipAvailable(root, page, next);
  await writeJson(file, {
    schemaVersion: 1,
    pageVersion: hash(await readFile(path.join(root, page))),
    claims: next,
    verification: { by: actor, at },
  });
  return next;
}

async function assertClaimOwnershipAvailable(root, page, claims) {
  const ids = new Set(claims.map(({ id }) => id));
  const claimsRoot = path.join(root, "openwiki", ".claims");
  if (!(await directoryExists(claimsRoot))) return;
  for (const file of await jsonFiles(claimsRoot)) {
    const owner = `openwiki/${relative(claimsRoot, file).replace(/\.json$/u, ".md")}`;
    if (owner === page || !isFactualPage(owner)) continue;
    const persisted = await loadClaims(file, { required: true });
    const duplicate = persisted.claims.find(({ id }) => ids.has(id));
    if (duplicate)
      throw new Error(
        `Claim ${duplicate.id} is already owned by ${owner}, not ${page}`,
      );
  }
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
  await writeJson(file, persisted);
}

/** Proves the current Markdown bytes remain covered by verified Claims state. */
export async function assertClaimsPageCurrent(root, page) {
  const persisted = await loadClaims(claimsPath(root, page), {
    required: true,
  });
  const pageVersion = hash(await readFile(path.join(root, page)));
  if (!persisted.verification || persisted.pageVersion !== pageVersion)
    throw new Error(
      `Cannot prove current Claims coverage for ${page}; Markdown and verified Claims are not durable.`,
    );
  return persisted;
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
async function loadClaims(file, { required = false } = {}) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!validClaims(value)) throw new Error("invalid claims schema");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return null;
    throw new Error(
      `invalid OpenWiki Claims sidecar at ${file}; refusing to discard durable grounding state`,
      { cause: error },
    );
  }
}

function validClaims(value) {
  return (
    value &&
    typeof value === "object" &&
    Object.keys(value).every((key) =>
      ["schemaVersion", "pageVersion", "claims", "verification"].includes(key),
    ) &&
    value.schemaVersion === 1 &&
    /^sha256:[a-f0-9]{64}$/u.test(value.pageVersion) &&
    Array.isArray(value.claims) &&
    value.claims.every(
      (claim) =>
        claim &&
        typeof claim === "object" &&
        Object.keys(claim).every((key) =>
          ["id", "statement", "evidence"].includes(key),
        ) &&
        nonEmpty(claim.id) &&
        nonEmpty(claim.statement) &&
        Array.isArray(claim.evidence) &&
        claim.evidence.length > 0 &&
        claim.evidence.every(
          (evidence) =>
            evidence &&
            typeof evidence === "object" &&
            Object.keys(evidence).length === 2 &&
            nonEmpty(evidence.resource) &&
            nonEmpty(evidence.version),
        ),
    ) &&
    (value.verification === undefined ||
      (value.verification &&
        typeof value.verification === "object" &&
        Object.keys(value.verification).length === 2 &&
        nonEmpty(value.verification.by) &&
        nonEmpty(value.verification.at)))
  );
}

function nonEmpty(value) {
  return (
    typeof value === "string" && value.trim() === value && value.length > 0
  );
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
