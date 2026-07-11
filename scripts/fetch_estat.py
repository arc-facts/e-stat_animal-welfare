#!/usr/bin/env python3
"""e-Stat API から畜産・人口の時系列を取得し data/*.csv を更新する。

使い方:
    ESTAT_APP_ID=xxxx python scripts/fetch_estat.py            # 全系列を更新
    ESTAT_APP_ID=xxxx python scripts/fetch_estat.py --discover # 統計表の候補を表示
    ESTAT_APP_ID=xxxx python scripts/fetch_estat.py --only pigs_thousand

e-Stat API の利用登録（無料）: https://www.e-stat.go.jp/api/
取得対象の統計表・系列は config/tables.toml で定義する。

方針: 取得できた系列だけ CSV に反映し、失敗した系列は既存値（シードデータ）
を残す。1系列でも失敗があれば終了コード 1（CI で気付けるように）。
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import tomllib
from datetime import datetime, timezone
from pathlib import Path

from pyestat import EstatClient, EstatError

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CONFIG = ROOT / "config" / "tables.toml"

YEAR_RE = re.compile(r"(19|20)\d{2}")

# e-Stat の単位表記 → 目標単位（千羽・千頭・千人・戸）への換算係数
UNIT_SCALE = {
    ("羽", "千羽"): 0.001,
    ("千羽", "千羽"): 1,
    ("百羽", "千羽"): 0.1,
    ("万羽", "千羽"): 10,
    ("頭", "千頭"): 0.001,
    ("千頭", "千頭"): 1,
    ("万頭", "千頭"): 10,
    ("人", "千人"): 0.001,
    ("千人", "千人"): 1,
    ("万人", "千人"): 10,
    ("戸", "戸"): 1,
    ("千戸", "戸"): 1000,
}


def load_config() -> dict:
    with open(CONFIG, "rb") as f:
        return tomllib.load(f)


def row_label_text(flat_row: dict) -> str:
    """行の全ラベル・コードを連結した検索用文字列。"""
    parts = []
    for key, val in flat_row.items():
        if key in ("value", "unit"):
            continue
        parts.append(str(val))
    return " ".join(parts)


def extract_year(flat_row: dict) -> int | None:
    """time 軸のフィールドから西暦年を取り出す。"""
    for key, val in flat_row.items():
        if "time" in key.lower() or "時間" in str(key):
            m = YEAR_RE.search(str(val))
            if m:
                return int(m.group(0))
    # time というキーが無いテーブルでは全フィールドから探す
    m = YEAR_RE.search(row_label_text(flat_row))
    return int(m.group(0)) if m else None


def to_number(raw: object) -> float | None:
    """e-Stat の値文字列を数値化。秘匿記号（- *** X）は None。"""
    s = str(raw).replace(",", "").strip()
    if not s or s in {"-", "…", "***", "X", "x"}:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def scale_value(value: float, unit_label: str, target_unit: str) -> float | None:
    unit_label = unit_label.strip()
    factor = UNIT_SCALE.get((unit_label, target_unit))
    if factor is None:
        # 単位表記が「千羽」など目標単位そのものならそのまま
        if unit_label == target_unit:
            factor = 1
        else:
            return None
    return value * factor


def discover_table(client: EstatClient, spec: dict, name: str) -> str | None:
    """getStatsList で統計表を検索し、title_regex に合う最初の表IDを返す。"""
    search = spec.get("search", {})
    if not search:
        return None
    resp = client.list_stats(**search, limit=100)
    pattern = re.compile(spec.get("title_regex", ""))
    for table in resp.tables:
        title = table.get("TITLE")
        if isinstance(title, dict):
            title = title.get("$", "")
        title = str(title)
        stat_name = str(table.get("STATISTICS_NAME", ""))
        if pattern.search(title) or pattern.search(stat_name):
            table_id = str(table.get("@id", ""))
            print(f"  [{name}] 発見: {table_id} — {stat_name} / {title}")
            return table_id
    print(f"  [{name}] title_regex に合う表が見つかりません（候補 {len(resp.tables)} 件）")
    return None


def fetch_series(client: EstatClient, name: str, spec: dict) -> dict[int, float]:
    table_id = spec.get("stats_data_id") or discover_table(client, spec, name)
    if not table_id:
        raise EstatError(f"{name}: 統計表IDを特定できません。--discover で候補を確認してください。")

    resp = client.get_stats_data(table_id)
    rows = resp.to_flat()

    match = spec.get("match", [])
    exclude = spec.get("exclude", [])
    target_unit = spec.get("unit", "")

    by_year: dict[int, float] = {}
    ambiguous: dict[int, list[str]] = {}
    for row in rows:
        text = row_label_text(row)
        if not all(m in text for m in match):
            continue
        if any(e in text for e in exclude):
            continue
        year = extract_year(row)
        if year is None:
            continue
        value = to_number(row.get("value"))
        if value is None:
            continue
        unit_label = str(row.get("unit", target_unit))
        scaled = scale_value(value, unit_label, target_unit)
        if scaled is None:
            raise EstatError(
                f"{name}: 未知の単位 '{unit_label}'（目標 {target_unit}）。"
                " scripts/fetch_estat.py の UNIT_SCALE に追加してください。"
            )
        if year in by_year and by_year[year] != scaled:
            ambiguous.setdefault(year, []).append(text)
            continue
        by_year[year] = scaled

    if ambiguous:
        examples = "\n    ".join(list(ambiguous.values())[0][:5])
        raise EstatError(
            f"{name}: 同じ年に複数の行がマッチしました。config/tables.toml の"
            f" match / exclude を絞り込んでください。例:\n    {examples}"
        )
    if not by_year:
        raise EstatError(f"{name}: 条件に合う行がありません（表 {table_id}、{len(rows)} 行）。")
    return by_year


def update_csv(path: Path, column: str, series: dict[int, float]) -> None:
    """既存CSVに系列をマージ（年の追加・値の上書き。他列は保持）。"""
    rows: dict[int, dict[str, str]] = {}
    fieldnames = ["year"]
    if path.exists():
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            fieldnames = list(reader.fieldnames or ["year"])
            for r in reader:
                rows[int(r["year"])] = r
    if column not in fieldnames:
        fieldnames.append(column)
    for year, value in series.items():
        row = rows.setdefault(year, {"year": str(year)})
        row[column] = format(value, ".10g")
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for year in sorted(rows):
            writer.writerow({k: rows[year].get(k, "") for k in fieldnames})


def run_discover(client: EstatClient, config: dict) -> None:
    seen = set()
    for name, spec in config["series"].items():
        key = json.dumps(spec.get("search", {}), sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        search = spec.get("search", {})
        print(f"\n=== {name}: {search} ===")
        resp = client.list_stats(**search, limit=30)
        for table in resp.tables:
            title = table.get("TITLE")
            if isinstance(title, dict):
                title = title.get("$", "")
            print(f"  {table.get('@id')}  {table.get('STATISTICS_NAME','')} / {title}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--discover", action="store_true", help="統計表の候補一覧を表示して終了")
    parser.add_argument("--only", action="append", help="指定した系列のみ更新（複数可）")
    args = parser.parse_args()

    app_id = os.environ.get("ESTAT_APP_ID", "").strip()
    if not app_id:
        print("ESTAT_APP_ID が未設定です。https://www.e-stat.go.jp/api/ で利用登録し、", file=sys.stderr)
        print("環境変数 ESTAT_APP_ID（GitHub Actions では Secrets）に設定してください。", file=sys.stderr)
        return 2

    config = load_config()
    client = EstatClient(app_id=app_id)

    if args.discover:
        run_discover(client, config)
        return 0

    failures = []
    fetched = {}
    for name, spec in config["series"].items():
        if args.only and name not in args.only:
            continue
        print(f"取得中: {name} — {spec.get('description', '')}")
        try:
            series = fetch_series(client, name, spec)
        except EstatError as e:
            print(f"  失敗: {e}", file=sys.stderr)
            failures.append(name)
            continue
        update_csv(DATA_DIR / spec["file"], name, series)
        fetched[name] = len(series)
        print(f"  OK: {len(series)} 年分")

    if fetched:
        meta_path = DATA_DIR / "meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["provisional"] = bool(failures)
        meta["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        meta["fetched_series"] = sorted(fetched)
        meta["failed_series"] = sorted(failures)
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if failures:
        print(f"\n{len(failures)} 系列が失敗: {', '.join(failures)}", file=sys.stderr)
        return 1
    print("\nすべての系列を更新しました。scripts/build_site_data.py を実行してください。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
