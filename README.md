# データで見る日本のアニマルウェルフェア — e-Stat Animal Welfare

採卵鶏・ブロイラー（肉用鶏）・豚（特に母豚）について、

- 飼養数（採卵鶏は**種鶏を除く**成鶏めす羽数）
- 年間の屠殺数（ブロイラー・廃鶏の処理羽数、豚のと畜頭数）
- 1戸（経営体）当たりの飼養数 = 集約化の指標
- 日本の総人口（対比用）

の時系列グラフを生成し、GitHub Pages で公開するプロジェクトです。
いかに多くの畜産動物が集約的に飼育されているかを一目で伝え、
国内のアニマルウェルフェア関連の情報提供に役立てることを目的としています。

データはすべて政府統計の総合窓口 [e-Stat](https://www.e-stat.go.jp/) で
公開されている公的統計（畜産統計調査・畜産物流通調査・人口推計）です。
e-Stat API へのアクセスには [pyestat](https://github.com/khaym/pyestat)
（PyPI: `pyestat`）を使用しています。

## 構成

```
data/                  元データ CSV（暫定シード値。API 取得で上書きされる）
config/tables.toml     取得する e-Stat 統計表と系列の定義
scripts/fetch_estat.py     e-Stat API から data/*.csv を更新
scripts/build_site_data.py data/*.csv → docs/data/data.json
docs/                  静的サイト（GitHub Pages で公開する本体）
.github/workflows/
  pages.yml            main への push で GitHub Pages にデプロイ
  update-data.yml      毎月 e-Stat からデータを再取得してコミット
```

## 公開までの手順

1. **GitHub Pages を有効化**: リポジトリの Settings → Pages → Source を
   「GitHub Actions」にする。main ブランチに push すると
   `pages.yml` がサイトをデプロイします。
   公開 URL: `https://arc-facts.github.io/e-stat_animal-welfare/`
2. **（推奨）e-Stat API キーを設定**: [e-Stat API 利用登録](https://www.e-stat.go.jp/api/)
   （無料）で appId を取得し、Settings → Secrets and variables → Actions に
   `ESTAT_APP_ID` という名前で登録する。
   以後 `update-data.yml`（毎月 / 手動実行も可）が確定値を取得して
   グラフを自動更新します。キー未設定の間は、公表資料から整理した
   暫定シードデータでサイトが表示されます（ページ上部に注記が出ます）。

## ローカルでの実行

```bash
pip install -r requirements.txt

# e-Stat API からデータ取得（要 API キー）
ESTAT_APP_ID=あなたのappId python scripts/fetch_estat.py
# 統計表IDの候補を探す場合
ESTAT_APP_ID=あなたのappId python scripts/fetch_estat.py --discover

# サイト用 JSON を生成してプレビュー
python scripts/build_site_data.py
python -m http.server -d docs 8000   # → http://localhost:8000
```

## データと注記

- 各系列の定義・出典・確認済みアンカー値は [`data/README.md`](data/README.md) を参照。
- 「1従業員当たりの頭数」は、畜産統計に従業員数の系列が存在しないため
  「1戸（経営体）当たりの飼養数」で代替しています。
- 「飼育密度」（面積当たり頭羽数）も全国統計が存在しないため、サイトでは
  飼養実態調査等で知られる飼育方式の実態（ケージ飼育率・妊娠ストール使用率
  など）を参考情報として掲載しています。
- ブロイラーの統計は2011年に調査対象基準が変わっており、それ以前の年次とは
  単純比較できません。

## ライセンス・出典表示

出典: 農林水産省「畜産統計調査」「畜産物流通調査」、総務省統計局「人口推計」
（いずれも e-Stat で公開）。利用にあたっては各統計の利用規約に従ってください。
