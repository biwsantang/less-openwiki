import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  factualPages,
  hash,
  intentRoot,
  isDirectory,
  isFile,
  lastUpdatePath,
  manifestPath,
  normalizePage,
  now,
  pageIntentPath,
  planIntentPath,
  relative,
  repositoryChangedPaths,
  rollbackRoot,
  runPath,
  sourceSnapshot,
  writeJson,
  readJson,
} from "./storage.mjs";
import {
  assertClaimsPageCurrent,
  claimsPath,
  preflightClaims,
  reconcileClaims,
  refreshClaimsPageVersion,
  removeOrphanClaims,
  removeClaims,
} from "./claims.mjs";
import {
  finalizeGeneratedProvenance,
  finalizePage,
  finalizeWiki,
  normalizePageOkf,
  normalizeWikiOkf,
  readGeneratedEvent,
  synchronizeClaimSources,
  synchronizeClaimsVerification,
  validateOkfFrontmatter,
} from "./okf.mjs";
import { OPENWIKI_PRODUCER_ACTOR } from "./identity.mjs";

export async function sessionContext(root) {
  const state = await loadRun(root);
  if (!state) return {};
  if (state.phase === "planning")
    return context(
      `A documentation run is waiting for its semantic plan. Write the private plan intent before authoring Markdown.${wikiGoalContext(state)}`,
    );
  return context(
    `A documentation run (${state.runId}) is active. ${await activeJobSummary(root, state)}`,
  );
}

export async function startOrResume(root, input) {
  const existing = await loadRun(root);
  const requestedMode = requestedRunMode(input);
  const requestedLanguage = requestedInputLanguage(input);
  if (existing) {
    if (requestedMode && requestedMode !== existing.mode)
      throw new Error(
        `an interrupted ${existing.mode} documentation run already exists; resume it before starting ${requestedMode}`,
      );
    if (requestedLanguage && requestedLanguage !== existing.language)
      throw new Error(
        `an interrupted documentation run uses ${existing.language}; resume it before changing the language to ${requestedLanguage}`,
      );
    return resumeActiveRun(root, existing);
  }
  const discoveredPages = await factualPages(root);
  const mode =
    requestedMode ?? (discoveredPages.length === 0 ? "init" : "update");
  const existingPages = mode === "init" ? [] : discoveredPages;
  let source = await sourceSnapshot(root);
  const lastUpdate = await readLastUpdate(root);
  const replacement =
    mode === "init" ? await beginInitWikiReplacement(root) : null;
  try {
    const wikiGoal = await readWikiGoal(root);
    if (mode === "update") await normalizeWikiOkf(root, lastUpdate?.language);
    if (
      mode === "update" &&
      lastUpdate?.status === "complete" &&
      lastUpdate.gitHead
    )
      await seedManifestCoverage(root, existingPages, lastUpdate.gitHead);
    let { pageUpdateWindows, changedPaths, claimIssues, completeCoverage } =
      await updatePlanningState(root, mode, existingPages);
    if (
      mode === "update" &&
      lastUpdate?.status === "complete" &&
      lastUpdate.gitHead &&
      changedPaths.length === 0 &&
      claimIssues.length === 0 &&
      completeCoverage &&
      !hasExplicitLanguageRequest(input)
    ) {
      await fastForwardManifestCoverage(root, existingPages, source);
      const publishedSource = await sourceSnapshot(root);
      if (publishedSource.fingerprint === source.fingerprint) {
        await writeJson(lastUpdatePath(root), {
          updatedAt: now(),
          command: "update",
          ...(source.gitHead ? { gitHead: source.gitHead } : {}),
          model: lastUpdate.model,
          status: "complete",
          language: lastUpdate.language ?? "en",
        });
        return context(
          "Documentation is current for the repository source. Inspect the existing pages and report the no-change result.",
        );
      }
      source = publishedSource;
      ({ pageUpdateWindows, changedPaths, claimIssues, completeCoverage } =
        await updatePlanningState(root, mode, existingPages));
    }
    const state = {
      schemaVersion: 1,
      runId: randomUUID(),
      mode,
      phase: "planning",
      startedAt: now(),
      language: requestedLanguage ?? lastUpdate?.language ?? "en",
      languageChanged: Boolean(
        requestedLanguage &&
        lastUpdate?.language &&
        primaryLanguage(lastUpdate.language) !==
          primaryLanguage(requestedLanguage),
      ),
      requiredRewritePages: [],
      initialPages: existingPages.map((file) => `/${relative(root, file)}`),
      sourceFingerprint: source.fingerprint,
      ...(source.gitHead ? { targetGitHead: source.gitHead } : {}),
      actor: { producerActor: actorFor(), metadataModel: modelFor(input) },
      previousLastUpdate: lastUpdate,
      ...(lastUpdate?.gitHead ? { baseGitHead: lastUpdate.gitHead } : {}),
      ...(wikiGoal ? { wikiGoal } : {}),
      ...(String(input.prompt ?? input.user_prompt ?? "").trim()
        ? { planningContext: String(input.prompt ?? input.user_prompt).trim() }
        : {}),
      beforeContentSnapshot: await wikiSnapshot(root),
      preparedWiki: { generatedProvenance: await provenanceSnapshot(root) },
    };
    await mkdir(path.join(root, "openwiki"), { recursive: true });
    await writeRun(root, state);
    await writeJson(lastUpdatePath(root), {
      updatedAt: now(),
      command: state.mode,
      ...(state.baseGitHead ? { gitHead: state.baseGitHead } : {}),
      model: state.actor.metadataModel,
      status: "interrupted",
      language: state.language,
    });
    await replacement?.commit();
    return context(
      `Documentation run ${state.runId} started. Changed source paths: ${changedPaths.length ? changedPaths.join(", ") : "none (perform a full repository review)"}. Page review windows: ${formatPageUpdateWindows(pageUpdateWindows)}. Claims requiring reconciliation: ${claimIssues.length ? claimIssues.map((issue) => `${issue.page}:${issue.claimId}`).join(", ") : "none"}. Coverage requiring full review: ${completeCoverage ? "none" : "one or more factual pages"}. First write the private plan intent at openwiki/.intents/plan.json; it must define focused pages and include quickstart for initialization.${wikiGoalContext(state)}`,
    );
  } catch (error) {
    await replacement?.rollback();
    throw error;
  }
}

