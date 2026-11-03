#!/usr/bin/env python3
"""主張の台帳（claim タブ）とリポジトリの間を往復させる。

    python scripts/sync_claims.py status         # シートの進捗を表示（氏名は伏せる）
    python scripts/sync_claims.py build          # 取り込み用CSV（claim・statement タブ）とxlsxを作る
    python scripts/sync_claims.py export-status  # 確認済みかどうかを data/claim_status.csv と
                                                 # data/statement_status.csv に書く

シートの2つのタブ
-----------------
  claim      1行＝1つの主張と1つの出典。「主張 → 資料名 → 確認箇所 → リンク → チェック」の順。
             ボランティアはリンクを開き、確認箇所で主張が支持されるかを確かめる。
  statement  1行＝サイト上の1つの記述（文末マーク1つ）。data/statements.csv から作る
             （scripts/extract_statements.mjs がサイトを描画して書き出す）。
             並んだ主張だけで、その記述が言えるか（言い過ぎや、主張にない数字がないか）を確かめる。

サイトのマークは、記述のチェックと、そこに並ぶ主張すべて（計算の主張は材料まで）の
チェックがそろったときだけ緑になる。

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
だけは export-status で data/claim_status.csv（主張）と data/statement_status.csv（記述）に
写す。氏名（checked_by）とメモは写さない。

主張や記述の文面が変わったら、前のチェックは新しい文面には当てはまらないので、
build はその行の checked / checked_by / checked_on を空に戻す（memo は残す）。

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
OUT_STATEMENTS = ROOT / "build" / "statement-import.csv"
OUT_XLSX = ROOT / "build" / "claim-import.xlsx"
STATUS = ROOT / "data" / "claim_status.csv"
STATEMENTS = ROOT / "data" / "statements.csv"
STATEMENT_STATUS = ROOT / "data" / "statement_status.csv"

SHEET_ID = "1apK7BnjQYV4SzgDQ38D3_I10LEsSVJYcshWpsQdL1YQ"
TAB = "claim"                                   # 単数。シート側のタブ名と一致させる
STATEMENT_TAB = "statement"
GVIZ = ("https://docs.google.com/spreadsheets/d/{id}"
        "/gviz/tq?tqx=out:csv&sheet={tab}")

DEFINITION = ["claim_id", "section", "kind", "claim", "source_id", "source_title",
              "location", "source_text", "source_url", "derived_from"]
VERIFICATION = ["checked", "checked_by", "checked_on", "memo"]
# claim タブの列の並び。確認の流れ（主張を見る→資料名→確認箇所→リンクを開く→チェック）の順で、
# 確認に使わない列は右に寄せる
CLAIM_TAB = (["claim_id", "claim", "source_title", "location", "source_url"] + VERIFICATION
             + ["kind", "derived_from", "section", "source_id", "source_text"])
# statement タブ: 記述1件につき1行。記述の文面の横に、含まれる主張の文面を並べる
STATEMENT_DEF = ["statement_id", "section", "heading", "text", "claim_ids", "claims", "check_ids"]
# claims_checked / claims_unchecked は数式の列。claim タブのチェックを読みに行くので、
# claim タブにチェックを入れると、その場で statement タブの表示も変わる
STATEMENT_TAB_COLS = (["statement_id", "text", "claims", "claims_checked", "claims_unchecked"]
                      + VERIFICATION + ["claim_ids", "check_ids", "section", "heading"])
CLAIM_ROWS = 1000                               # 数式が見る claim タブの行の範囲（2〜この行）


def fetch_tab(tab: str, key: str) -> list[dict] | None:
    """シートの1タブを読む。タブが無ければ None。

    gviz は存在しないタブ名を指定すると先頭のタブを返すので、見出しの1列目で見分ける。
    """
    url = GVIZ.format(id=SHEET_ID, tab=tab)
    with urllib.request.urlopen(url, timeout=60) as r:
        body = r.read().decode("utf-8")
    if not body.lstrip().startswith(f'"{key}"'):
        return None
    return list(csv.DictReader(io.StringIO(body)))


def fetch_sheet() -> list[dict]:
    rows = fetch_tab(TAB, "claim_id")
    if rows is None:
        sys.exit(f"claim タブを読めなかった。タブ名（{TAB}）と共有設定を確認する。")
    return rows


def fetch_statements() -> list[dict]:
    """statement タブ。まだ作っていなければ空として扱う。"""
    return fetch_tab(STATEMENT_TAB, "statement_id") or []


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


def same(a: str, b: str) -> bool:
    return " ".join((a or "").split()) == " ".join((b or "").split())


def merge(sheet: dict[str, dict], defs: list[dict], key: str, fields: list[str],
          watch: list[str]) -> tuple[list[dict], list[str]]:
    """定義を最新にし、検証列（ボランティアの記入）はシートのものを保つ。

    watch の列（主張の文面やリンク）がシートの値から変わった行は、チェックを外す。
    返り値は（行のリスト, チェックを外した行のID）。
    """
    out, reset = [], []
    for d in defs:
        row = {k: d.get(k, "") for k in fields}
        prev = sheet.get(d[key]) or {}
        for k in VERIFICATION:
            row[k] = prev.get(k, "")
        # シートにまだ無い列（新しく足した列）は比べない
        changed = prev and any(k in prev and not same(prev[k], d.get(k, "")) for k in watch)
        if changed and any(row[k].strip() and row[k].strip().upper() != "FALSE"
                           for k in ("checked", "checked_by", "checked_on")):
            row.update(checked="FALSE", checked_by="", checked_on="")
            reset.append(d[key])
        out.append(row)
    return out, reset


def claim_rows(defs: list[dict]) -> list[dict]:
    """claim タブ用に、出典の無い行の資料名を埋める。"""
    rows = []
    for d in defs:
        d = dict(d)
        if d.get("kind") == "計算":
            d["source_title"] = "本サイトの計算"
        elif d.get("kind") == "方法":
            d["source_title"] = "本サイトの推計方法"
        elif not d.get("source_url"):
            d["source_title"] = "出典未特定"
        rows.append(d)
    return rows


def expand_ids(ids: list[str], derived: dict[str, list[str]]) -> list[str]:
    """計算の主張を、材料の主張までたどって並べる（サイトの判定と同じ範囲）。"""
    out: list[str] = []
    def walk(lst: list[str]) -> None:
        for i in lst:
            if i in out:
                continue
            out.append(i)
            walk(derived.get(i, []))
    walk(ids)
    return out


def col_letter(cols: list[str], name: str) -> str:
    n, s = cols.index(name) + 1, ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def statement_formulas(row: int, xlsx: bool) -> dict[str, str]:
    """statement タブの1行分の数式。claim タブの checked を見て、主張の確認状況を出す。

    Google スプレッドシートは xlsx から取り込むと BYROW や SPLIT を解釈できない（#NAME?）ので、
    どちらの形式でも通る関数だけで書く。check_ids は空白区切りなので、前後に空白を足して探す。
    xlsx では配列数式として書き、CSV では ARRAYFORMULA で包む。
    """
    ids = f"${col_letter(STATEMENT_TAB_COLS, 'check_ids')}{row}"
    cid = f"claim!${col_letter(CLAIM_TAB, 'claim_id')}$2:${col_letter(CLAIM_TAB, 'claim_id')}${CLAIM_ROWS}"
    chk = f"claim!${col_letter(CLAIM_TAB, 'checked')}$2:${col_letter(CLAIM_TAB, 'checked')}${CLAIM_ROWS}"
    hit = f'ISNUMBER(SEARCH(" "&{cid}&" "," "&{ids}&" "))'
    ok = f"SUMPRODUCT(({chk}=TRUE)*{hit})"
    n = f'(LEN(TRIM({ids}))-LEN(SUBSTITUTE(TRIM({ids})," ",""))+1)'
    checked = (f'=IF({ids}="","主張なし",IF({ok}={n},"すべて確認済み（"&{n}&"件）",'
               f'{ok}&"/"&{n}&" 確認済み"))')
    join = "_xlfn.TEXTJOIN" if xlsx else "TEXTJOIN"
    inner = f'{join}(" ",TRUE,IF(({chk}<>TRUE)*{hit},{cid},""))'
    unchecked = f'=IF({ids}="","",{inner})' if xlsx else f'=IF({ids}="","",ARRAYFORMULA({inner}))'
    return {"claims_checked": checked, "claims_unchecked": unchecked}


def read_statements(defs: list[dict]) -> list[dict]:
    """data/statements.csv に、含まれる主張の文面（claims 列）と、材料まで広げた ID（check_ids）を添えて返す。"""
    if not STATEMENTS.exists():
        sys.exit(f"{STATEMENTS} が無い。node scripts/extract_statements.mjs で作る。")
    text = {d["claim_id"]: d["claim"] for d in defs}
    derived = {d["claim_id"]: (d.get("derived_from") or "").split() for d in defs}
    with open(STATEMENTS, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        ids = r["claim_ids"].split()
        r["claims"] = "\n".join(f"{i}: {text.get(i, '（台帳に無い）')}" for i in ids) or "（主張なし）"
        r["check_ids"] = " ".join(expand_ids(ids, derived))
    return rows


def write_csv(path: Path, cols: list[str], rows: list[dict]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, lineterminator="\n", extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


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

    st = fetch_statements()
    if st:
        st_ok = sum(r["checked"].strip().upper() == "TRUE" for r in st)
        print(f"\n記述 {len(st)} 件、うち確認済み {st_ok} 件")
        for r in st:
            if r.get("memo", "").strip():
                print(f"  [{r['statement_id']}] {r['memo'][:70]}")
    else:
        print("\nstatement タブはまだ無い。")
    # checked_by は表示しない（このスクリプトの出力がログに残るため）


def cmd_build() -> None:
    sheet = {r["claim_id"]: r for r in fetch_sheet()}
    st_sheet = {r["statement_id"]: r for r in fetch_statements()}
    defs = read_definitions()
    stmts = read_statements(defs)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    rows, reset = merge(sheet, claim_rows(defs), "claim_id", CLAIM_TAB,
                        watch=["claim", "location", "source_url", "derived_from"])
    st_rows, st_reset = merge(st_sheet, stmts, "statement_id", STATEMENT_TAB_COLS,
                              watch=["text", "claim_ids"])
    write_csv(OUT, CLAIM_TAB, rows)
    write_csv(OUT_STATEMENTS, STATEMENT_TAB_COLS,
              [{**r, **statement_formulas(i, xlsx=False)} for i, r in enumerate(st_rows, start=2)])

    # Google Sheets はCSVのインポートを「現在、このファイルをインポートできません」と
    # 弾くことがある（内容に問題がなくても出る）。xlsx は同じ内容でも通るので、常に両方作る。
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font
        from openpyxl.worksheet.formula import ArrayFormula
        wb = Workbook()
        wb.remove(wb.active)
        widths = {"claim": 46, "text": 46, "claims": 46, "source_title": 28, "location": 28,
                  "source_url": 24, "memo": 24, "source_text": 40,
                  "claims_checked": 18, "claims_unchecked": 18}
        for title, cols, data in (("claim", CLAIM_TAB, rows), ("statement", STATEMENT_TAB_COLS, st_rows)):
            ws = wb.create_sheet(title)
            ws.append(cols)
            for i, r in enumerate(data, start=2):
                ws.append([(r[k].strip().upper() == "TRUE") if k == "checked" else r.get(k, "")
                           for k in cols])
                if title == "statement":
                    f = statement_formulas(i, xlsx=True)
                    ws[f"{col_letter(cols, 'claims_checked')}{i}"] = f["claims_checked"]
                    ref = f"{col_letter(cols, 'claims_unchecked')}{i}"
                    ws[ref] = ArrayFormula(ref, f["claims_unchecked"])
            for j, k in enumerate(cols, start=1):
                ws.cell(row=1, column=j).font = Font(bold=True)
                ws.column_dimensions[ws.cell(row=1, column=j).column_letter].width = widths.get(k, 12)
                if k in ("claim", "text", "claims", "location"):
                    for i in range(2, len(data) + 2):
                        ws.cell(row=i, column=j).alignment = Alignment(wrap_text=True, vertical="top")
            ws.freeze_panes = "B2"
        wb.save(OUT_XLSX)
        xlsx_note = f"{OUT_XLSX} も書き出した（claim・statement の2タブ。CSVが弾かれたときはこちらを使う）。"
    except ImportError:
        xlsx_note = "openpyxl が無いため xlsx は作っていない（pip install openpyxl）。"

    kept = sum(r["checked"].strip().upper() == "TRUE" for r in rows)
    st_kept = sum(r["checked"].strip().upper() == "TRUE" for r in st_rows)
    print(f"{OUT} を書き出した（{len(rows)} 件、うち確認済み {kept} 件を保持）。")
    print(f"{OUT_STATEMENTS} を書き出した（{len(st_rows)} 件、うち確認済み {st_kept} 件を保持）。")
    print(xlsx_note)
    if reset:
        print(f"※ 文面やリンクが変わったためチェックを外した主張: {', '.join(reset)}")
    if st_reset:
        print(f"※ 文面や主張が変わったためチェックを外した記述: {', '.join(st_reset)}")
    for name, old, new in (("主張", sheet, rows), ("記述", st_sheet, st_rows)):
        key = "claim_id" if name == "主張" else "statement_id"
        dropped = set(old) - {r[key] for r in new}
        if dropped:
            print(f"※ シートにあってリポジトリに無い{name} {len(dropped)} 件は落ちる: "
                  f"{', '.join(sorted(dropped))}")
    print("\nスプレッドシートで claim・statement の各タブの全セルを選択して削除し、")
    print("A1 を選んで「ファイル → インポート → アップロード」から対応するCSVを、")
    print("「現在のシートを置換する」で取り込む（statement タブが無ければ「新しいシートを挿入」）。")


def normalize_date(text: str) -> str:
    """シートの日付（2026/11/02、2026-11-02 0:00:00 など）を YYYY-MM-DD にする。"""
    m = re.search(r"(\d{4})\D(\d{1,2})\D(\d{1,2})", text or "")
    return f"{m[1]}-{int(m[2]):02d}-{int(m[3]):02d}" if m else ""


def write_status(path: Path, key: str, ids: list[str], sheet: dict[str, dict]) -> int:
    checked = 0
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow([key, "checked", "checked_on"])
        for i in ids:
            r = sheet.get(i, {})
            ok = r.get("checked", "").strip().upper() == "TRUE"
            checked += ok
            w.writerow([i, "TRUE" if ok else "FALSE",
                        normalize_date(r.get("checked_on", "")) if ok else ""])
    return checked


def cmd_export_status() -> None:
    sheet = {r["claim_id"].strip(): r for r in fetch_sheet()}
    defs = read_definitions()
    n = write_status(STATUS, "claim_id", [d["claim_id"] for d in defs], sheet)
    print(f"{STATUS} を書き出した（{len(defs)} 件、うち確認済み {n} 件）。")

    st_sheet = {r["statement_id"].strip(): r for r in fetch_statements()}
    with open(STATEMENTS, encoding="utf-8") as f:
        ids = [r["statement_id"] for r in csv.DictReader(f)]
    n = write_status(STATEMENT_STATUS, "statement_id", ids, st_sheet)
    note = "" if st_sheet else "（statement タブはまだ無いので、すべて未確認）"
    print(f"{STATEMENT_STATUS} を書き出した（{len(ids)} 件、うち確認済み {n} 件）{note}。")


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
