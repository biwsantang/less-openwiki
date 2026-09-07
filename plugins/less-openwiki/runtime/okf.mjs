import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hash, isDirectory, relative } from "./storage.mjs";
import { parse, stringify } from "./vendor/yaml.mjs";

/**
 * Brings existing factual pages to the minimum OKF shape before an update.
 * Valid front matter is left untouched; an unusable block is replaced with
 * truthful code-derived metadata so the authoring run can enrich it safely.
 */
export async function normalizeWikiOkf(root, language = "en") {
  for (const file of await markdownFiles(path.join(root, "openwiki"))) {
    await normalizePageOkf(root, relative(root, file), language);
  }
}

/** Repairs one factual page before Claims are made durable. */
export async function normalizePageOkf(root, page, language = "en") {
  const file = path.join(root, page);
  const original = await readFile(file, "utf8");
  const content = repairOkfFrontmatter(
    original,
    file,
    conceptTypeFor(language),
  );
  if (content !== original) await writeFile(file, content, "utf8");
}

/** Validates the complete supported OKF front-matter contract. */
export function validateOkfFrontmatter(content) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!block) return { ok: false, errors: ["missing YAML front matter"] };
  let fields;
  try {
    fields = parse(`\n${block[1]}`, {
      maxAliasCount: 100,
      schema: "core",
      uniqueKeys: true,
    });
  } catch {
    return { ok: false, errors: ["invalid YAML front matter"] };
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    return { ok: false, errors: ["YAML front matter must be a mapping"] };
  const errors = [];
  if (!Object.hasOwn(fields, "type"))
    errors.push("missing 'type' front matter");
  for (const key of ["type", "title", "description", "resource", "timestamp"])
    if (
      Object.hasOwn(fields, key) &&
      (typeof fields[key] !== "string" || !fields[key].trim())
    )
      errors.push(`invalid '${key}' front matter`);
  if (
    Object.hasOwn(fields, "tags") &&
    (!Array.isArray(fields.tags) ||
      fields.tags.some((tag) => typeof tag !== "string" || !tag.trim()))
  )
    errors.push("invalid 'tags' front matter");
  if (Object.hasOwn(fields, "generated") && !isActorEvent(fields.generated))
    errors.push("invalid 'generated' front matter");
  if (Object.hasOwn(fields, "verified")) {
    const events = Array.isArray(fields.verified)
      ? fields.verified
      : [fields.verified];
    if (!events.every(isActorEvent))
      errors.push("invalid 'verified' front matter");
  }
  if (
    Object.hasOwn(fields, "sources") &&
    (!Array.isArray(fields.sources) ||
      fields.sources.some(
        (source) =>
          !source ||
          typeof source !== "object" ||
          Array.isArray(source) ||
          typeof source.resource !== "string" ||
          !source.resource.trim(),
      ))
  )
    errors.push("invalid 'sources' front matter");
  if (
    Object.hasOwn(fields, "status") &&
    (typeof fields.status !== "string" ||
      !["draft", "stable", "deprecated"].includes(fields.status))
  )
    errors.push("invalid 'status' front matter");
  if (
    Object.hasOwn(fields, "stale_after") &&
    (typeof fields.stale_after !== "string" ||
      !isIsoDateTime(fields.stale_after))
  )
    errors.push("invalid 'stale_after' front matter");
  return { ok: errors.length === 0, errors };
}

