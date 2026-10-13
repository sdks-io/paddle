#!/usr/bin/env node
// Generates skills/typescript/typescript-paddle-billing/templates/INDEX.md from the templates' own
// header comments and exports, so the index cannot drift from the files it describes.
//
//   node tools/build-paddle-billing-template-index.mjs           write INDEX.md
//   node tools/build-paddle-billing-template-index.mjs --check   exit 1 when INDEX.md is stale
//
// Every template must match a rule in RULES below: a new file fails the build until someone decides
// whether an agent should copy, adapt, run or never open it.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const templates = join(here, "..", "skills", "typescript", "typescript-paddle-billing", "templates");
const indexPath = join(templates, "INDEX.md");

// First match wins. `group` collapses the matching files into one row.
const RULES = [
  [/^tests\/fixtures\//, { use: "never open", step: "9", group: "tests/fixtures/*", what: "example Paddle payloads the tests read" }],
  [/^tests\//, { use: "run", step: "9", stem: true, note: "no network; `npx tsx tests/paddle/<file>`" }],
  [/^server\/paddle\/store\.memory\.ts$/, { use: "test double", step: "9", note: "copy it with the tests (they import it); never use it as the app's store" }],
  [/^server\/paddle\/store\.ts$/, { use: "copy", step: "3", note: "the contract; read only its header comment, and only to port the store to an ORM" }],
  [/^server\/paddle\/store\.pg\.ts$/, { use: "copy", step: "3", note: "PostgreSQL; port it only if the project uses an ORM" }],
  [/^db\/schema\.sql$/, { use: "copy", step: "3", note: "idempotent; run it with the project's migration tool" }],
  [/^server\/paddle\/webhooks\/setup\.ts$/, { use: "adapt", step: "4", note: "put the app's reactions (emails, credits, licence keys) in its hooks" }],
  [/^server\/paddle\/webhooks\/(express|nextjs)\.ts$/, { use: "copy", step: "4", note: "copy the one that matches the framework" }],
  [/^server\/paddle\/webhooks\//, { use: "copy", step: "4" }],
  [/^server\/paddle\/(config|client|errors|pagination|writes)\.ts$/, { use: "copy", step: "1" }],
  [/^server\/paddle\/entitlements\.ts$/, { use: "copy", step: "5" }],
  [/^server\/paddle\/routes\.express\.ts$/, { use: "adapt", step: "5", note: "Express as is; otherwise port the handlers to the project's router and auth" }],
  [/^server\/paddle\/checkout\.ts$/, { use: "copy", step: "6" }],
  [/^server\/paddle\/subscriptions\.ts$/, { use: "recipe 04", step: "8", note: "only when plan changes, pause or cancel are in scope" }],
  [/^server\/paddle\/adjustments\.ts$/, { use: "recipe 05", step: "8", note: "only when refunds or credits are in scope" }],
  [/^server\/paddle\/backoffice\.ts$/, { use: "recipe 07", step: "8", note: "only when the app must show metrics or reports" }],
  [/^web\/paddle-browser\.ts$/, { use: "copy", step: "6" }],
  [/^web\/PaddleCheckoutButton\.tsx$/, { use: "adapt", step: "6", note: "restyle it and point it at the app's post-checkout page" }],
  [/^web\/pay\.html$/, { use: "adapt", step: "6", note: "serve at the default payment link path; set the thank-you path" }],
];

const USE_ORDER = ["adapt", "copy", "recipe", "run", "test double", "never open"];
const MAX_EXPORTS = 10;
const MAX_WHAT = 150;

const lf = (s) => s.replace(/\r\n/g, "\n");

function walk(dir, base = "") {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]))
    .filter((p) => p !== "INDEX.md")
    .sort();
}

/** The comment block at the top of a file, as plain lines. */
function headerLines(text) {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && /^(\s*|["']use client["'];?|<!doctype.*)$/i.test(lines[i])) i++;
  const first = (lines[i] ?? "").trim();
  const out = [];
  if (first.startsWith("/**") || first.startsWith("<!--")) {
    for (let j = i; j < lines.length; j++) {
      const end = lines[j].includes("*/") || lines[j].includes("-->");
      out.push(lines[j].replace(/^\s*(\/\*\*?|<!--)/, "").replace(/(\*\/|-->)\s*$/, "").replace(/^\s*\* ?/, "").trimEnd());
      if (end) break;
    }
  } else if (first.startsWith("//") || first.startsWith("--")) {
    const marker = first.startsWith("//") ? "//" : "--";
    for (let j = i; j < lines.length && lines[j].trim().startsWith(marker); j++) out.push(lines[j].trim().slice(marker.length).replace(/^ /, ""));
  }
  return out;
}

function summary(lines, path) {
  const body = lines.filter((l) => !/^Run:/.test(l));
  while (body.length && body[0].trim() === "") body.shift();
  const para = [];
  for (const l of body) {
    if (l.trim() === "") break;
    para.push(l.trim());
  }
  let s = "";
  if (para.length) {
    const text = para[0].endsWith(":") ? para[0].slice(0, -1) : para.join(" ");
    s = (text.match(/^(.+?[.!?])(\s|$)/) ?? [, text])[1].replace(/\.$/, "");
  }
  if (!s) s = path.split("/").pop().replace(/\.[^.]+$/, "").replace(/[-.]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 100) s = s.replace(/\s*\([^)]*\)/g, "");
  if (s.length > MAX_WHAT) {
    const colon = s.indexOf(":");
    s = colon > 20 && colon < MAX_WHAT ? s.slice(0, colon) : s.slice(0, MAX_WHAT - 1).replace(/\s+\S*$/, "") + "…";
  }
  return s;
}

/** Exported values (functions, classes, constants); exported types only when the file has no values. */
function exportsOf(text) {
  const values = [];
  const types = [];
  for (const m of text.matchAll(/^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|const|let|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm)) {
    (m[1] === "interface" || m[1] === "type" ? types : values).push(m[2]);
  }
  for (const m of text.matchAll(/^export\s+(type\s+)?\{([^}]+)\}/gm)) {
    for (const n of m[2].split(",")) (m[1] ? types : values).push(n.trim().split(/\s+as\s+/).pop());
  }
  return [...new Set((values.length ? values : types).filter(Boolean))];
}