export async function guardWrite(root, input) {
  const state = await loadRun(root);
  if (!state) return {};
  // Lifecycle files are write-owned, but agents need to inspect a Claim's
  // current identifiers and evidence before proposing a reconciliation.
  if (!mayMutate(input)) return {};
  const source = await sourceSnapshot(root);
  if (source.fingerprint !== state.sourceFingerprint) {
    await invalidateForSourceDrift(root, state, source);
    return deny(
      "Repository source changed during this documentation run. The active plan was invalidated; write a fresh semantic plan before generated pages.",
    );
  }
  const targets = extractTargets(input, root);
  const protectedTarget = targets.find((target) => ownedState(root, target));
  if (protectedTarget)
    return deny(
      `The documentation lifecycle owns ${relative(root, protectedTarget)}.`,
    );
  if (targets.includes(planIntentPath(root)))
    return state.phase === "planning"
      ? {}
      : deny("The documentation plan has already been accepted for this run.");
  const privateIntent = targets.find((target) =>
    target.startsWith(`${intentRoot(root)}${path.sep}`),
  );
  if (privateIntent) {
    const current = currentJob(state);
    return current && privateIntent === pageIntentPath(root, current.path)
      ? {}
      : deny(
          "A page intent is only allowed for the currently assigned documentation page.",
        );
  }
  const wikiTargets = targets.filter((target) => isWikiMarkdown(root, target));
  if (wikiTargets.length === 0) return {};
  if (state.phase !== "generating")
    return deny(
      "Write the documentation plan intent before generated Markdown.",
    );
  const current = currentJob(state);
  if (!current)
    return deny(
      "The documentation queue is complete. Start a new run before changing generated pages.",
    );
  const unauthorized = wikiTargets.find(
    (target) => relative(root, target) !== current.path,
  );
  return unauthorized
    ? deny(
        `The current documentation page is ${current.path}; do not write ${relative(root, unauthorized)} first.`,
      )
    : {};
}

export async function checkpoint(root, input) {
  const state = await loadRun(root);
  if (!state) return {};
  if (!mayMutate(input)) return {};
  const targets = extractTargets(input, root);
  if (state.phase === "planning" && targets.includes(planIntentPath(root))) {
    await acceptPlan(root, state);
    return context(
      `Documentation plan accepted. ${await activeJobSummary(root, state)}`,
    );
  }
  if (state.phase !== "generating") return {};
  const current = currentJob(state);
  if (current && targets.includes(pageIntentPath(root, current.path))) {
    const intent = await readJson(pageIntentPath(root, current.path), {
      required: true,
    });
    if (isSkipIntent(intent)) {
      await skipCurrentPage(root, state, current);
      return context(
        `Restored ${current.path} after the skipped page attempt. The documentation checkpoint is interrupted; finish this run and start a fresh update to retry it.`,
      );
    }
  }
  if (!current || !targets.includes(path.join(root, current.path))) return {};
  const source = await sourceSnapshot(root);
  if (source.fingerprint !== state.sourceFingerprint) {
    await invalidateForSourceDrift(root, state, source);
    return {
      systemMessage:
        "Less OpenWiki: repository source changed; the current plan was invalidated and must be replaced.",
    };
  }
  await normalizePageOkf(root, current.path, state.language);
  const validation = await validatePage(root, current.path);
  if (!validation.ok) {
    await rollbackPage(root, state, current.path);
    return {
      systemMessage: `Less OpenWiki: ${current.path} was restored because it is not ready: ${validation.errors.join(" ")}`,
    };
  }
  const intent = await readJson(pageIntentPath(root, current.path), {
    required: true,
  });
  const claims = await reconcileClaims(
    root,
    current.path,
    intent,
    state.actor.producerActor,
    state.startedAt,
  );
  await finalizePage(
    root,
    current.path,
    state.actor.producerActor,
    claims,
    state.startedAt,
  );
  await synchronizeClaimsVerification(root);
  await refreshClaimsPageVersion(root, current.path);
  await recordManifestPageCompletion(root, current.path, state);
  current.status = "complete";
  current.completedBy = actorFor();
  await rm(pageIntentPath(root, current.path), { force: true });
  await writeRun(root, state);
  return context(
    `Recorded ${current.path}. ${await activeJobSummary(root, state)}`,
  );
}

function isSkipIntent(intent) {
  return (
    intent &&
    typeof intent === "object" &&
    !Array.isArray(intent) &&
    Object.keys(intent).length === 1 &&
    intent.action === "skip"
  );
}

async function skipCurrentPage(root, state, current) {
  const snapshot = await skippedPageSnapshot(root, state, current.path);
  await rollbackPage(root, state, current.path);
  const snapshots = await readSkippedPageSnapshots(root, state);
  if (!validSnapshotRecords(snapshots))
    throw new Error("invalid skipped-page rollback state");
  await writeJson(skippedPageSnapshotsPath(root, state), [
    ...snapshots.filter((entry) => entry.path !== current.path),
    snapshot,
  ]);
  await writeJson(lastUpdatePath(root), {
    updatedAt: now(),
    command: state.mode,
    ...(state.baseGitHead ? { gitHead: state.baseGitHead } : {}),
    model: state.actor.metadataModel,
    status: "interrupted",
    language: state.language,
  });
  current.status = "skipped";
  delete current.completedBy;
  await writeRun(root, state);
  await rm(pageIntentPath(root, current.path), { force: true });
}

function mayMutate(input) {
  const name = String(input.tool_name ?? input.toolName ?? input.name ?? "");
  return !/^(?:read|cat|list|ls|glob|grep|search|find)(?:[_ -]|$)/iu.test(name);
}

