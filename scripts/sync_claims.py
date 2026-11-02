#!/usr/bin/env python3
"""主張の台帳（claim タブ）とリポジトリの間を往復させる。

    python scripts/sync_claims.py status         # シートの進捗を表示（氏名は伏せる）
    python scripts/sync_claims.py build          # 取り込み用CSV（claim タブ・source タブ）を作る
    python scripts/sync_claims.py export-status  # 確認済みかどうかを data/claim_status.csv に書く

なぜ2か所に分かれているか
--------------------------
台帳には2種類の情報が混ざっている。

  定義   claim_id / section / kind / claim / source_id / source_text / source_url / derived_from
         … サイトの記述と対になるもの。サイトを直す人（Claude を含む）が書く。
         1行は「1つの主張と1つの出典」。kind が「計算」の行は出典を持たず、
         derived_from に材料の主張を並べる（その計算が合っているかを確かめる）。
  検証   checked / checked_by / checked_on / memo
         … ボランティアが書き込むもの。checked_by は個人名。

個人名を公開リポジトリに置きたくないので、**定義だけ** data/claims.csv に持ち、
検証の記入はシート側にだけ置く。build は両者を突き合わせて、
ボランティアの記入を保ったまま定義を最新にしたCSVを書き出す。

例外として、サイトに「人が確認済み」のマークを出すために、checked と checked_on
だけは export-status で data/claim_status.csv に写す。氏名（checked_by）とメモは写さない。

シートは「リンクを知っている全員が閲覧可」であればよい（書き込み権限は不要）。
"""

from __future__ import annotations

import csv
import io
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLAIMS = ROOT / "data" / "claims.csv"
SOURCES = ROOT / "data" / "sources.csv"
OUT = ROOT / "build" / "claim-import.csv"
OUT_SOURCES = ROOT / "build" / "source-import.csv"
STATUS = ROOT / "data" / "claim_status.csv"

SHEET_ID = "1apK7BnjQYV4SzgDQ38D3_I10LEsSVJYcshWpsQdL1YQ"
TAB = "claim"                                   # 単数。シート側のタブ名と一致させる
GVIZ = ("https://docs.google.com/spreadsheets/d/{id}"
        "/gviz/tq?tqx=out:csv&sheet={tab}")

DEFINITION = ["claim_id", "section", "kind", "claim", "source_id", "source_title",
              "source_text", "source_url", "derived_from"]
VERIFICATION = ["checked", "checked_by", "checked_on", "memo"]
ALL = DEFINITION + VERIFICATION


def fetch_sheet() -> list[dict]:
    url = GVIZ.format(id=SHEET_ID, tab=TAB)
    with urllib.request.urlopen(url, timeout=60) as r:
        body = r.read().decode("utf-8")
    if not body.lstrip().startswith('"claim_id"'):
        sys.exit(f"claim タブを読めなかった。タブ名（{TAB}）と共有設定を確認する。")
    return list(csv.DictReader(io.StringIO(body)))