function repairOkfFrontmatter(content, file, conceptType) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  const body = match ? content.slice(match[0].length) : content;
  const fallback = () => {
    const title = firstHeading(body) ?? titleFromFilename(file);
    return `---\ntype: ${JSON.stringify(conceptType)}\ntitle: ${JSON.stringify(title)}\nopenwiki_generated: true\n---\n\n${body}`;
  };
  if (!match) return fallback();
  const fields = frontmatterFields(match[1]);
  if (!fields || !frontmatterLooksComplete(fields)) return fallback();
  const replacements = new Map();
  const type = fields.get("type");
  const typeWasDerived = !isNonEmptyYamlString(type);
  if (typeWasDerived) {
    replacements.set("type", [`type: ${JSON.stringify(conceptType)}`]);
    replacements.set("openwiki_generated", ["openwiki_generated: true"]);
  }
  const title = fields.get("title");
  if ((typeWasDerived && !title) || (title && !isNonEmptyYamlString(title))) {
    replacements.set("title", [
      `title: ${JSON.stringify(firstHeading(body) ?? titleFromFilename(file))}`,
    ]);
  }
  for (const name of ["description", "resource", "timestamp"]) {
    const field = fields.get(name);
    if (field && !isNonEmptyYamlString(field)) replacements.set(name, []);
  }
  const tags = fields.get("tags");
  if (tags) {
    const repaired = repairTags(tags);
    if (repaired) replacements.set("tags", repaired);
  }
  const generated = fields.get("generated");
  if (generated && !isValidActorEvents(generated, false))
    replacements.set("generated", []);
  const verified = fields.get("verified");
  if (verified) {
    const candidates = Array.isArray(verified.parsed)
      ? verified.parsed
      : [verified.parsed];
    const valid = candidates.filter(isActorEvent);
    if (valid.length !== candidates.length)
      replacements.set(
        "verified",
        valid.length ? renderStructuredList("verified", valid) : [],
      );
  }
  const sources = fields.get("sources");
  if (sources) {
    const valid = validSources(sources);
    if (valid.length !== sources.parsed.length)
      replacements.set(
        "sources",
        valid.length ? renderStructuredList("sources", valid) : [],
      );
  }
  const status = fields.get("status");
  if (
    status &&
    (typeof status.parsed !== "string" ||
      !["draft", "stable", "deprecated"].includes(status.parsed))
  )
    replacements.set("status", []);
  const staleAfter = fields.get("stale_after");
  if (
    staleAfter &&
    (typeof staleAfter.parsed !== "string" || !isIsoDateTime(staleAfter.parsed))
  )
    replacements.set("stale_after", []);
  if (replacements.size === 0) return content;
  const frontmatter = rewriteFrontmatter(match[1], fields, replacements);
  return `${content.slice(0, match.index)}---\n${frontmatter}\n---\n${body}`;
}