export async function finish(root) {
  const state = await loadRun(root);
  if (!state) return {};
  if (state.phase === "planning")
    return {
      continue: false,
      stopReason: "Documentation plan is still required.",
      systemMessage:
        "Less OpenWiki requires a semantic page plan before completion.",
    };
  const current = currentJob(state);
  if (current)
    return {
      continue: false,
      stopReason: `Documentation remains incomplete: ${current.path}.`,
      systemMessage: `Less OpenWiki requires the assigned page before completion. ${pendingSummary(state)}`,
    };
  const skippedPages = new Set(
    state.plan.pages
      .filter((page) => page.status === "skipped")
      .map((page) => page.path),
  );
  if (!(await hasDurableSkippedSnapshots(root, state, skippedPages)))
    return {
      continue: false,
      stopReason: "Skipped documentation work must resume before finalization.",
      systemMessage:
        "Less OpenWiki cannot finalize skipped work without its original page snapshots. Resume the documentation run to retry it.",
    };
  const sourceChangedBeforeFinish =
    (await sourceSnapshot(root)).fingerprint !== state.sourceFingerprint;
  await removeAbandonedGeneratedPages(root, state);
  for (const page of state.plan.deletePages) {
    await rm(path.join(root, page), { force: true });
    await removeClaims(root, page);
  }
  await removeOrphanClaims(root);
  await normalizeWikiOkf(root, state.language);
  const pages = await factualPages(root);
  for (const file of pages) {
    const validation = await validatePage(root, relative(root, file));
    if (!validation.ok) throw new Error(validation.errors.join(" "));
  }
  const issues = await preflightClaims(root);
  if (issues.length > 0)
    throw new Error(
      `Claims evidence is stale or unresolved: ${issues.map((issue) => `${issue.page}:${issue.claimId}`).join(", ")}`,
    );
  await finalizeWiki(root, state.language);
  await synchronizeClaimSources(root);
  await synchronizeClaimsVerification(root);
  await finalizeGeneratedProvenance(root, state);
  for (const file of pages)
    await refreshClaimsPageVersion(root, relative(root, file));
  for (const page of skippedPages) await rollbackPage(root, state, page);
  await replaceManifest(root, await factualPages(root), state, skippedPages);
  const sourceChanged =
    sourceChangedBeforeFinish ||
    (await sourceSnapshot(root)).fingerprint !== state.sourceFingerprint;
  const interrupted = sourceChanged || skippedPages.size > 0;
  await writeJson(lastUpdatePath(root), {
    updatedAt: now(),
    command: state.mode,
    ...(interrupted
      ? state.baseGitHead
        ? { gitHead: state.baseGitHead }
        : {}
      : state.targetGitHead
        ? { gitHead: state.targetGitHead }
        : {}),
    model: state.actor.metadataModel,
    status: interrupted ? "interrupted" : "complete",
    language: state.language,
  });
  // Native finalizers operate on the complete wiki; restore skipped pages last
  // so their pre-run Markdown and Claims bytes cannot inherit those changes.
  for (const page of skippedPages) await rollbackPage(root, state, page);
  await rm(runPath(root), { force: true });
  await rm(rollbackRoot(root, state.runId), { recursive: true, force: true });
  await rm(intentRoot(root), { recursive: true, force: true });
  return {
    systemMessage:
      skippedPages.size > 0
        ? "Less OpenWiki restored skipped page work and finalized the remaining documentation as interrupted. Run an update to retry the skipped page."
        : sourceChanged
          ? "Less OpenWiki documentation run is finalized, but repository source changed during the run. Run an update to reconcile it."
          : "Less OpenWiki documentation run is complete and validated.",
  };
}

async function removeAbandonedGeneratedPages(root, state) {
  const initial = new Set(state.initialPages.map((page) => page.slice(1)));
  const planned = new Set(state.plan.pages.map(({ path: page }) => page));
  for (const file of await factualPages(root)) {
    const page = relative(root, file);
    if (initial.has(page) || planned.has(page)) continue;
    await rm(file, { force: true });
    await removeClaims(root, page);
  }
}

export async function interrupt(root) {
  const state = await loadRun(root);
  if (!state) return {};
  await writeJson(lastUpdatePath(root), {
    updatedAt: now(),
    command: state.mode,
    ...(state.baseGitHead ? { gitHead: state.baseGitHead } : {}),
    model: state.actor.metadataModel,
    status: "interrupted",
    language: state.language,
  });
  return {};
}

async function invalidateForSourceDrift(root, state, source) {
  state.phase = "planning";
  state.sourceFingerprint = source.fingerprint;
  if (source.gitHead) state.targetGitHead = source.gitHead;
  else delete state.targetGitHead;
  delete state.plan;
  await writeRun(root, state);
  await writeJson(lastUpdatePath(root), {
    updatedAt: now(),
    command: state.mode,
    ...(state.baseGitHead ? { gitHead: state.baseGitHead } : {}),
    model: state.actor.metadataModel,
    status: "interrupted",
    language: state.language,
  });
}

async function resumeActiveRun(root, state) {
  const source = await sourceSnapshot(root);
  if (source.fingerprint !== state.sourceFingerprint) {
    await invalidateForSourceDrift(root, state, source);
    return context(
      "Repository source changed since this documentation run started. Write a fresh semantic plan before generated Markdown.",
    );
  }
  let changed = false;
  if (!state.targetGitHead && source.gitHead) {
    state.targetGitHead = source.gitHead;
    changed = true;
  }
  const resetSkipped = await resetSkippedPageJobs(root, state);
  const reconciled = await reconcileManifestPageJobs(root, state);
  if (changed || resetSkipped || reconciled) await writeRun(root, state);
  return sessionContext(root);
}

async function resetSkippedPageJobs(root, state) {
  if (state.phase !== "generating" || !state.plan) return false;
  if (!state.plan.pages.some((page) => page.status === "skipped")) return false;
  state.plan.pages = state.plan.pages.map((page) =>
    page.status === "skipped" ? { ...page, status: "pending" } : page,
  );
  await rm(skippedPageSnapshotsPath(root, state), { force: true });
  return true;
}

/**
 * Replaces a prior generated-only wiki for initialization, preserving the
 * repository-owned instructions file. The private backup exists only until
 * the new resumable state and interrupted metadata are durable.
 */
