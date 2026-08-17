#!/usr/bin/env python3
"""主張の台帳（claim タブ）とリポジトリの間を往復させる。

    python scripts/sync_claims.py status   # シートの進捗を表示（氏名は伏せる）
    python scripts/sync_claims.py build    # 取り込み用CSVを作る

なぜ2か所に分かれているか
--------------------------
台帳には2種類の情報が混ざっている。

  定義   claim_id / section / claim / source_text / source_url
         … サイトの記述と対になるもの。サイトを直す人（Claude を含む）が書く。
  検証   checked / checked_by / checked_on / memo
         … ボランティアが書き込むもの。checked_by は個人名。

個人名を公開リポジトリに置きたくないので、**定義だけ** data/claims.csv に持ち、
検証の記入はシート側にだけ置く。build は両者を突き合わせて、
ボランティアの記入を保ったまま定義を最新にしたCSVを書き出す。

シートは「リンクを知っている全員が閲覧可」であればよい（書き込み権限は不要）。
"""

from __future__ import annotations

import csv
import io
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLAIMS = ROOT / "data" / "claims.csv"
OUT = ROOT / "build" / "claim-import.csv"

SHEET_ID = "1apK7BnjQYV4SzgDQ38D3_I10LEsSVJYcshWpsQdL1YQ"
TAB = "claim"                                   # 単数。シート側のタブ名と一致させる
GVIZ = ("https://docs.google.com/spreadsheets/d/{id}"
        "/gviz/tq?tqx=out:csv&sheet={tab}")

DEFINITION = ["claim_id", "section", "claim", "source_text", "source_url"]
VERIFICATION = ["checked", "checked_by", "checked_on", "memo"]
ALL = DEFINITION + VERIFICATION


def fetch_sheet() -> list[dict]:
    url = GVIZ.format(id=SHEET_ID, tab=TAB)
    with urllib.request.urlopen(url, timeout=60) as r:
        body = r.read().decode("utf-8")
    if not body.lstrip().startswith('"claim_id"'):
        sys.exit(f"claim タブを読めなかった。タブ名（{TAB}）と共有設定を確認する。")
    return list(csv.DictReader(io.StringIO(body)))


def read_definitions() -> list[dict]:
    with open(CLAIMS, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def cmd_status() -> None:
    sheet = fetch_sheet()
    defs = read_definitions()
    d_ids = {r["claim_id"] for r in defs}
    s_ids = {r["claim_id"] for r in sheet}

    checked = [r for r in sheet if r["checked"].strip().upper() == "TRUE"]
    memos = [r for r in sheet if r["memo"].strip()]
    no_url = [r for r in defs if not r["source_url"].strip()]

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
    kept = 0
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=ALL, lineterminator="\n")
        w.writeheader()
        for d in defs:
            row = {k: d.get(k, "") for k in DEFINITION}
            prev = sheet.get(d["claim_id"])
            for k in VERIFICATION:
                row[k] = prev.get(k, "") if prev else ""
            if prev and prev.get("checked", "").strip().upper() == "TRUE":
                kept += 1
            w.writerow(row)

    dropped = set(sheet) - {d["claim_id"] for d in defs}
    print(f"{OUT} を書き出した（{len(defs)} 件、うち確認済み {kept} 件を保持）。")
    if dropped:
        print(f"※ シートにあってリポジトリに無い {len(dropped)} 件は落ちる: "
              f"{', '.join(sorted(dropped))}")
    print("\nスプレッドシートで claim タブの全セルを選択して削除し、")
    print("A1 を選んで「ファイル → インポート → アップロード」からこのCSVを、")
    print("「現在のシートを置換する」で取り込む。")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "status":
        cmd_status()
    elif cmd == "build":
        cmd_build()
    else:
        sys.exit(__doc__)
