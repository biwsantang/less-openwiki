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
  const {
    claims: proposed,
    confirmedClaimIds: confirmed,
    retractedClaimIds: retracted,
  } = validateReconciliationIntent(intent, page);
  const byId = new Map(existing.map((claim) => [claim.id, claim]));
  if (byId.size !== existing.length)
    throw new Error(`${page} has duplicate persisted Claim identifiers`);
  const decisions = new Set();
  const operations = [];
  const targetExisting = (id, decision) => {
    const current = byId.get(id);
    if (!current) throw new Error(`Claim ${id} is not owned by ${page}`);
    if (decisions.has(id))
      throw new Error(
        `Claim ${id} has more than one reconciliation decision for ${page} (${decision})`,
      );
    decisions.add(id);
    return current;
  };

  for (const id of confirmed) {
    operations.push({ op: "confirm", claim: targetExisting(id, "confirm") });
  }

  const fingerprints = new Set();
  for (const raw of proposed) {
    const {
      id: requestedId,
      statement,
      resources,
    } = normalizeProposedClaim(raw, page);
    const fingerprint = JSON.stringify([statement, resources]);
    if (fingerprints.has(fingerprint))
      throw new Error(`Duplicate proposed Claim for ${page}: ${statement}`);
    fingerprints.add(fingerprint);
    const current = requestedId
      ? targetExisting(requestedId, "update")
      : existing.find(
          (claim) =>
            claim.statement === statement &&
            sameEvidenceResources(claim.evidence, resources),
        );
    if (current) {
      if (!requestedId) targetExisting(current.id, "confirm");
      if (
        current.statement === statement &&
        sameEvidenceResources(current.evidence, resources)
      )
        operations.push({ op: "confirm", claim: current });
      else
        operations.push({ op: "update", claim: current, statement, resources });
    } else {
      operations.push({ op: "add", statement, resources });
    }
  }

  for (const id of retracted) {
    const current = byId.get(id);
    if (!current) {
      const owner = await claimOwner(root, id);
      if (!owner) continue;
      throw new Error(`Claim ${id} is not owned by ${page}`);
    }
    operations.push({ op: "retract", claim: targetExisting(id, "retract") });
  }

  for (const claim of existing) {
    if (decisions.has(claim.id)) continue;
    if (await claimHasEvidenceIssue(root, claim))
      throw new Error(
        `Claim ${claim.id} is stale or unresolved and requires an explicit confirm, update, or retraction`,
      );
    decisions.add(claim.id);
    operations.push({ op: "confirm", claim });
  }

  const retractedCount = operations.filter(({ op }) => op === "retract").length;
  const addedCount = operations.filter(({ op }) => op === "add").length;
  if (existing.length - retractedCount + addedCount === 0)
    throw new Error(
      `Completed factual page ${page} must retain or establish at least one material Claim.`,
    );

  const next = existing.map((claim) => ({
    ...claim,
    evidence: [...claim.evidence],
  }));
  for (const operation of operations) {
    if (operation.op === "retract") {
      next.splice(
        next.findIndex(({ id }) => id === operation.claim.id),
        1,
      );
      continue;
    }
    const evidence = await resolveClaimEvidence(
      root,
      operation.op === "confirm"
        ? operation.claim.evidence.map(({ resource, version }) => ({
            resource,
            version,
          }))
        : operation.resources.map((resource) => ({ resource })),
    );
    if (operation.op === "add") {
      next.push({
        id: `claim_${randomUUID().replaceAll("-", "")}`,
        statement: operation.statement,
        evidence,
      });
      continue;
    }
    const index = next.findIndex(({ id }) => id === operation.claim.id);
    next[index] = {
      ...next[index],
      ...(operation.op === "update" ? { statement: operation.statement } : {}),
      evidence,
    };
  }
  await assertClaimOwnershipAvailable(root, page, next);
  await writeJson(file, {
    schemaVersion: 1,
    pageVersion: hash(await readFile(path.join(root, page))),
    claims: next,
    verification: { by: actor, at },
  });
  return next;
}

function validateReconciliationIntent(intent, page) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent))
    throw new Error(
      `${page} needs a valid private Claim reconciliation intent`,
    );
  const allowed = new Set(["claims", "confirmedClaimIds", "retractedClaimIds"]);
  if (Object.keys(intent).some((key) => !allowed.has(key)))
    throw new Error(`${page} has an unsupported Claim reconciliation field`);
  const list = (key) => {
    const value = intent[key] ?? [];
    if (!Array.isArray(value))
      throw new Error(
        `${page} Claim reconciliation field ${key} must be an array`,
      );
    return value;
  };
  const identifiers = (key) =>
    list(key).map((value) => {
      if (typeof value !== "string" || !value.trim())
        throw new Error(`${page} Claim identifier must be a non-empty string`);
      return value.trim();
    });
  return {
    claims: list("claims"),
    confirmedClaimIds: identifiers("confirmedClaimIds"),
    retractedClaimIds: identifiers("retractedClaimIds"),
  };
}

function normalizeProposedClaim(raw, page) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`${page} Claim must be an object`);
  if (
    Object.keys(raw).some(
      (key) => !["id", "statement", "evidence"].includes(key),
    )
  )
    throw new Error(`${page} Claim has an unsupported field`);
  if (typeof raw.statement !== "string" || !raw.statement.trim())
    throw new Error(`Claim statement is empty for ${page}`);
  if (raw.id !== undefined && (typeof raw.id !== "string" || !raw.id.trim()))
    throw new Error(`Claim identifier is empty for ${page}`);
  if (!Array.isArray(raw.evidence) || raw.evidence.length === 0)
    throw new Error(`Claim requires evidence for ${page}`);
  const resources = raw.evidence.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).length !== 1 ||
      !("resource" in item) ||
      typeof item.resource !== "string" ||
      !item.resource.trim()
    )
      throw new Error(
        `Claim evidence must contain only a non-empty resource for ${page}`,
      );
    return item.resource.trim();
  });
  return {
    ...(raw.id === undefined ? {} : { id: raw.id.trim() }),
    statement: raw.statement.trim(),
    resources: [...new Set(resources)].sort(),
  };
}

async function resolveClaimEvidence(root, evidenceInputs) {
  const resolvedResources = new Set();
  const evidence = [];
  for (const { resource, version } of evidenceInputs) {
    const resolved = await resolveRepositoryEvidence(root, resource, version);
    if (!resolved)
      throw new Error(`Claim evidence cannot be resolved: ${resource}`);
    if (resolvedResources.has(resolved.resource))
      throw new Error(
        `Claim evidence resolves to duplicate resource: ${resolved.resource}`,
      );
    resolvedResources.add(resolved.resource);
    evidence.push({ resource: resolved.resource, version: resolved.version });
  }
  return evidence;
}

function sameEvidenceResources(evidence, resources) {
  const current = [...new Set(evidence.map(({ resource }) => resource))].sort();
  return (
    current.length === resources.length &&
    current.every((resource, index) => resource === resources[index])
  );
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

async function claimOwner(root, id) {
  const claimsRoot = path.join(root, "openwiki", ".claims");
  if (!(await directoryExists(claimsRoot))) return null;
  for (const file of await jsonFiles(claimsRoot)) {
    const persisted = await loadClaims(file, { required: true });
    if (persisted.claims.some((claim) => claim.id === id))
      return `openwiki/${relative(claimsRoot, file).replace(/\.json$/u, ".md")}`;
  }
  return null;
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