async function beginInitWikiReplacement(root) {
  const wiki = path.join(root, "openwiki");
  let stat;
  try {
    stat = await lstat(wiki);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("refusing to replace openwiki: expected a real directory");
  const backupParent = await mkdtemp(
    path.join(tmpdir(), "less-openwiki-init-"),
  );
  const backup = path.join(backupParent, "openwiki");
  let completed = false;
  const cleanup = async () => {
    if (completed) return;
    completed = true;
    await rm(backupParent, { recursive: true, force: true });
  };
  const rollback = async () => {
    if (completed) return;
    await rm(wiki, { recursive: true, force: true });
    await cp(backup, wiki, {
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    await cleanup();
  };
  try {
    await cp(wiki, backup, {
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  try {
    await rm(wiki, { recursive: true, force: true });
    await mkdir(wiki, { recursive: true });
    const instructions = path.join(backup, "INSTRUCTIONS.md");
    let instructionsStat;
    try {
      instructionsStat = await lstat(instructions);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (instructionsStat) {
      if (!instructionsStat.isFile() || instructionsStat.isSymbolicLink())
        throw new Error(
          "refusing to preserve openwiki/INSTRUCTIONS.md: expected a regular file",
        );
      await cp(instructions, path.join(wiki, "INSTRUCTIONS.md"), {
        preserveTimestamps: true,
      });
    }
  } catch (error) {
    await rollback();
    throw error;
  }
  return { commit: cleanup, rollback };
}

async function reconcileManifestPageJobs(root, state) {
  if (state.phase !== "generating") return false;
  const manifest = await readManifest(root);
  let changed = false;
  for (const job of state.plan.pages) {
    const entry = manifest.pages[`/${job.path}`];
    const current = await manifestCompletionIsCurrent(
      root,
      job.path,
      state,
      entry,
    );
    if (job.status === "complete") {
      if (current) continue;
      try {
        await assertClaimsPageCurrent(root, job.path);
      } catch (error) {
        throw new Error(
          `Completed documentation page ${job.path} lost its durable Claims proof; refusing to resume it.`,
          { cause: error },
        );
      }
      await recordManifestPageCompletion(
        root,
        job.path,
        state,
        job.completedBy ?? entry?.completedBy ?? state.actor.producerActor,
      );
      changed = true;
      continue;
    }
    if (job.status !== "pending" || !current) continue;
    job.status = "complete";
    job.completedBy = entry.completedBy ?? state.actor.producerActor;
    changed = true;
  }
  return changed;
}

async function acceptPlan(root, state) {
  const intent = await readJson(planIntentPath(root), { required: true });
  if (
    !intent ||
    typeof intent !== "object" ||
    Array.isArray(intent) ||
    Object.keys(intent).some(
      (key) => !["pages", "deletePages", "language"].includes(key),
    ) ||
    !Array.isArray(intent.pages)
  )
    throw new Error("plan intent requires a pages array");
  const pages = intent.pages.map(planPage);
  if (new Set(pages.map((page) => page.path)).size !== pages.length)
    throw new Error("plan contains duplicate pages");
  const deletePages = [
    ...new Set(
      planStrings(intent.deletePages ?? [], "deletePages").map(normalizePage),
    ),
  ].sort();
  if (intent.language !== undefined) {
    if (typeof intent.language !== "string" || !intent.language.trim())
      throw new Error("plan language must be a non-empty BCP-47 string");
    state.language = resolveLanguage(intent.language);
  }
  if (state.mode === "init" && deletePages.length > 0)
    throw new Error("initialization plans cannot delete generated pages");
  state.languageChanged = Boolean(
    state.previousLastUpdate?.language &&
    primaryLanguage(state.previousLastUpdate.language) !==
      primaryLanguage(state.language),
  );
  state.requiredRewritePages = state.languageChanged
    ? state.initialPages.filter((page) => !deletePages.includes(page.slice(1)))
    : [];
  if (
    state.mode === "init" &&
    !pages.some((page) => page.path === "openwiki/quickstart.md")
  )
    throw new Error("initialization plans must include openwiki/quickstart.md");
  if (deletePages.includes("openwiki/quickstart.md"))
    throw new Error("quickstart cannot be deleted");
  if (deletePages.some((page) => pages.some((job) => job.path === page)))
    throw new Error("a planned page cannot also be deleted");
  if (state.mode === "update") {
    const pagePaths = new Set(pages.map((page) => page.path));
    const deleted = new Set(deletePages);
    addRequiredClaimIssueJobs(
      pages,
      pagePaths,
      deleted,
      await preflightClaims(root),
    );
    addRequiredRewriteJobs(
      pages,
      pagePaths,
      deleted,
      state.requiredRewritePages,
    );
    addRequiredCoverageJobs(
      pages,
      pagePaths,
      deleted,
      await uncoveredManifestPages(root),
    );
  }
  pages.sort(
    (left, right) =>
      Number(left.path === "openwiki/quickstart.md") -
        Number(right.path === "openwiki/quickstart.md") ||
      left.path.localeCompare(right.path),
  );
  state.phase = "generating";
  state.plan = { pages, deletePages };
  await createRollback(root, state);
  await writeRun(root, state);
  await rm(planIntentPath(root), { force: true });
}

function planPage(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some(
      (key) =>
        ![
          "path",
          "title",
          "purpose",
          "seedPaths",
          "relatedPages",
          "instructions",
        ].includes(key),
    )
  )
    throw new Error("every plan page must be an object with supported fields");
  if (
    typeof raw.path !== "string" ||
    typeof raw.title !== "string" ||
    typeof raw.purpose !== "string" ||
    !raw.path.trim() ||
    !raw.title.trim() ||
    !raw.purpose.trim()
  )
    throw new Error(
      "every planned page requires non-empty string path, title, and purpose",
    );
  return {
    id: randomUUID(),
    path: normalizePage(raw.path),
    title: raw.title.trim(),
    purpose: raw.purpose.trim(),
    seedPaths: [
      ...new Set(
        planStrings(raw.seedPaths ?? [], "seedPaths").map(normalizeSeedPath),
      ),
    ].sort(),
    relatedPages: [
      ...new Set(
        planStrings(raw.relatedPages ?? [], "relatedPages").map(normalizePage),
      ),
    ].sort(),
    instructions: [
      ...new Set(planStrings(raw.instructions ?? [], "instructions")),
    ].sort(),
    status: "pending",
  };
}

function planStrings(value, field) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  )
    throw new Error(`${field} must be an array of non-empty strings`);
  return value.map((item) => item.trim());
}

function normalizeSeedPath(value) {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes(".."))
    throw new Error(`invalid seed path: ${value}`);
  return normalized;
}

function addRequiredClaimIssueJobs(pages, pagePaths, deleted, issues) {
  const grouped = new Map();
  for (const issue of issues) {
    const page = normalizePage(issue.page);
    const current = grouped.get(page) ?? [];
    current.push(issue);
    grouped.set(page, current);
  }
  for (const [page, pageIssues] of grouped) {
    if (pagePaths.has(page) || deleted.has(page)) continue;
    pages.push({
      id: randomUUID(),
      path: page,
      title: titleFromPage(page),
      purpose:
        "Reconcile stale or unresolved Claims and update this page from current repository evidence while preserving unaffected accurate content.",
      seedPaths: [
        ...new Set(
          pageIssues.flatMap((issue) =>
            issue.resources.map(evidenceResourceToSeedPath),
          ),
        ),
      ].sort(),
      relatedPages: [],
      instructions: [],
      status: "pending",
    });
    pagePaths.add(page);
  }
}

function addRequiredRewriteJobs(pages, pagePaths, deleted, requiredPages) {
  for (const required of requiredPages) {
    const page = normalizePage(required);
    if (pagePaths.has(page) || deleted.has(page)) continue;
    pages.push({
      id: randomUUID(),
      path: page,
      title: titleFromPage(page),
      purpose:
        "Rewrite this existing page in the run's target language while preserving every accurate repository-supported fact and reconciling its complete Claim set.",
      seedPaths: [],
      relatedPages: [],
      instructions: [],
      status: "pending",
    });
    pagePaths.add(page);
  }
}

function addRequiredCoverageJobs(pages, pagePaths, deleted, uncoveredPages) {
  for (const page of uncoveredPages) {
    if (pagePaths.has(page) || deleted.has(page)) continue;
    pages.push({
      id: randomUUID(),
      path: page,
      title: titleFromPage(page),
      purpose:
        "Perform a full documentation and Claims review because this page lacks durable verified coverage for the repository update lifecycle.",
      seedPaths: [],
      relatedPages: [],
      instructions: [],
      status: "pending",
    });
    pagePaths.add(page);
  }
}

function evidenceResourceToSeedPath(resource) {
  const seed = String(resource ?? "")
    .replace(/^repo:\/\//u, "")
    .replace(/#L\d+(?:-L\d+)?$/u, "")
    .replace(/^\/+|\\/gu, "");
  if (!seed || seed.split("/").includes(".."))
    throw new Error(`invalid repository evidence resource: ${resource}`);
  return seed;
}

function titleFromPage(page) {
  return path.posix
    .basename(page, ".md")
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function primaryLanguage(language) {
  try {
    return new Intl.Locale(language).language;
  } catch {
    return language;
  }
}

function requestedRunMode(input) {
  if (input.mode === "init" || input.mode === "update") return input.mode;
  const prompt = String(input.prompt ?? input.user_prompt ?? "");
  if (
    /\b(?:re-?initialize|re-?initialise|initialize|initialise|start\s+(?:the\s+)?wiki\s+(?:over|from\s+scratch)|replace\s+(?:the\s+)?(?:openwiki|wiki|documentation))\b/iu.test(
      prompt,
    )
  )
    return "init";
  if (
    /\b(?:update|refresh|maintain|migrate|translate|repair|revise)\b/iu.test(
      prompt,
    )
  )
    return "update";
  return undefined;
}

function requestedInputLanguage(input) {
  if (input.language === undefined || input.language === null) return undefined;
  if (typeof input.language !== "string" || !input.language.trim())
    throw new Error("language must be a non-empty BCP-47 code");
  return resolveLanguage(input.language);
}

function hasExplicitLanguageRequest(input) {
  if (typeof input.language === "string" && input.language.trim()) return true;
  const prompt = String(input.prompt ?? input.user_prompt ?? "");
  return /\b(?:language|english|french|spanish|german|italian|portuguese|chinese|japanese|korean|thai|vietnamese|arabic|russian|ukrainian|turkish|hindi)\b/iu.test(
    prompt,
  );
}

function resolveLanguage(input) {
  const value = input.trim();
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    const primary = new Intl.Locale(canonical).language;
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(
      primary,
    );
    if (name && name.toLowerCase() !== primary.toLowerCase()) return canonical;
  } catch {
    // The actionable error below is kept uniform for malformed and unknown tags.
  }
  throw new Error(
    `Unrecognized language "${value}". Use a BCP-47 code such as ko, zh-CN, or pt-BR rather than a language name.`,
  );
}

async function loadRun(root) {
  const state = await readJson(runPath(root));
  if (!state) return null;
  validateRun(state);
  return state;
}
async function writeRun(root, state) {
  validateRun(state);
  await writeJson(runPath(root), state);
}
function validateRun(state) {
  const allowed = new Set([
    "schemaVersion",
    "runId",
    "mode",
    "phase",
    "startedAt",
    "language",
    "languageChanged",
    "requiredRewritePages",
    "initialPages",
    "sourceFingerprint",
    "targetGitHead",
    "planningContext",
    "actor",
    "previousLastUpdate",
    "baseGitHead",
    "wikiGoal",
    "beforeContentSnapshot",
    "preparedWiki",
    "plan",
  ]);
  if (
    !state ||
    Object.keys(state).some((key) => !allowed.has(key)) ||
    state.schemaVersion !== 1 ||
    !isUuid(state.runId) ||
    !["init", "update"].includes(state.mode) ||
    !["planning", "generating"].includes(state.phase) ||
    !validUpdateMetadata(state.previousLastUpdate) ||
    !nonEmptyString(state.startedAt) ||
    !nonEmptyString(state.language) ||
    typeof state.languageChanged !== "boolean" ||
    !nonEmptyStringArray(state.requiredRewritePages) ||
    !nonEmptyStringArray(state.initialPages) ||
    typeof state.beforeContentSnapshot !== "string" ||
    !validActor(state.actor) ||
    !/^sha256:[a-f0-9]{64}$/u.test(state.sourceFingerprint) ||
    !validPreparedWiki(state.preparedWiki) ||
    !optionalNonEmptyString(state.targetGitHead) ||
    !optionalNonEmptyString(state.planningContext) ||
    !optionalNonEmptyString(state.baseGitHead) ||
    !optionalString(state.wikiGoal)
  )
    throw new Error(
      "invalid OpenWiki .run.json; refusing to discard resumable work",
    );
  if (state.plan && !validPlan(state.plan))
    throw new Error("invalid OpenWiki plan state");
}
function validUpdateMetadata(value) {
  return (
    value === null ||
    (value &&
      typeof value === "object" &&
      Object.keys(value).every((key) =>
        [
          "updatedAt",
          "command",
          "gitHead",
          "model",
          "status",
          "language",
        ].includes(key),
      ) &&
      nonEmptyString(value.updatedAt) &&
      ["init", "update"].includes(value.command) &&
      nonEmptyString(value.model) &&
      ["complete", "interrupted"].includes(value.status) &&
      optionalNonEmptyString(value.gitHead) &&
      optionalString(value.language))
  );
}
function stringArray(value) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function optionalNonEmptyString(value) {
  return value === undefined || nonEmptyString(value);
}
function optionalString(value) {
  return value === undefined || typeof value === "string";
}
function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.every(nonEmptyString);
}
function validActor(value) {
  return (
    value &&
    typeof value === "object" &&
    Object.keys(value).length === 2 &&
    nonEmptyString(value.producerActor) &&
    nonEmptyString(value.metadataModel)
  );
}
function validPreparedWiki(value) {
  return (
    value &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.generatedProvenance) &&
    value.generatedProvenance.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        Object.keys(entry).every((key) =>
          ["page", "bodyHash", "generated"].includes(key),
        ) &&
        nonEmptyString(entry.page) &&
        nonEmptyString(entry.bodyHash) &&
        (entry.generated === undefined ||
          (entry.generated &&
            typeof entry.generated === "object" &&
            Object.keys(entry.generated).every((key) =>
              ["by", "at"].includes(key),
            ) &&
            nonEmptyString(entry.generated.by) &&
            optionalNonEmptyString(entry.generated.at))),
    )
  );
}
function validPlan(value) {
  return (
    value &&
    typeof value === "object" &&
    Object.keys(value).length === 2 &&
    Array.isArray(value.pages) &&
    stringArray(value.deletePages) &&
    value.pages.every(
      (page) =>
        page &&
        typeof page === "object" &&
        Object.keys(page).every((key) =>
          [
            "id",
            "path",
            "title",
            "purpose",
            "seedPaths",
            "relatedPages",
            "instructions",
            "status",
            "completedBy",
          ].includes(key),
        ) &&
        isUuid(page.id) &&
        nonEmptyString(page.path) &&
        nonEmptyString(page.title) &&
        nonEmptyString(page.purpose) &&
        stringArray(page.seedPaths) &&
        stringArray(page.relatedPages) &&
        nonEmptyStringArray(page.instructions) &&
        ["pending", "skipped", "complete"].includes(page.status) &&
        optionalNonEmptyString(page.completedBy),
    )
  );
}
function validSnapshotRecords(value, plan) {
  if (!Array.isArray(value)) return false;
  if (plan === undefined)
    return (
      value.length === 0 &&
      new Set(value.map((snapshot) => snapshot.path)).size === value.length
    );
  const skipped = new Set(
    plan?.pages
      .filter((page) => page.status === "skipped")
      .map((page) => page.path),
  );
  return (
    value.length === skipped.size &&
    value.every(
      (snapshot) =>
        snapshot &&
        typeof snapshot === "object" &&
        Object.keys(snapshot).every((key) =>
          ["path", "markdown", "claims"].includes(key),
        ) &&
        typeof snapshot.path === "string" &&
        skipped.has(snapshot.path) &&
        typeof snapshot.markdown === "boolean" &&
        typeof snapshot.claims === "boolean",
    ) &&
    new Set(value.map((snapshot) => snapshot.path)).size === value.length
  );
}
async function hasDurableSkippedSnapshots(root, state, skippedPages) {
  if (skippedPages.size === 0) return true;
  const snapshots = await readSkippedPageSnapshots(root, state);
  if (!validSnapshotRecords(snapshots, state.plan)) return false;
  return Promise.all(
    snapshots.map(async (snapshot) => {
      const expected = await skippedPageSnapshot(root, state, snapshot.path);
      return (
        snapshot.markdown === expected.markdown &&
        snapshot.claims === expected.claims
      );
    }),
  ).then((results) => results.every(Boolean));
}
function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
function currentJob(state) {
  return state.plan?.pages.find((page) => page.status === "pending") ?? null;
}
function pendingSummary(state) {
  const pending =
    state.plan?.pages.filter((page) => page.status === "pending") ?? [];
  if (pending.length === 0)
    return "All queued pages are complete; finish the run.";
  const current = pending[0];
  const details = [
    `Current page: ${current.path}.`,
    contextSentence("Title", current.title),
    contextSentence("Purpose", current.purpose),
    `Research seed paths: ${current.seedPaths.length ? current.seedPaths.join(", ") : "none specified"}.`,
    `Related pages: ${current.relatedPages.length ? current.relatedPages.join(", ") : "none specified"}.`,
    `Instructions: ${current.instructions.length ? current.instructions.join(" | ") : "none specified"}.`,
    ...(state.wikiGoal ? [`Repository instructions: ${state.wikiGoal}`] : []),
    `${pending.length - 1} page(s) remain after it.`,
  ];
  return details.join(" ");
}

async function activeJobSummary(root, state) {
  const current = currentJob(state);
  if (!current) return pendingSummary(state);
  const sidecar = await readJson(claimsPath(root, current.path));
  const existingClaimCount = Array.isArray(sidecar?.claims)
    ? sidecar.claims.length
    : 0;
  const issues = (await preflightClaims(root)).filter(
    (issue) => issue.page === `/${current.path}`,
  );
  return `${pendingSummary(state)} Existing Claims: ${existingClaimCount}. Claims requiring attention: ${issues.length ? issues.map((issue) => `${issue.claimId} (${issue.kind}: ${issue.resources.join(", ")})`).join("; ") : "none"}.`;
}

function contextSentence(label, value) {
  return `${label}: ${value}${/[.!?]$/u.test(value) ? "" : "."}`;
}
function wikiGoalContext(state) {
  return state.wikiGoal ? ` Repository instructions: ${state.wikiGoal}` : "";
}
async function readWikiGoal(root) {
  const file = path.join(root, "openwiki", "INSTRUCTIONS.md");
  if (!(await isFile(file))) return undefined;
  const goal = (await readFile(file, "utf8")).trim();
  return goal || undefined;
}
async function readLastUpdate(root) {
  const value = await readJson(lastUpdatePath(root));
  if (!value) return null;
  return typeof value.updatedAt === "string" &&
    typeof value.command === "string" &&
    typeof value.model === "string"
    ? {
        updatedAt: value.updatedAt,
        command: value.command === "init" ? "init" : "update",
        ...(typeof value.gitHead === "string"
          ? { gitHead: value.gitHead }
          : {}),
        model: value.model,
        status: value.status === "interrupted" ? "interrupted" : "complete",
        ...(typeof value.language === "string"
          ? { language: value.language }
          : {}),
      }
    : null;
}
async function wikiSnapshot(root) {
  const pages = await factualPages(root);
  return hash(
    (
      await Promise.all(
        pages.map(
          async (file) =>
            `${relative(root, file)}:${hash(await readFile(file))}`,
        ),
      )
    )
      .sort()
      .join("\n"),
  );
}
async function provenanceSnapshot(root) {
  const pages = await factualPages(root);
  return Promise.all(
    pages.map(async (file) => {
      const content = await readFile(file, "utf8");
      const generated = readGeneratedEvent(content);
      return {
        page: `/${relative(root, file)}`,
        bodyHash: hash(content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "")),
        ...(generated ? { generated } : {}),
      };
    }),
  );
}
async function createRollback(root, state) {
  const base = rollbackRoot(root, state.runId);
  for (const page of state.initialPages) {
    const source = path.join(root, page);
    if (await isFile(source)) {
      const destination = path.join(base, page.slice("/openwiki/".length));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(source));
    }
    const claims = claimsPath(root, page.slice(1));
    if (!(await isFile(claims))) continue;
    const claimsBackup = path.join(
      base,
      ".claims",
      page.slice("/openwiki/".length).replace(/\.md$/u, ".json"),
    );
    await mkdir(path.dirname(claimsBackup), { recursive: true });
    await writeFile(claimsBackup, await readFile(claims));
  }
}
async function rollbackPage(root, state, page) {
  const target = path.join(root, page);
  const backup = path.join(
    rollbackRoot(root, state.runId),
    page.slice("openwiki/".length),
  );
  if (await isFile(backup)) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(backup));
  } else await rm(target, { force: true });
  const claims = claimsPath(root, page);
  const claimsBackup = path.join(
    rollbackRoot(root, state.runId),
    ".claims",
    page.slice("openwiki/".length).replace(/\.md$/u, ".json"),
  );
  if (await isFile(claimsBackup)) {
    await mkdir(path.dirname(claims), { recursive: true });
    await writeFile(claims, await readFile(claimsBackup));
  } else await rm(claims, { force: true });
}
async function skippedPageSnapshot(root, state, page) {
  const base = rollbackRoot(root, state.runId);
  return {
    path: page,
    markdown: await isFile(path.join(base, page.slice("openwiki/".length))),
    claims: await isFile(
      path.join(
        base,
        ".claims",
        page.slice("openwiki/".length).replace(/\.md$/u, ".json"),
      ),
    ),
  };
}
function skippedPageSnapshotsPath(root, state) {
  return path.join(rollbackRoot(root, state.runId), ".skipped.json");
}
async function readSkippedPageSnapshots(root, state) {
  const snapshots = await readJson(skippedPageSnapshotsPath(root, state));
  return snapshots ?? [];
}
async function validatePage(root, page) {
  const file = path.join(root, page);
  if (!(await isFile(file)))
    return { ok: false, errors: [`${page} does not exist.`] };
  const content = await readFile(file, "utf8");
  const validation = validateOkfFrontmatter(content);
  return {
    ok: validation.ok,
    errors: validation.errors.map((error) => `${page} ${error}.`),
  };
}
async function stampGenerated(root, page, actor) {
  const file = path.join(root, page);
  const content = await readFile(file, "utf8");
  const next = content.replace(
    /^---\r?\n([\s\S]*?)\r?\n---/u,
    (_all, frontmatter) =>
      `---\n${frontmatter.replace(/^generated:\n(?:[ \t].*\n?)*/mu, "").trimEnd()}\ngenerated:\n  by: ${actor}\n  at: ${now()}\n---`,
  );
  if (next !== content)
    await writeFile(file, next.endsWith("\n") ? next : `${next}\n`, "utf8");
}
async function replaceManifest(root, pages, state, preservePages = new Set()) {
  const previous = await readManifest(root);
  const entries = {};
  for (const file of pages) {
    const page = relative(root, file);
    const key = `/${page}`;
    if (preservePages.has(page)) {
      if (previous.pages[key]) entries[key] = previous.pages[key];
      continue;
    }
    const claims = await assertClaimsPageCurrent(root, page);
    entries[key] = {
      ...(state.targetGitHead ? { gitHead: state.targetGitHead } : {}),
      sourceFingerprint: state.sourceFingerprint,
      pageVersion: claims.pageVersion,
      completedBy:
        state.plan.pages.find((job) => job.path === page)?.completedBy ??
        state.actor.producerActor,
      completedRunId: state.runId,
    };
  }
  await writeManifest(root, { schemaVersion: 1, pages: entries });
}