function frontmatterFields(frontmatter) {
  let parsed;
  try {
    parsed = parse(`\n${frontmatter}`, {
      maxAliasCount: 100,
      schema: "core",
      uniqueKeys: true,
    });
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const lines = frontmatter.split(/\r?\n/u);
  const fields = new Map();
  let current;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s/u.test(line) || line === "") continue;
    const match = /^([^\s:#][^:]*):(?:\s*(.*))?$/u.exec(line);
    if (!match || fields.has(match[1])) return null;
    if (current) current.end = index;
    current = {
      end: lines.length,
      key: match[1],
      lines,
      parsed: parsed[match[1]],
      start: index,
      value: match[2] ?? "",
    };
    fields.set(current.key, current);
  }
  if (current) current.end = lines.length;
  return fields;
}

function frontmatterLooksComplete(fields) {
  return Boolean(fields);
}

function isNonEmptyYamlString(field) {
  return typeof field?.parsed === "string" && Boolean(field.parsed.trim());
}

function repairTags(field) {
  const tags = Array.isArray(field.parsed)
    ? field.parsed.filter(
        (tag) => typeof tag === "string" && Boolean(tag.trim()),
      )
    : [];
  return tags.length ? renderStructuredList("tags", tags) : [];
}

function isValidActorEvents(field, allowList) {
  const events =
    allowList && Array.isArray(field.parsed) ? field.parsed : [field.parsed];
  return (
    events.length > 0 &&
    events.every(
      (event) =>
        event &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        typeof event.by === "string" &&
        event.by.trim() &&
        (event.at === undefined ||
          (typeof event.at === "string" && isIsoDateTime(event.at))),
    )
  );
}

function isActorEvent(event) {
  return (
    event &&
    typeof event === "object" &&
    !Array.isArray(event) &&
    typeof event.by === "string" &&
    event.by.trim() &&
    (event.at === undefined ||
      (typeof event.at === "string" &&
        event.at.trim() &&
        isIsoDateTime(event.at)))
  );
}

function validSources(field) {
  if (!Array.isArray(field.parsed)) return [];
  return field.parsed.filter(
    (source) =>
      source &&
      typeof source === "object" &&
      !Array.isArray(source) &&
      typeof source.resource === "string" &&
      source.resource.trim(),
  );
}

function renderStructuredList(key, values) {
  return [
    `${key}:`,
    ...stringify(values, { lineWidth: 0 })
      .trimEnd()
      .split("\n")
      .map((line) => `  ${line}`),
  ];
}

function renderStructuredValue(key, value) {
  return stringify({ [key]: value }, { lineWidth: 0 })
    .trimEnd()
    .split("\n");
}

function yamlFrontmatter(content) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1];
  if (!frontmatter) return undefined;
  try {
    const parsed = parse(`\n${frontmatter}`, {
      maxAliasCount: 100,
      schema: "core",
      uniqueKeys: true,
    });
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function verificationEvents(value) {
  const candidates = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  return candidates.filter(
    (event) =>
      event &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      typeof event.by === "string" &&
      event.by.trim() &&
      (event.at === undefined ||
        (typeof event.at === "string" && event.at.trim())),
  );
}

function isIsoDateTime(value) {
  const match =
    /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|([+-]\d\d):(\d\d))$/u.exec(
      value,
    );
  if (!match) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    match.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  const days =
    month === 2
      ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function rewriteFrontmatter(frontmatter, fields, replacements) {
  const lines = frontmatter.split(/\r?\n/u);
  const rendered = [];
  for (const field of fields.values()) {
    rendered.push(
      ...(replacements.has(field.key)
        ? replacements.get(field.key)
        : lines.slice(field.start, field.end)),
    );
  }
  for (const [key, value] of replacements)
    if (!fields.has(key)) rendered.push(...value);
  return rendered.join("\n");
}

function firstHeading(content) {
  return /^#\s+(.+?)\s*#*\s*$/mu.exec(content)?.[1]?.trim();
}

function titleFromFilename(file) {
  const base = path.posix.basename(file, ".md").replace(/[-_]+/gu, " ").trim();
  return base ? `${base[0].toUpperCase()}${base.slice(1)}` : "Documentation";
}

function conceptTypeFor(language) {
  const labels = {
    ar: "مرجع",
    ca: "Referència",
    cs: "Reference",
    da: "Reference",
    de: "Referenz",
    el: "Αναφορά",
    es: "Referencia",
    fr: "Référence",
    hi: "संदर्भ",
    hr: "Referenca",
    id: "Referensi",
    it: "Riferimento",
    ja: "リファレンス",
    ko: "참조",
    ms: "Rujukan",
    nb: "Referanse",
    nl: "Referentie",
    no: "Referanse",
    pt: "Referência",
    ro: "Referință",
    ru: "Справочник",
    sk: "Referencia",
    sr: "Референца",
    sv: "Referens",
    th: "อ้างอิง",
    tr: "Referans",
    uk: "Довідник",
    vi: "Tham khảo",
    zh: "参考",
    "zh-TW": "參考",
  };
  let locale;
  try {
    locale = new Intl.Locale(language).toString();
  } catch {
    locale = language;
  }
  return labels[locale] ?? labels[locale.split("-")[0]] ?? "Reference";
}

/** Applies page-local provenance and Claims-source projections after Claims succeeds. */
export async function finalizePage(root, page, actor, claims, at) {
  await projectClaimSources(root, page, claims);
}

/** Reprojects durable Claims evidence into every factual page's OKF sources. */
export async function synchronizeClaimSources(root) {
  for (const file of await markdownFiles(path.join(root, "openwiki"))) {
    const page = relative(root, file);
    const sidecar = await readClaimsSidecar(root, page);
    if (!sidecar) continue;
    await projectClaimSources(root, page, sidecar.claims);
  }
}

/** Reconciles generated provenance against the pre-authoring body snapshot. */
export async function finalizeGeneratedProvenance(root, state) {
  const initial = new Map(
    state.preparedWiki.generatedProvenance.map((entry) => [entry.page, entry]),
  );
  for (const file of await markdownFiles(path.join(root, "openwiki"))) {
    const page = `/${relative(root, file)}`;
    const content = await readFile(file, "utf8");
    const prior = initial.get(page);
    const changed = !prior || prior.bodyHash !== bodyHash(content);
    const job = state.plan.pages.find(
      (candidate) => `/${candidate.path}` === page,
    );
    const next = changed
      ? setGenerated(
          content,
          job?.completedBy ?? state.actor.producerActor,
          state.startedAt,
        )
      : restoreGenerated(content, prior.generated);
    const verified =
      job?.status === "complete"
        ? synchronizeVerification(
            next,
            job.completedBy ?? state.actor.producerActor,
            state.startedAt,
          )
        : next;
    if (verified !== content) await writeFile(file, verified, "utf8");
  }
}

function bodyHash(content) {
  return hash(content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, ""));
}

