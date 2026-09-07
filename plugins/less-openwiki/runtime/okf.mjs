import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hash, isDirectory, relative } from "./storage.mjs";

/**
 * Brings existing factual pages to the minimum OKF shape before an update.
 * Valid front matter is left untouched; an unusable block is replaced with
 * truthful code-derived metadata so the authoring run can enrich it safely.
 */
export async function normalizeWikiOkf(root, language = "en") {
  for (const file of await markdownFiles(path.join(root, "openwiki"))) {
    const original = await readFile(file, "utf8");
    if (hasUsableOkfType(original)) continue;
    const { body } = splitFrontmatter(original);
    const title = firstHeading(body) ?? titleFromFilename(file);
    const content = `---\ntype: ${JSON.stringify(conceptTypeFor(language))}\ntitle: ${JSON.stringify(title)}\nopenwiki_generated: true\n---\n\n${body}`;
    if (content !== original) await writeFile(file, content, "utf8");
  }
}

function hasUsableOkfType(content) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
    content,
  )?.[1];
  if (!frontmatter) return false;
  const raw = /^type:\s*(.+?)\s*$/mu.exec(frontmatter)?.[1]?.trim();
  if (!raw || /^(?:null|~|\[|\{|\||>|-)/iu.test(raw)) return false;
  const value = /^(["'])(.*)\1$/u.exec(raw)?.[2] ?? raw;
  return Boolean(value.trim());
}

function splitFrontmatter(content) {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(content);
  return { body: match ? content.slice(match[0].length) : content };
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
    de: "Referenz",
    es: "Referencia",
    fr: "Référence",
    it: "Riferimento",
    ja: "リファレンス",
    ko: "참조",
    pt: "Referência",
    ru: "Справочник",
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

function readGenerated(content) {
  const block = /^generated:\n((?:^[ \t].*(?:\n|$))*)/mu.exec(
    /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1] ?? "",
  )?.[1];
  const by = /^\s*by:\s*(\S.*?)\s*$/mu.exec(block ?? "")?.[1]?.trim();
  const at = /^\s*at:\s*(\S.*?)\s*$/mu.exec(block ?? "")?.[1]?.trim();
  return by ? { by, ...(at ? { at } : {}) } : undefined;
}

function setGenerated(content, actor, at) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (!match) return content;
  const clean = match[1]
    .replace(/^generated:\n(?:^[ \t].*(?:\n|$))*/mu, "")
    .replace(/^timestamp:\s*.*\n?/mu, "")
    .trimEnd();
  return content.replace(
    /^---\r?\n([\s\S]*?)\r?\n---/u,
    `---\n${clean}\ngenerated:\n  by: ${actor}${at ? `\n  at: ${at}` : ""}\n---`,
  );
}

function restoreGenerated(content, previous) {
  const current = readGenerated(content);
  if (current?.by === previous?.by && current?.at === previous?.at)
    return content;
  if (!previous) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
    if (!match) return content;
    return content.replace(
      /^---\r?\n([\s\S]*?)\r?\n---/u,
      `---\n${match[1].replace(/^generated:\n(?:^[ \t].*(?:\n|$))*/mu, "").trimEnd()}\n---`,
    );
  }
  return setGenerated(content, previous.by, previous.at ?? "");
}

function synchronizeVerification(content, actor, at) {
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
  const block = `verified:\n${existing}  - by: ${actor}\n    at: ${at}\n`;
  return content.replace(
    /^---\r?\n([\s\S]*?)\r?\n---/u,
    `---\n${clean}\n${block}---`,
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
  const value = (key) => {
    const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "mu").exec(frontmatter);
    if (!match) return undefined;
    const raw = match[1].trim();
    const unquoted = /^(["'])(.*)\1$/u.exec(raw)?.[2] ?? raw;
    return unquoted.trim() || undefined;
  };
  return { title: value("title"), description: value("description") };
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