async function recordManifestPageCompletion(
  root,
  page,
  state,
  completedBy = state.actor.producerActor,
) {
  const sidecar = await assertClaimsPageCurrent(root, page);
  const pageVersion = sidecar.pageVersion;
  const manifest = await readManifest(root);
  manifest.pages[`/${page}`] = {
    ...(state.targetGitHead ? { gitHead: state.targetGitHead } : {}),
    sourceFingerprint: state.sourceFingerprint,
    pageVersion,
    completedBy,
    completedRunId: state.runId,
  };
  await writeManifest(root, manifest);
}

async function manifestCompletionIsCurrent(root, page, state, entry) {
  if (
    !entry ||
    entry.sourceFingerprint !== state.sourceFingerprint ||
    (state.targetGitHead && entry.gitHead !== state.targetGitHead) ||
    entry.completedRunId !== state.runId
  )
    return false;
  const pageVersion = hash(await readFile(path.join(root, page)));
  if (entry.pageVersion !== pageVersion) return false;
  const sidecar = await readJson(claimsPath(root, page));
  return Boolean(
    sidecar?.verification &&
    sidecar.pageVersion === pageVersion &&
    Array.isArray(sidecar.claims),
  );
}

async function updatePlanningState(root, mode, existingPages) {
  const pageUpdateWindows =
    mode === "update"
      ? await repositoryPageUpdateWindows(root, existingPages)
      : [];
  return {
    pageUpdateWindows,
    changedPaths: [
      ...new Set(pageUpdateWindows.flatMap((window) => window.changedPaths)),
    ].sort(),
    claimIssues: mode === "update" ? await preflightClaims(root) : [],
    completeCoverage:
      mode !== "update" ||
      (await hasCompleteManifestCoverage(root, existingPages)),
  };
}

