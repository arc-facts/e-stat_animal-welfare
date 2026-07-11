#!/usr/bin/env python3
"""労働力（FTE）当たり飼養頭数・羽数を e-Stat から取得し data/fte.csv を更新する。

農業経営統計調査「営農類型別経営統計」から、酪農・肉用牛（肥育牛）・養豚・
採卵養鶏・ブロイラー養鶏の各経営について
  - 自営農業労働時間（全国平均、経営全体）
  - 月平均飼養頭数・羽数（全国平均）
を取得する。FTE（フルタイム換算）は 自営農業労働時間 ÷ 2,080時間（週40時間×52週）。

この調査は畜産統計調査と違って「長期累年」表が存在せず、年ごとに別表IDが
発行される。個別経営（家族経営・法人を含む個々の経営体）の全国表は
令和元年（2019）以降、酪農・肉用牛・養豚・採卵養鶏・ブロイラー養鶏の
5経営類型が「全農業経営体」として1つの表にまとまったが、それ以前は
経営類型ごとに別表だった。本スクリプトが比較する2つの年は、
--discover 相当の手動調査で実際に確認できた組み合わせ:
  - 平成22年（2010）: 営農類型別経営統計（個別経営）、経営類型ごとの表
  - 令和4年（2022）: 営農類型別経営統計、全農業経営体、確報（統合表）

使い方:
    ESTAT_APP_ID=xxxx python scripts/fetch_fte.py
"""

from __future__ import annotations

import csv
import os
import sys
from pathlib import Path

from pyestat import EstatClient, EstatError

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "fte.csv"

LABOR_HOURS_ITEM_2010 = (
    "農業及び農業生産関連事業労働時間_(全体)_自営農業及び農業生産関連事業労働時間計_自営農業労働"
)

# species key -> (2010個別経営 労働時間表, 2010個別経営 頭数・羽数表, 頭数・羽数の項目名)
SPECIES_2010 = {
    "dairy": ("0003072609", "0003072668", "主要農畜産物の生産概況_作付（飼養）規模_搾乳牛月平均飼養頭数"),
    "beef": ("0003072688", "0003073158", "主要農畜産物の生産概況_作付（飼養）規模_肥育牛月平均飼養頭数"),
    "pig": ("0003072691", "0003072750", "主要農畜産物の生産概況_作付（飼養）規模_肥育豚月平均飼養頭数"),
    "layer": ("0003072694", "0003072753", "主要農畜産物の生産概況_作付（飼養）規模_採卵鶏月平均飼養羽数"),
    "broiler": ("0003072697", "0003072756", "主要農畜産物の生産概況_ブロイラー販売羽数"),
}

TABLE_2022 = "0002111939"

# species key -> (2022表でのカテゴリ名, 頭数・羽数の項目名)
SPECIES_2022 = {
    "dairy": ("酪農経営_全国_平均", "月平均搾乳牛飼養頭数"),
    "beef": ("肥育牛経営_全国_平均", "月平均肥育牛飼養頭数"),
    "pig": ("養豚経営_全国_平均", "月平均肥育豚飼養頭数"),
    "layer": ("採卵養鶏経営_全国_平均", "月平均採卵鶏飼養羽数"),
    "broiler": ("ブロイラー養鶏経営_全国_平均", "ブロイラー販売羽数"),
}
LABOR_HOURS_ITEM_2022 = "自営農業労働時間"

SPECIES_NAME = {
    "dairy": "酪農",
    "beef": "肉用牛（肥育牛）",
    "pig": "養豚",
    "layer": "採卵養鶏",
    "broiler": "ブロイラー養鶏",
}


def to_number(raw: object) -> float | None:
    s = str(raw).replace(",", "").strip()
    if not s or s in {"-", "…", "***", "X", "x", "－"}:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def fetch_2010(client: EstatClient, species: str) -> tuple[float | None, float | None]:
    labor_table, count_table, count_item = SPECIES_2010[species]

    labor_rows = client.get_stats_data(labor_table).to_flat()
    labor_hours = None
    for row in labor_rows:
        if (
            row.get("cat01_label") == LABOR_HOURS_ITEM_2010
            and row.get("cat02_label") == "計"
            and row.get("cat03_label") == "平均"
        ):
            labor_hours = to_number(row.get("value"))
            break

    count_rows = client.get_stats_data(count_table).to_flat()
    headcount = None
    for row in count_rows:
        if row.get("cat01_label") == count_item and row.get("cat02_label") == "平均":
            headcount = to_number(row.get("value"))
            break

    return labor_hours, headcount


def fetch_2022(client: EstatClient, species: str) -> tuple[float | None, float | None]:
    category, count_item = SPECIES_2022[species]
    rows = client.get_stats_data(TABLE_2022).to_flat()

    labor_hours = None
    headcount = None
    for row in rows:
        if row.get("cat01_label") != category:
            continue
        if row.get("cat02_label") == LABOR_HOURS_ITEM_2022 and labor_hours is None:
            labor_hours = to_number(row.get("value"))
        elif row.get("cat02_label") == count_item and headcount is None:
            headcount = to_number(row.get("value"))

    return labor_hours, headcount


def main() -> int:
    app_id = os.environ.get("ESTAT_APP_ID", "").strip()
    if not app_id:
        print("ESTAT_APP_ID が未設定です。", file=sys.stderr)
        return 2

    client = EstatClient(app_id=app_id)
    rows: list[dict[str, str]] = []
    failures: list[str] = []

    for species in SPECIES_2010:
        for year, fetch in ((2010, fetch_2010), (2022, fetch_2022)):
            print(f"取得中: {SPECIES_NAME[species]} {year}年")
            try:
                labor_hours, headcount = fetch(client, species)
            except EstatError as e:
                print(f"  失敗: {e}", file=sys.stderr)
                failures.append(f"{species}-{year}")
                continue
            if labor_hours is None or headcount is None:
                print(
                    f"  失敗: 労働時間={labor_hours} 頭数・羽数={headcount}"
                    " （項目が見つからないか秘匿値）",
                    file=sys.stderr,
                )
                failures.append(f"{species}-{year}")
                continue
            print(f"  OK: 労働時間={labor_hours:.0f}時間 頭数・羽数={headcount:.1f}")
            rows.append(
                {
                    "species": species,
                    "year": str(year),
                    "labor_hours": format(labor_hours, ".10g"),
                    "headcount": format(headcount, ".10g"),
                }
            )

    rows.sort(key=lambda r: (r["species"], r["year"]))
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["species", "year", "labor_hours", "headcount"])
        writer.writeheader()
        writer.writerows(rows)

    if failures:
        print(f"\n{len(failures)} 系列が失敗: {', '.join(failures)}", file=sys.stderr)
        return 1
    print(f"\ndata/fte.csv を更新しました（{len(rows)} 行）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
