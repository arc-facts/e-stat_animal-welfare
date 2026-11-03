#!/usr/bin/env node
/*
 * サイトを描画して、確認マーク（sup.fc）ごとの「記述」を data/statements.csv に書き出す。
 *
 *     node scripts/extract_statements.mjs
 *
 * 記述は、マークの直前の1文（表の行・タイル・年表の項目なら、その全体）。
 * シートの statement タブで「この記述は、並んだ主張だけで言えることを書いているか」を
 * 確かめるための行になる。記述IDは index.html の data-st と app.js の fc(…, "d-…") で固定してある。
 *
 * 必要なもの: Node.js と Playwright（npm i playwright、または同梱のブラウザ）。
 * サイトの文面やマークを変えたら実行し直し、sync_claims.py build でシートの取り込み用ファイルを作る。
 */
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS = join(ROOT, "docs");
const OUT = join(ROOT, "data", "statements.csv");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = createServer(async (req, res) => {
  let path = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  if (path.endsWith("/")) path += "index.html";
  try {
    const body = await readFile(join(DOCS, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(500);

const rows = await page.evaluate(() => {
  // 折りたたみの中も innerText で読めるように開いておく
  document.querySelectorAll("details").forEach((d) => (d.open = true));
  const clean = (s) => s.replace(/\s*\n\s*/g, "").replace(/\s+/g, " ").trim();
  // マークの直前の1文。表の行・タイル・年表の項目は、その全体を1つの記述とする
  function statementText(sup) {
    const whole = sup.closest(".tile, tr, ol.tl > li");
    if (whole) {
      // 見た目どおりに区切るため、マークと出典表記を隠して innerText を読む
      const hide = Array.from(whole.querySelectorAll("sup.fc, .tl-src"));
      hide.forEach((e) => (e.style.display = "none"));
      const t = whole.innerText.split(/[\t\n]+/).map((x) => x.trim()).filter(Boolean).join(" ");
      hide.forEach((e) => (e.style.display = ""));
      return t;
    }
    const block = sup.closest("p, li, dd, td, h2, h3, div");
    const c = block.cloneNode(true);
    const marks = Array.from(block.querySelectorAll("sup.fc"));
    const idx = marks.indexOf(sup);
    Array.from(c.querySelectorAll("sup.fc")).forEach((e, i) => e.replaceWith(`\u0001${i}\u0001`));
    const text = c.textContent;
    const end = text.indexOf(`\u0001${idx}\u0001`);
    const prev = idx > 0 ? text.indexOf(`\u0001${idx - 1}\u0001`) + `\u0001${idx - 1}\u0001`.length : 0;
    let seg = clean(text.slice(prev, end).replace(/\u0001\d+\u0001/g, ""));
    // 直前の句点までを捨て、最後の1文（マークが文の途中なら、文頭からマークまで）を残す
    const body = seg.endsWith("。") ? seg.slice(0, -1) : seg;
    const cut = body.lastIndexOf("。");
    return (cut >= 0 ? seg.slice(cut + 1) : seg).replace(/^[\s、。]+/, "");
  }
  function heading(sup) {
    const box = sup.closest("details, .fact, .sheet, .tile, .srcbox");
    const h = box && box.querySelector(":scope > summary, :scope > h3, :scope > h4, :scope > .label");
    return h ? clean(h.textContent) : "";
  }
  return Array.from(document.querySelectorAll("sup.fc")).map((sup) => {
    const sec = sup.closest("section, footer");
    const h2 = sec && sec.querySelector("h2");
    return {
      statement_id: sup.getAttribute("data-st") || "",
      section: h2 ? clean(h2.textContent) : "",
      heading: heading(sup),
      text: statementText(sup),
      claim_ids: (sup.getAttribute("data-claim") || "").trim(),
    };
  });
});
await browser.close();
server.close();

const missing = rows.filter((r) => !r.statement_id);
const seen = new Map();
rows.forEach((r) => seen.set(r.statement_id, (seen.get(r.statement_id) || 0) + 1));
const dup = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
if (missing.length || dup.length) {
  console.error("記述IDのないマーク:", missing.length, " 重複したID:", dup.join(", "));
  process.exit(1);
}
const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const cols = ["statement_id", "section", "heading", "text", "claim_ids"];
const csv = [cols.join(",")].concat(rows.map((r) => cols.map((k) => esc(r[k])).join(","))).join("\n") + "\n";
await writeFile(OUT, csv, "utf8");
console.log(`${OUT} を書き出した（${rows.length} 件）。`);
