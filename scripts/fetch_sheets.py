#!/usr/bin/env python3
"""Googleスプレッドシートの各タブを data/*.csv に取り込む。

    python scripts/fetch_sheets.py            # config/sheets.toml の設定で取り込む
    python scripts/fetch_sheets.py --check    # 取り込まず、差分の有無だけを表示する

シートは「リンクを知っている全員が閲覧可」にしておけば、認証情報なしで
CSVとして取り出せる。書き込みはしないので、鍵は不要。

壊れたデータをそのまま公開しないよう、書き出す前に次を検査する:

- 列名が config/sheets.toml の `[columns]` と一致すること（順序も）
- 行が1行以上あること
- 既存CSVより行数が半分以下に減っていないこと（タブの消し間違いを検知）

1つでも引っかかったタブがあれば、**どのタブも書き出さずに** 異常終了する。
一部だけ更新されて整合が崩れた状態を作らないため。
"""

from __future__ import annotations

import argparse
import csv
import io
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import tomllib  # Python 3.11+（fetch_estat.py と同じ前提）

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CONFIG = ROOT / "config" / "sheets.toml"

# 「1,234」「1,234.5」のように桁区切りが入った数値だけをほどく。
# 日本語の読点（、）や本文中のカンマには触れない。
NUMERIC_WITH_COMMAS = re.compile(r"^-?\d{1,3}(,\d{3})+(\.\d+)?$")


def csv_url(spreadsheet_id: str, tab: str) -> str:
    return (
        f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/gviz/tq"
        f"?tqx=out:csv&sheet={urllib.parse.quote(tab)}"
    )


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "e-stat-animal-welfare/1.0"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read().decode("utf-8")


def clean(value: str) -> str:
    v = (value or "").strip()
    if NUMERIC_WITH_COMMAS.match(v):
        v = v.replace(",", "")
    return v


def parse(text: str) -> list[list[str]]:
    rows = [[clean(c) for c in row] for row in csv.reader(io.StringIO(text))]
    # 末尾の空行と、全セルが空の行を落とす
    return [r for r in rows if any(c for c in r)]


def existing_row_count(path: Path) -> int:
    if not path.exists():
        return 0
    with open(path, newline="", encoding="utf-8") as f:
        return max(0, sum(1 for _ in f) - 1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="書き出さずに差分だけ表示する")
    args = ap.parse_args()

    if not CONFIG.exists():
        print(f"設定ファイルがありません: {CONFIG}", file=sys.stderr)
        return 1
    cfg = tomllib.loads(CONFIG.read_text(encoding="utf-8"))

    sid = (cfg.get("sheet") or {}).get("spreadsheet_id", "").strip()
    if not sid:
        print(
            "config/sheets.toml の spreadsheet_id が空です。\n"
            "スプレッドシートの共有URLの /d/ と /edit の間の文字列を設定してください。",
            file=sys.stderr,
        )
        return 1

    tabs: dict[str, str] = cfg.get("tabs", {})
    columns: dict[str, list[str]] = cfg.get("columns", {})

    staged: dict[Path, list[list[str]]] = {}
    problems: list[str] = []

    for tab, filename in tabs.items():
        out = DATA_DIR / filename
        try:
            rows = parse(fetch(csv_url(sid, tab)))
        except urllib.error.HTTPError as e:
            problems.append(
                f"[{tab}] 取得できません（HTTP {e.code}）。"
                "タブ名が違うか、シートが『リンクを知っている全員が閲覧可』になっていない可能性があります。"
            )
            continue
        except Exception as e:  # ネットワーク断など
            problems.append(f"[{tab}] 取得に失敗: {e}")
            continue

        if not rows:
            problems.append(f"[{tab}] 中身が空です")
            continue

        expected = columns.get(tab)
        if expected and rows[0] != expected:
            problems.append(
                f"[{tab}] 1行目の見出しが想定と違います。\n"
                f"      期待: {expected}\n"
                f"      実際: {rows[0]}\n"
                "      見出しの文字や並び順を元に戻してください。"
            )
            continue

        body = rows[1:]
        if not body:
            problems.append(f"[{tab}] データ行が1行もありません")
            continue

        before = existing_row_count(out)
        if before and len(body) < before / 2:
            problems.append(
                f"[{tab}] 行数が {before} → {len(body)} と半分以下に減っています。"
                "意図した削除であれば data/ のCSVを直接編集してから取り込み直してください。"
            )
            continue

        staged[out] = rows
        mark = "=" if before == len(body) else f"{before}→{len(body)}"
        print(f"  {tab:18s} {filename:24s} {len(body):4d}行 ({mark})")

    if problems:
        print("\n取り込みを中止しました。次の問題を直してください:\n", file=sys.stderr)
        for p in problems:
            print("  - " + p, file=sys.stderr)
        return 1

    if args.check:
        changed = []
        for path, rows in staged.items():
            buf = io.StringIO()
            csv.writer(buf, lineterminator="\n").writerows(rows)
            old = path.read_text(encoding="utf-8") if path.exists() else ""
            if buf.getvalue() != old:
                changed.append(path.name)
        print("\n変更あり: " + (", ".join(changed) if changed else "なし"))
        return 0

    for path, rows in staged.items():
        with open(path, "w", newline="", encoding="utf-8") as f:
            csv.writer(f, lineterminator="\n").writerows(rows)

    print(f"\n{len(staged)} 個のCSVを更新しました。")
    print("続けて python scripts/build_site_data.py を実行してください。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
