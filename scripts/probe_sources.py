#!/usr/bin/env python3
"""【一時的な調査用】claims.csv の出典URLを取得し、中身を probe/ に書き出す。

- e-Stat のファイル一覧ページ: 全ページを辿って statInfId と表題を列挙
- PDF: ページごとのテキスト
- HTML: そのまま
- 引数 --files statInfId... : e-Stat のファイルを落としてセルの中身をテキスト化
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlencode, urlparse, parse_qsl, urlunparse

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "probe"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"}


def key(url: str) -> str:
    return hashlib.sha1(url.encode()).hexdigest()[:10]


def get(url: str) -> requests.Response | None:
    try:
        r = requests.get(url, headers=UA, timeout=60, allow_redirects=True)
        return r
    except Exception as e:
        print(f"  ERR {url}: {e}")
        return None


def with_page(url: str, page: int) -> str:
    p = urlparse(url)
    q = [(k, v) for k, v in parse_qsl(p.query) if k != "page"] + [("page", str(page))]
    return urlunparse(p._replace(query=urlencode(q)))


def estat_list(url: str, log: list) -> None:
    seen: dict[str, str] = {}
    for page in range(1, 40):
        r = get(with_page(url, page))
        if r is None:
            break
        html = r.content.decode("utf-8", errors="replace")
        if page == 1:
            (OUT / "estat" / f"{key(url)}_p1.html").write_text(html, encoding="utf-8")
        ids = re.findall(r"statInfId=(\d{12})", html) + re.findall(r"stat_infid=(\d{12})", html)
        new = [i for i in dict.fromkeys(ids) if i not in seen]
        if not new:
            break
        for sid in new:
            # 表題は statInfId の直前にあるテキストのことが多い。前後を素のテキストにして残す
            m = re.search(r"(?:statInfId|stat_infid)=" + sid, html)
            chunk = html[max(0, m.start() - 4000): m.start() + 600]
            text = re.sub(r"<[^>]+>", " ", chunk)
            text = re.sub(r"\s+", " ", text)
            seen[sid] = text[-1200:]
        (OUT / "estat" / f"{key(url)}_p{page}.html").write_text(html, encoding="utf-8")
    log.append({"url": url, "kind": "estat_list", "count": len(seen)})
    with open(OUT / "estat" / f"{key(url)}_entries.txt", "w", encoding="utf-8") as f:
        f.write(url + "\n\n")
        for sid, ctx in seen.items():
            f.write(f"=== {sid}\n{ctx}\n\n")


def save_doc(url: str, log: list) -> None:
    r = get(url)
    if r is None:
        log.append({"url": url, "status": "error"})
        return
    ctype = r.headers.get("content-type", "")
    entry = {"url": url, "final": r.url, "status": r.status_code, "ctype": ctype, "bytes": len(r.content), "key": key(url)}
    if "pdf" in ctype or r.content[:4] == b"%PDF":
        from pypdf import PdfReader
        try:
            reader = PdfReader(io.BytesIO(r.content))
            with open(OUT / "docs" / f"{key(url)}.txt", "w", encoding="utf-8") as f:
                f.write(url + "\n")
                for i, pg in enumerate(reader.pages, 1):
                    f.write(f"\n\n===== PAGE {i} =====\n")
                    f.write(pg.extract_text() or "")
            entry["pages"] = len(reader.pages)
        except Exception as e:
            entry["pdf_error"] = str(e)
    else:
        (OUT / "docs" / f"{key(url)}.html").write_text(r.content.decode(r.apparent_encoding or "utf-8", errors="replace"), encoding="utf-8")
    log.append(entry)


def estat_file(stat_inf_id: str, log: list) -> None:
    """e-Stat のファイルを落とし、全シートのセルをタブ区切りテキストにする。"""
    url = f"https://www.e-stat.go.jp/stat-search/file-download?statInfId={stat_inf_id}&fileKind=0"
    r = get(url)
    if r is None:
        return
    entry = {"statInfId": stat_inf_id, "status": r.status_code, "ctype": r.headers.get("content-type", ""),
             "disp": r.headers.get("content-disposition", ""), "bytes": len(r.content)}
    lines = []
    data = r.content
    try:
        if data[:4] == b"PK\x03\x04":
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)
            for ws in wb.worksheets:
                lines.append(f"##### SHEET {ws.title}")
                for row in ws.iter_rows(values_only=True):
                    if any(c is not None for c in row):
                        lines.append("\t".join("" if c is None else str(c) for c in row))
        elif data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
            import xlrd
            wb = xlrd.open_workbook(file_contents=data)
            for sh in wb.sheets():
                lines.append(f"##### SHEET {sh.name}")
                for i in range(sh.nrows):
                    row = sh.row_values(i)
                    if any(str(c).strip() for c in row):
                        lines.append("\t".join(str(c) for c in row))
        else:
            lines.append(data[:20000].decode("utf-8", errors="replace"))
    except Exception as e:
        entry["error"] = str(e)
    (OUT / "files" / f"{stat_inf_id}.txt").write_text("\n".join(lines), encoding="utf-8")
    # 一覧ページ上の単独表示URLも確認する
    r2 = get(f"https://www.e-stat.go.jp/stat-search/files?stat_infid={stat_inf_id}")
    if r2 is not None:
        entry["single_page_status"] = r2.status_code
        entry["single_page_hits"] = len(set(re.findall(r"statInfId=(\d{12})", r2.text)))
        (OUT / "files" / f"{stat_inf_id}_page.html").write_text(r2.text, encoding="utf-8")
    log.append(entry)


def main() -> None:
    for d in ("estat", "docs", "files"):
        (OUT / d).mkdir(parents=True, exist_ok=True)
    log: list = []
    args = sys.argv[1:]
    if args and args[0] == "--files":
        for sid in args[1:]:
            estat_file(sid, log)
            time.sleep(1)
        (OUT / "files_log.json").write_text(json.dumps(log, ensure_ascii=False, indent=1), encoding="utf-8")
        return
    if args and args[0] == "--api":
        import os
        (OUT / "api").mkdir(exist_ok=True)
        for sid in args[1:]:
            r = requests.get("https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData",
                             params={"appId": os.environ.get("ESTAT_APP_ID", ""), "statsDataId": sid}, timeout=120)
            # 応答には要求パラメータが含まれうるので、表題・分類・値だけを取り出して保存する
            d = r.json().get("GET_STATS_DATA", {}).get("STATISTICAL_DATA", {})
            keep = {"TABLE_INF": d.get("TABLE_INF"), "CLASS_INF": d.get("CLASS_INF"),
                    "VALUE": (d.get("DATA_INF") or {}).get("VALUE")}
            (OUT / "api" / f"{sid}.json").write_text(json.dumps(keep, ensure_ascii=False), encoding="utf-8")
        return
    if args and args[0] == "--docs":
        for url in args[1:]:
            save_doc(url, log)
            r = get(url)
            if r is not None and "html" in r.headers.get("content-type", ""):
                html = r.content.decode("utf-8", errors="replace")
                pdfs = list(dict.fromkeys(re.findall(r'href="([^"]+\.pdf)"', html)))[:8]
                for u in pdfs:
                    save_doc(requests.compat.urljoin(r.url, u), log)
        (OUT / f"docs_log_{key(' '.join(args))}.json").write_text(json.dumps(log, ensure_ascii=False, indent=1), encoding="utf-8")
        return
    if args and args[0] == "--lists":
        for url in args[1:]:
            estat_list(url, log)
        (OUT / "lists_log.json").write_text(json.dumps(log, ensure_ascii=False, indent=1), encoding="utf-8")
        return

    with open(ROOT / "data" / "claims.csv", encoding="utf-8") as f:
        urls = list(dict.fromkeys(r["source_url"].strip() for r in csv.DictReader(f) if r["source_url"].strip()))
    for url in urls:
        print(url)
        if "e-stat.go.jp/stat-search/files" in url:
            estat_list(url, log)
        else:
            save_doc(url, log)
        time.sleep(1)
    (OUT / "log.json").write_text(json.dumps(log, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