/**
 * Mirrors the upstream update planner's page-specific source baselines.
 * A page without a durable completed Git revision requires a full review.
 */
async function repositoryPageUpdateWindows(root, pages) {
  const manifest = await readManifest(root);
  const pagesByBaseline = new Map();
  for (const file of pages) {
    const page = `/${relative(root, file)}`;
    const baseline = manifest.pages[page]?.gitHead ?? "";
    const group = pagesByBaseline.get(baseline) ?? [];
    group.push(page);
    pagesByBaseline.set(baseline, group);
  }
  const windows = [];
  for (const baseline of [...pagesByBaseline.keys()].sort()) {
    windows.push({
      ...(baseline ? { baseGitHead: baseline } : {}),
      pages: pagesByBaseline.get(baseline).sort(),
      changedPaths: await repositoryChangedPaths(root, baseline || undefined),
      fullReview: !baseline,
    });
  }
  return windows;
}

function formatPageUpdateWindows(windows) {
  if (windows.length === 0) return "not applicable";
  return windows
    .map((window) => {
      const scope = window.fullReview
        ? "full review"
        : `base ${window.baseGitHead}`;
      const changed = window.changedPaths.length
        ? window.changedPaths.join(", ")
        : "none";
      return `${window.pages.join(", ")} [${scope}; changed: ${changed}]`;
    })
    .join(" | ");
}