export function readGeneratedEvent(content) {
  const value = yamlFrontmatter(content)?.generated;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.by !== "string" ||
    !value.by.trim() ||
    (value.at !== undefined &&
      (typeof value.at !== "string" || !value.at.trim()))
  )
    return undefined;
  return { by: value.by, ...(value.at ? { at: value.at } : {}) };
}

function setGenerated(content, actor, at) {
  return replaceFrontmatterField(
    replaceFrontmatterField(content, "timestamp", []),
    "generated",
    renderStructuredValue("generated", {
      by: actor,
      ...(at ? { at } : {}),
    }),
  );
}

function restoreGenerated(content, previous) {
  const current = readGeneratedEvent(content);
  if (current?.by === previous?.by && current?.at === previous?.at)
    return content;
  if (!previous) return replaceFrontmatterField(content, "generated", []);
  return setGenerated(content, previous.by, previous.at ?? "");
}

function synchronizeVerification(content, actor, at) {
  const events = verificationEvents(yamlFrontmatter(content)?.verified);
  const retained = events.filter(({ by }) => !by.startsWith("openwiki/"));
  return replaceFrontmatterField(
    content,
    "verified",
    renderStructuredList("verified", [...retained, { by: actor, at }]),
  );
}

/** Builds deterministic OKF v0.2 navigation indexes after Claims validation. */
export async function finalizeWiki(root, language = "en") {
  const wikiRoot = path.join(root, "openwiki");
  await degradeInvalidMermaid(root);
  const labels = indexLabels(language);
  for (const directory of await directories(wikiRoot)) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".md") &&
            !["index.md", "log.md", "INSTRUCTIONS.md"].includes(entry.name) &&
            !entry.name.startsWith("."),
        )
        .map(async (entry) => {
          const metadata = indexMetadata(
            await readFile(path.join(directory, entry.name), "utf8"),
          );
          return {
            href: encodeURIComponent(entry.name),
            label: metadata.title ?? path.posix.basename(entry.name, ".md"),
            description: metadata.description,
          };
        }),
    );
    const children = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({
        href: `${encodeURIComponent(entry.name)}/`,
        label: entry.name,
      }));
    const content = renderIndex(
      files,
      children,
      directory === wikiRoot,
      labels,
    );
    const index = path.join(directory, "index.md");
    let existing = null;
    try {
      existing = await readFile(index, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (existing !== content) await writeFile(index, content, "utf8");
  }
  await validateInternalLinks(root);
}

function renderIndex(files, directories, isRoot, labels) {
  const sections = [
    renderLinks(labels.files, files, true),
    renderLinks(labels.directories, directories, false),
  ]
    .filter(Boolean)
    .join("\n\n");
  return `${isRoot ? '---\nokf_version: "0.2"\n---\n\n' : ""}${sections || `# ${labels.files}`}\n`;
}

function renderLinks(heading, links, includeDescription) {
  if (links.length === 0) return "";
  links.sort((left, right) => left.href.localeCompare(right.href));
  return `# ${heading}\n\n${links
    .map(({ description, href, label }) => {
      const link = `- [${escapeLabel(label)}](${href})`;
      return includeDescription && description
        ? `${link} - ${description}`
        : link;
    })
    .join("\n")}`;
}

function indexMetadata(content) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1];
  if (!frontmatter) return {};
  let metadata;
  try {
    metadata = parse(`\n${frontmatter}`, {
      maxAliasCount: 100,
      schema: "core",
      uniqueKeys: true,
    });
  } catch {
    return {};
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return {};
  const usable = (value) =>
    typeof value === "string" && value.trim() ? value : undefined;
  return {
    ...(usable(metadata.title) ? { title: usable(metadata.title) } : {}),
    ...(usable(metadata.description)
      ? { description: usable(metadata.description) }
      : {}),
  };
}

