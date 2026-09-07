#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const options = parseOptions(process.argv.slice(2));
const root = path.resolve(options.root);
const wikiRoot = path.resolve(root, options.wikiDir);
const errors = [];

if (!(await isDirectory(wikiRoot))) {
  errors.push(`Wiki directory does not exist: ${wikiRoot}`);
} else {
  const pages = await markdownFiles(wikiRoot);
  const factualPages = pages.filter(
    (page) => !["INSTRUCTIONS.md", "index.md"].includes(path.basename(page)),
  );

  if (factualPages.length === 0) {
    errors.push(`No Markdown pages found in ${wikiRoot}.`);
  }

  if (
    !pages.some((page) => path.relative(wikiRoot, page) === "quickstart.md")
  ) {
    errors.push("Missing required quickstart.md page.");
  }

  for (const page of factualPages) {
    const content = await readFile(page, "utf8");
    const relative = path.relative(root, page);
    const frontMatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/u);
    if (!frontMatter) {
      errors.push(`${relative}: missing YAML front matter.`);
      continue;
    }

    for (const field of ["type", "title", "description"]) {
      if (!new RegExp(`^${field}:\\s*\\S`, "mu").test(frontMatter[1])) {
        errors.push(
          `${relative}: missing required front-matter field '${field}'.`,
        );
      }
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(
    `Less OpenWiki validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`Validated ${path.relative(root, wikiRoot) || "."}.\n`);
}

async function isDirectory(candidate) {
  try {
    return (await lstat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function markdownFiles(directory) {
  const pages = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`Refusing to validate symbolic link: ${absolute}`);
    } else if (entry.isDirectory()) {
      pages.push(...(await markdownFiles(absolute)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      pages.push(absolute);
    }
  }

  return pages;
}

function parseOptions(args) {
  const options = { root: process.cwd(), wikiDir: "openwiki" };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root" || argument === "--wiki-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${argument} requires a value.`);
      }
      options[argument === "--root" ? "root" : "wikiDir"] = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "Usage: validate-wiki.mjs [--root <path>] [--wiki-dir <path>]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return options;
}
