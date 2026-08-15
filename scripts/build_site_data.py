#!/usr/bin/env python3
"""data/*.csv と data/meta.json を結合し docs/data/data.json を生成する。

派生指標（1戸当たり飼養数、人口当たり頭数など）はここで計算する。
標準ライブラリのみで動く。

    python scripts/build_site_data.py
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT = ROOT / "docs" / "data" / "data.json"


def read_csv(name: str) -> dict[int, dict[str, float]]:
    rows: dict[int, dict[str, float]] = {}
    with open(DATA_DIR / name, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            year = int(r.pop("year"))
            rows[year] = {k: float(v) for k, v in r.items() if v not in ("", None)}
    return rows


def series(table: dict[int, dict[str, float]], column: str) -> list[list[float]]:
    """[[year, value], ...] 形式（年昇順、欠測年は含めない）。"""
    return [[y, table[y][column]] for y in sorted(table) if column in table[y]]


def ratio_series(
    num: dict[int, dict[str, float]], num_col: str,
    den: dict[int, dict[str, float]], den_col: str,
    scale: float = 1.0,
) -> list[list[float]]:
    out = []
    for y in sorted(num):
        if num_col in num.get(y, {}) and den_col in den.get(y, {}) and den[y][den_col]:
            out.append([y, num[y][num_col] * scale / den[y][den_col]])
    return out


def read_fte() -> dict[str, dict[int, dict[str, float]]]:
    """species -> {year: {labor_hours, headcount, fte, per_fte}}。

    FTE（フルタイム換算）= 自営農業労働時間 ÷ 2,080時間（週40時間×52週）。
    """
    path = DATA_DIR / "fte.csv"
    out: dict[str, dict[int, dict[str, float]]] = {}
    if not path.exists():
        return out
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            hours = float(r["labor_hours"])
            headcount = float(r["headcount"])
            fte = hours / 2080
            out.setdefault(r["species"], {})[int(r["year"])] = {
                "labor_hours": hours,
                "headcount": headcount,
                "fte": fte,
                "per_fte": headcount / fte,
            }
    return out


def read_cagefree() -> dict[str, list[dict]]:
    """ケージフリー（非ケージ）飼育の推計値と、その飼養形態別内訳。

    政府統計にはケージフリーの系列が存在しないため、民間・大学の調査に
    よる推計を出典ごとにそのまま並べて持つ（どれか1つに寄せない）。
    scope は national（全国推計）か sample（調査回答内の比率）。
    """
    out: dict[str, list[dict]] = {"estimates": [], "types": []}

    est_path = DATA_DIR / "cagefree.csv"
    if est_path.exists():
        with open(est_path, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                rec = {
                    "source": r["source"],
                    "year": int(r["year"]),
                    "scope": r["scope"],
                    "share": float(r["share_pct"]),
                    "note": r.get("note", ""),
                }
                if r.get("cagefree_birds"):
                    rec["birds"] = int(r["cagefree_birds"])
                if r.get("total_birds"):
                    rec["total"] = int(r["total_birds"])
                out["estimates"].append(rec)
        out["estimates"].sort(key=lambda e: (e["source"], e["year"]))

    type_path = DATA_DIR / "cagefree_types.csv"
    if type_path.exists():
        with open(type_path, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                out["types"].append({
                    "source": r["source"],
                    "year": int(r["year"]),
                    "type": r["type"],
                    "birds": int(r["birds"]),
                    "farms": int(r["farms"]) if r.get("farms") else None,
                })
        out["types"].sort(key=lambda t: -t["birds"])

    return out


def total_series(table: dict[int, dict[str, float]]) -> list[list[float]]:
    """犬猫殺処分の合計系列。total 列があればそれを、無ければ dogs+cats を使う。"""
    out = []
    for y in sorted(table):
        row = table[y]
        if "total" in row:
            out.append([y, row["total"]])
        elif "dogs" in row or "cats" in row:
            out.append([y, row.get("dogs", 0) + row.get("cats", 0)])
    return out


def main() -> None:
    livestock = read_csv("livestock.csv")
    slaughter = read_csv("slaughter.csv")
    population = read_csv("population.csv")
    euthanasia = read_csv("euthanasia.csv")
    meta = json.loads((DATA_DIR / "meta.json").read_text(encoding="utf-8"))

    data = {
        "meta": meta,
        # 飼養数（千羽・千頭・千人）
        "inventory": {
            "layers": series(livestock, "layers_thousand"),
            "broilers": series(livestock, "broilers_thousand"),
            "pigs": series(livestock, "pigs_thousand"),
            "sows": series(livestock, "sows_thousand"),
            "population": series(population, "population_thousand"),
        },
        # 年間屠殺数（千羽・千頭）
        "slaughter": {
            "broilers": series(slaughter, "broilers_slaughtered_thousand"),
            "layers_culled": series(slaughter, "layers_culled_thousand"),
            "pigs": series(slaughter, "pigs_slaughtered_thousand"),
        },
        # 犬猫の殺処分数（実数・頭）— 環境省。合計と、判明している年の犬・猫内訳
        "euthanasia": {
            "total": total_series(euthanasia),
            "dogs": series(euthanasia, "dogs"),
            "cats": series(euthanasia, "cats"),
        },
        # 1戸（経営体）当たり飼養数（羽・頭）
        "per_farm": {
            "layers": ratio_series(livestock, "layers_thousand", livestock, "layer_farms", 1000),
            "broilers": ratio_series(livestock, "broilers_thousand", livestock, "broiler_farms", 1000),
            "pigs": ratio_series(livestock, "pigs_thousand", livestock, "pig_farms", 1000),
        },
        # 飼養戸数
        "farms": {
            "layers": series(livestock, "layer_farms"),
            "broilers": series(livestock, "broiler_farms"),
            "pigs": series(livestock, "pig_farms"),
        },
        # 労働力（FTE）当たり飼養頭数・羽数 — 農業経営統計調査「営農類型別経営統計」
        "fte": read_fte(),
        # ケージフリー（非ケージ）飼育の割合 — 政府統計に系列がないため民間・大学の推計
        "cagefree": read_cagefree(),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    n = sum(len(v) for group in data.values() if isinstance(group, dict)
            for v in group.values() if isinstance(v, list))
    print(f"docs/data/data.json を生成しました（{n} データ点）")


if __name__ == "__main__":
    main()