const esc = (s) => s.replace(/\|/g, "\\|");
const kb = (n) => (n < 1000 ? `${n} B` : `${(n / 1000).toFixed(1)} KB`);

function build() {
  const rows = new Map(); // key -> row
  for (const path of walk(templates)) {
    const rule = RULES.find(([re]) => re.test(path));
    if (!rule) throw new Error(`templates/${path} matches no rule in tools/build-paddle-billing-template-index.mjs; decide whether an agent copies, adapts, runs or never opens it, and add a rule.`);
    const text = lf(readFileSync(join(templates, path), "utf8"));
    const spec = rule[1];
    const size = Buffer.byteLength(text, "utf8");
    const key = spec.group ?? path;
    const row = rows.get(key) ?? { file: key, use: spec.use, step: spec.step, note: spec.note, what: spec.what, size: 0, count: 0, exports: [] };
    row.size += size;
    row.count += 1;
    if (spec.stem) {
      // Test headers are run instructions, not descriptions: name the file's subject instead.
      row.what = `${path.split("/").pop().replace(/\.test\.m?ts$/, "").replace(/[-.]/g, " ")} tests`;
    } else if (!spec.group) {
      row.what = summary(headerLines(text), path);
      if (/\.(ts|tsx|mts)$/.test(path)) row.exports = exportsOf(text);
    }
    rows.set(key, row);
  }
  const list = [...rows.values()];
  const useGroup = (u) => (u.startsWith("recipe") ? "recipe" : u);
  const order = (r) => USE_ORDER.indexOf(useGroup(r.use));

  const totals = USE_ORDER.map((u) => {
    const rs = list.filter((r) => useGroup(r.use) === u);
    return { u, files: rs.reduce((n, r) => n + r.count, 0), size: rs.reduce((n, r) => n + r.size, 0) };
  });
  const all = totals.reduce((n, t) => n + t.size, 0);

  const out = [];
  out.push("# Templates index", "");
  out.push("**Do not read a template to copy it.** The templates total " + kb(all) + "; reading one to retype it costs its tokens twice and risks changing behaviour the tests pin.", "");
  out.push("1. Copy with the shell, keeping the relative path (`cp`, `Copy-Item`). Nothing is gained by opening the file first. Copy only the files the build step names; never copy a whole directory, which brings recipe-gated modules and the adapter you do not use.");
  out.push("2. Open a file only when its **Use** is `adapt`, or to look up one signature: search the file for the export (`grep -n \"export\"`) and read just that function.");
  out.push("3. `run` files: copy them and run them; open one only to port it to a project test runner. Never open `tests/fixtures/*`.");
  out.push("4. `recipe NN` files: do not copy unless that recipe is in scope. `test double`: copy it with the tests (they import it); never use it as the app's store.", "");
  out.push("| Use | Files | Size | What the agent does |", "| --- | --- | --- | --- |");
  const does = { adapt: "read, then edit", copy: "copy; do not open", recipe: "copy when the recipe is asked for", run: "copy and run", "test double": "copy with the tests", "never open": "never open" };
  for (const t of totals) if (t.files) out.push(`| \`${t.u}\` | ${t.files} | ${kb(t.size)} | ${does[t.u]} |`);
  out.push("", "| File | Use | Step | What it is | Exports |", "| --- | --- | --- | --- | --- |");
  for (const r of list.sort((a, b) => order(a) - order(b) || a.file.localeCompare(b.file))) {
    const what = esc(r.what) + (r.note ? ` — ${esc(r.note)}` : "");
    const names = r.exports.length ? r.exports.slice(0, MAX_EXPORTS).map((n) => `\`${n}\``).join(", ") + (r.exports.length > MAX_EXPORTS ? `, +${r.exports.length - MAX_EXPORTS} more` : "") : "—";
    const file = r.count > 1 ? `\`${r.file}\` (${r.count} files)` : `\`${r.file}\``;
    out.push(`| ${file} | ${r.use} | ${r.step} | ${what} | ${names} |`);
  }
  out.push("", "Step numbers are the build steps in SKILL.md section 9.", "");
  return out.join("\n");
}

const next = build();
if (process.argv.includes("--check")) {
  let current = "";
  try { current = lf(readFileSync(indexPath, "utf8")); } catch { /* missing */ }
  if (current !== next) {
    console.error("templates/INDEX.md is stale. Run: node tools/build-paddle-billing-template-index.mjs");
    process.exit(1);
  }
  console.log("templates/INDEX.md is current.");
} else {
  writeFileSync(indexPath, next, "utf8");
  console.log(`wrote ${indexPath} (${Buffer.byteLength(next, "utf8")} bytes)`);
}