async function readManifest(root) {
  const manifest = await readJson(manifestPath(root));
  if (!manifest) return { schemaVersion: 1, pages: {} };
  if (!validManifest(manifest))
    throw new Error(
      "invalid OpenWiki page manifest; refusing to discard committed page coverage",
    );
  return manifest;
}

async function hasCompleteManifestCoverage(root, pages) {
  return (await uncoveredManifestPages(root, pages)).length === 0;
}

/** Seeds missing legacy page coverage only when current Claims prove the page. */
async function seedManifestCoverage(root, pages, gitHead) {
  const manifest = await readManifest(root);
  let changed = false;
  for (const file of pages) {
    const page = relative(root, file);
    const key = `/${page}`;
    if (manifest.pages[key]) continue;
    try {
      const claims = await assertClaimsPageCurrent(root, page);
      manifest.pages[key] = { gitHead, pageVersion: claims.pageVersion };
      changed = true;
    } catch {
      // Unverifiable legacy pages deliberately remain uncovered for full review.
    }
  }
  if (changed) await writeManifest(root, manifest);
}

async function fastForwardManifestCoverage(root, pages, source) {
  const manifest = await readManifest(root);
  for (const file of pages) {
    const page = relative(root, file);
    const key = `/${page}`;
    const current = manifest.pages[key];
    if (!current) continue;
    const claims = await assertClaimsPageCurrent(root, page);
    manifest.pages[key] = {
      ...(source.gitHead ? { gitHead: source.gitHead } : {}),
      sourceFingerprint: source.fingerprint,
      pageVersion: claims.pageVersion,
      ...(current.completedBy ? { completedBy: current.completedBy } : {}),
      ...(current.completedRunId
        ? { completedRunId: current.completedRunId }
        : {}),
    };
  }
  await writeManifest(root, manifest);
}