function escapeLabel(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function indexLabels(language) {
  const labels = {
    ar: ["ملفات", "مجلدات"],
    bg: ["Файлове", "Директории"],
    ca: ["Fitxers", "Directoris"],
    cs: ["Soubory", "Adresáře"],
    da: ["Filer", "Mapper"],
    de: ["Dateien", "Verzeichnisse"],
    el: ["Αρχεία", "Κατάλογοι"],
    es: ["Archivos", "Directorios"],
    fi: ["Tiedostot", "Hakemistot"],
    fr: ["Fichiers", "Répertoires"],
    he: ["קבצים", "תיקיות"],
    hi: ["फ़ाइलें", "निर्देशिकाएँ"],
    hr: ["Datoteke", "Direktoriji"],
    hu: ["Fájlok", "Könyvtárak"],
    id: ["Berkas", "Direktori"],
    it: ["File", "Cartelle"],
    ja: ["ファイル", "ディレクトリ"],
    ko: ["파일", "디렉터리"],
    ms: ["Fail", "Direktori"],
    nb: ["Filer", "Mapper"],
    nl: ["Bestanden", "Mappen"],
    no: ["Filer", "Mapper"],
    pl: ["Pliki", "Katalogi"],
    pt: ["Arquivos", "Diretórios"],
    "pt-PT": ["Ficheiros", "Diretórios"],
    ro: ["Fișiere", "Directoare"],
    ru: ["Файлы", "Каталоги"],
    sk: ["Súbory", "Adresáre"],
    sl: ["Datoteke", "Mape"],
    sr: ["Датотеке", "Директоријуми"],
    sv: ["Filer", "Kataloger"],
    th: ["ไฟล์", "ไดเรกทอรี"],
    tr: ["Dosyalar", "Dizinler"],
    uk: ["Файли", "Каталоги"],
    vi: ["Tập tin", "Thư mục"],
    zh: ["文件", "目录"],
    "zh-TW": ["檔案", "目錄"],
  };
  let locale;
  try {
    locale = new Intl.Locale(language).toString();
  } catch {
    locale = language;
  }
  const found = labels[locale] ??
    labels[locale.split("-")[0]] ?? ["Files", "Directories"];
  return { files: found[0], directories: found[1] };
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
        const sourcePath = `/${relative(root, file)}`;
        if (!target && anchor) {
          const anchors = headingAnchors(cleaned);
          if (!anchors.has(anchor))
            stamped.push({
              href,
              line: index,
              message: `heading anchor \"${anchor}\" does not exist in ${sourcePath}`,
            });
          continue;
        }
        const virtualTarget = path.posix.normalize(
          target.startsWith("/")
            ? target
            : path.posix.join(path.posix.dirname(sourcePath), target),
        );
        const absolute = path.resolve(root, `.${virtualTarget}`);
        const directory = target.endsWith("/");
        if (!(await exists(absolute))) {
          stamped.push({
            href,
            line: index,
            message: `${directory ? "directory" : "file"} \"${target}\" does not exist`,
          });
          continue;
        }
        if (anchor && !directory && absolute.toLowerCase().endsWith(".md")) {
          const anchors = headingAnchors(await readFile(absolute, "utf8"));
          if (!anchors.has(anchor))
            stamped.push({
              href,
              line: index,
              message: `heading anchor \"${anchor}\" does not exist in \"${target}\"`,
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
        `<!-- openwiki: broken internal link [${issue.href}] ${issue.message}. Fix the href or restore the target, then delete this comment. -->`,
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
    const changes = extractMermaidFences(original)
      .map((fence) => ({ ...fence, error: mermaidHeuristicError(fence.body) }))
      .filter(({ error }) => error !== undefined);
    if (changes.length === 0) continue;
    for (const change of changes.reverse())
      lines.splice(
        change.openLine,
        change.closeLine - change.openLine + 1,
        `${change.indent}<!-- openwiki: mermaid parse failed and this diagram was converted to a text fence so it does not break rendering. Fix the diagram source and restore the mermaid fence. Parser error: ${change.error} -->`,
        `${change.indent}${change.marker}text`,
        ...change.body.split("\n"),
        `${change.indent}${change.marker}`,
      );
    await writeFile(file, lines.join("\n"), "utf8");
  }
}

function extractMermaidFences(markdown) {
  const lines = markdown.split("\n");
  const fences = [];
  let open;
  let genericMarker;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^(\s*)(`{3,})\s*(\S*)\s*$/u.exec(line);
    if (open) {
      if (match && match[2].length >= open.marker.length && !match[3]) {
        fences.push({
          ...open,
          body: open.bodyLines.join("\n"),
          closeLine: index,
        });
        open = undefined;
      } else open.bodyLines.push(line);
      continue;
    }
    if (genericMarker) {
      if (match && match[2].length >= genericMarker.length && !match[3])
        genericMarker = undefined;
      continue;
    }
    if (match && match[3].toLowerCase() === "mermaid")
      open = {
        bodyLines: [],
        indent: match[1],
        marker: match[2],
        openLine: index,
      };
    else if (match && match[3]) genericMarker = match[2];
  }
  return fences;
}

function mermaidHeuristicError(body) {
  const first = body.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  if (
    (first === "flowchart" || first === "graph") &&
    (/(?:^|\n|\s)end\s*[[({]/u.test(body) ||
      /-->\s*end\s*(?:$|\n|;)/mu.test(body))
  )
    return "Heuristic: `end` is a reserved word and cannot be a flowchart node id; rename the node.";
  if (/[[({][^)\]}]*;[^)\]}]*[)\]}]/u.test(body))
    return "Heuristic: a semicolon inside a label breaks rendering; rephrase the label.";
  if (/[[({][^)\]}]*[<>][^)\]}]*[)\]}]/u.test(body))
    return "Heuristic: an unescaped angle bracket inside a label breaks rendering; rephrase the label.";
  return undefined;
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
  const projected = resources.map((resource) => ({
    id: `openwiki-source-${hash(resource).slice("sha256:".length, "sha256:".length + 24)}`,
    resource,
  }));
  const next = replaceClaimSources(content, projected);
  if (next !== content) await writeFile(file, next, "utf8");
}

async function readClaimsSidecar(root, page) {
  const sidecar = path.join(
    root,
    "openwiki",
    ".claims",
    page.slice("openwiki/".length).replace(/\.md$/u, ".json"),
  );
  try {
    const value = JSON.parse(await readFile(sidecar, "utf8"));
    return Array.isArray(value?.claims) ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Replaces only source entries owned by the Claims projection. */
function replaceClaimSources(content, projected) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (!match) return content;
  let metadata;
  try {
    metadata = parse(`\n${match[1]}`, {
      maxAliasCount: 100,
      schema: "core",
      uniqueKeys: true,
    });
  } catch {
    return content;
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return content;
  const retained = validSourceEntries(metadata.sources).filter(
    (entry) =>
      !(
        typeof entry.id === "string" && entry.id.startsWith("openwiki-source-")
      ),
  );
  return replaceFrontmatterField(
    content,
    "sources",
    renderStructuredList("sources", [...retained, ...projected]),
  );
}

function validSourceEntries(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (source) =>
      source &&
      typeof source === "object" &&
      !Array.isArray(source) &&
      typeof source.resource === "string" &&
      source.resource.trim(),
  );
}

function replaceFrontmatterField(content, key, replacement) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) return content;
  const lines = match[1].split(/\r?\n/u);
  const start = lines.findIndex((line) =>
    new RegExp(`^${key}:`, "u").test(line),
  );
  const next = [...lines];
  if (start === -1) next.push(...replacement);
  else {
    let end = start + 1;
    while (end < lines.length && (lines[end] === "" || /^\s/u.test(lines[end])))
      end += 1;
    next.splice(start, end - start, ...replacement);
  }
  return `${content.slice(0, match.index)}---\n${next.join("\n")}\n---\n${content.slice(match.index + match[0].length)}`;
}

async function directories(root) {
  if (!(await isDirectory(root))) return [];
  const out = [root];
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.name.startsWith("."))
      out.push(...(await directories(path.join(root, entry.name))));
  return out.sort();
}