def read_sources() -> list[dict]:
    with open(SOURCES, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def read_definitions() -> list[dict]:
    """claims.csv に、シートで見やすいよう出典名（source_title）を添えて返す。"""
    titles = {s["source_id"]: s["title"] for s in read_sources()}
    with open(CLAIMS, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r["source_title"] = titles.get(r.get("source_id", ""), "")
    return rows


def merge(sheet: dict[str, dict], defs: list[dict]) -> list[dict]:
    """定義を最新にし、検証列（ボランティアの記入）はシートのものを保つ。"""
    out = []
    for d in defs:
        row = {k: d.get(k, "") for k in DEFINITION}
        prev = sheet.get(d["claim_id"]) or {}
        for k in VERIFICATION:
            row[k] = prev.get(k, "")
        out.append(row)
    return out


def write_source_tab(defs: list[dict]) -> None:
    """出典ごとに、その資料で確かめる主張を並べた source タブ用のCSV。"""
    by: dict[str, list[str]] = {}
    for d in defs:
        if d.get("source_id"):
            by.setdefault(d["source_id"], []).append(d["claim_id"])
    with open(OUT_SOURCES, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["source_id", "title", "url", "claim_count", "claim_ids"])
        for s in read_sources():
            ids = by.get(s["source_id"], [])
            w.writerow([s["source_id"], s["title"], s["url"], len(ids), " ".join(ids)])


def cmd_status() -> None:
    sheet = fetch_sheet()
    defs = read_definitions()
    d_ids = {r["claim_id"] for r in defs}
    s_ids = {r["claim_id"] for r in sheet}

    checked = [r for r in sheet if r["checked"].strip().upper() == "TRUE"]
    memos = [r for r in sheet if r["memo"].strip()]
    no_url = [r for r in defs if r.get("kind", "事実") == "事実" and not r["source_url"].strip()]

    print(f"シート {len(sheet)} 件 / リポジトリ {len(defs)} 件")
    print(f"確認済み {len(checked)} 件（{len(checked) / max(1, len(sheet)) * 100:.0f}%）")
    print(f"出典URL未特定 {len(no_url)} 件: {', '.join(r['claim_id'] for r in no_url)}")

    if s_ids - d_ids:
        print(f"\nシートにだけある: {', '.join(sorted(s_ids - d_ids))}")
    if d_ids - s_ids:
        print(f"リポジトリにだけある（未取り込み）: {', '.join(sorted(d_ids - s_ids))}")

    if memos:
        print(f"\nmemo の記入 {len(memos)} 件:")
        for r in memos:
            print(f"  [{r['claim_id']}] {r['memo'][:70]}")
    # checked_by は表示しない（このスクリプトの出力がログに残るため）


def cmd_build() -> None:
    sheet = {r["claim_id"]: r for r in fetch_sheet()}
    defs = read_definitions()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    rows = merge(sheet, defs)
    kept = sum(r["checked"].strip().upper() == "TRUE" for r in rows)
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=ALL, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    write_source_tab(defs)

    dropped = set(sheet) - {d["claim_id"] for d in defs}
    print(f"{OUT} を書き出した（{len(defs)} 件、うち確認済み {kept} 件を保持）。")
    print(f"{OUT_SOURCES} を書き出した（出典 {len(read_sources())} 件）。")
    if dropped:
        print(f"※ シートにあってリポジトリに無い {len(dropped)} 件は落ちる: "
              f"{', '.join(sorted(dropped))}")
    print("\nスプレッドシートで claim タブの全セルを選択して削除し、")
    print("A1 を選んで「ファイル → インポート → アップロード」からこのCSVを、")
    print("「現在のシートを置換する」で取り込む。")


def normalize_date(text: str) -> str:
    """シートの日付（2026/11/02、2026-11-02 0:00:00 など）を YYYY-MM-DD にする。"""
    m = re.search(r"(\d{4})\D(\d{1,2})\D(\d{1,2})", text or "")
    return f"{m[1]}-{int(m[2]):02d}-{int(m[3]):02d}" if m else ""


def cmd_export_status() -> None:
    sheet = {r["claim_id"].strip(): r for r in fetch_sheet()}
    defs = read_definitions()
    checked = 0
    with open(STATUS, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["claim_id", "checked", "checked_on"])
        for d in defs:
            r = sheet.get(d["claim_id"], {})
            ok = r.get("checked", "").strip().upper() == "TRUE"
            checked += ok
            w.writerow([d["claim_id"], "TRUE" if ok else "FALSE",
                        normalize_date(r.get("checked_on", "")) if ok else ""])
    print(f"{STATUS} を書き出した（{len(defs)} 件、うち確認済み {checked} 件）。")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "status":
        cmd_status()
    elif cmd == "build":
        cmd_build()
    elif cmd == "export-status":
        cmd_export_status()
    else:
        sys.exit(__doc__)