async function uncoveredManifestPages(root, existingPages) {
  const manifest = await readManifest(root);
  const pages = existingPages ?? (await factualPages(root));
  const uncovered = [];
  for (const file of pages) {
    const page = relative(root, file);
    const entry = manifest.pages[`/${page}`];
    if (!entry) {
      uncovered.push(page);
      continue;
    }
    try {
      await assertClaimsPageCurrent(root, page);
    } catch {
      uncovered.push(page);
    }
  }
  return uncovered.sort();
}

async function writeManifest(root, manifest) {
  if (!validManifest(manifest))
    throw new Error("invalid OpenWiki page manifest");
  await writeJson(manifestPath(root), {
    schemaVersion: 1,
    pages: Object.fromEntries(
      Object.entries(manifest.pages).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  });
}

function validManifest(manifest) {
  return (
    manifest &&
    typeof manifest === "object" &&
    Object.keys(manifest).length === 2 &&
    manifest.schemaVersion === 1 &&
    manifest.pages &&
    typeof manifest.pages === "object" &&
    !Array.isArray(manifest.pages) &&
    Object.entries(manifest.pages).every(([page, entry]) => {
      try {
        if (`/${normalizePage(page)}` !== page) return false;
      } catch {
        return false;
      }
      return (
        entry &&
        typeof entry === "object" &&
        Object.keys(entry).every((key) =>
          [
            "gitHead",
            "sourceFingerprint",
            "pageVersion",
            "completedBy",
            "completedRunId",
          ].includes(key),
        ) &&
        /^sha256:[a-f0-9]{64}$/u.test(entry.pageVersion) &&
        (entry.gitHead === undefined || typeof entry.gitHead === "string") &&
        (entry.sourceFingerprint === undefined ||
          /^sha256:[a-f0-9]{64}$/u.test(entry.sourceFingerprint)) &&
        (entry.completedBy === undefined ||
          (typeof entry.completedBy === "string" && entry.completedBy)) &&
        (entry.completedRunId === undefined || isUuid(entry.completedRunId))
      );
    })
  );
}
async function synchronizeIndexes(root) {
  const wikiRoot = path.join(root, "openwiki");
  for (const directory of await directories(wikiRoot)) {
    const { readdir } = await import("node:fs/promises");
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
    if (links.length || children.length) {
      const label = relative(wikiRoot, directory) || "Documentation";
      await writeFile(
        path.join(directory, "index.md"),
        `---\ntype: index\ntitle: ${title(label)}\ndescription: Documentation navigation.\n---\n\n# ${title(label)}\n\n${[...children, ...links].join("\n")}\n`,
        "utf8",
      );
    }
  }
}
async function directories(root) {
  if (!(await isDirectory(root))) return [];
  const { readdir } = await import("node:fs/promises");
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
function extractTargets(input, root) {
  const raw = [];
  const tool = input.tool_input ?? input.toolInput ?? {};
  for (const key of [
    "file_path",
    "filePath",
    "output_path",
    "outputPath",
    "path",
    "file",
    "target_file",
    "targetFile",
  ])
    if (typeof tool[key] === "string") raw.push(tool[key]);
  for (const key of ["patch", "command", "new_string", "old_string", "content"])
    if (typeof tool[key] === "string")
      raw.push(
        ...[
          ...tool[key].matchAll(
            /(?:^|[\s'"`])((?:\.?\/?[\w@+=:,.-]+\/)*openwiki\/[\w@+=:,./-]+(?:\.md|\.json))/gmu,
          ),
        ].map((match) => match[1]),
      );
  return [
    ...new Set(
      raw
        .map((candidate) => path.resolve(root, candidate))
        .filter((candidate) => candidate.startsWith(`${root}${path.sep}`)),
    ),
  ];
}
function ownedState(root, target) {
  return (
    target.includes(`${path.sep}openwiki${path.sep}.claims${path.sep}`) ||
    target.endsWith(`${path.sep}.run.json`) ||
    target.endsWith(`${path.sep}.last-update.json`) ||
    target.endsWith(`${path.sep}.page-manifest.json`) ||
    target.includes(`${path.sep}.rollback${path.sep}`)
  );
}
function isWikiMarkdown(root, target) {
  return (
    target.startsWith(`${path.join(root, "openwiki")}${path.sep}`) &&
    target.endsWith(".md")
  );
}
function actorFor() {
  return OPENWIKI_PRODUCER_ACTOR;
}
function modelFor(input) {
  return String(
    input.model ?? (process.env.CLAUDE_PLUGIN_ROOT ? "claude-code" : "codex"),
  );
}
function context(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
}
function deny(permissionDecisionReason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason,
    },
  };
}
