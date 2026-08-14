# cf-administrative-procedures-mcp

デジタル庁の[行政手続等の棚卸調査結果](https://www.digital.go.jp/resources/procedures-survey-results)を検索・集計するリモート MCP サーバー。Cloudflare Workers + D1 で動く。

[digital-go-jp/administrative-procedures-mcp](https://github.com/digital-go-jp/administrative-procedures-mcp)（Python / polars / stdio）の非公式派生。デジタル庁とは無関係。

## なぜ移植するのか

上流は polars（Rust ネイティブ拡張）に依存しており、Workers では動かない。Python Workers が受け付けるのは PyEmscripten wheel か Pyodide 同梱パッケージのみで、polars は PyPI に emscripten wheel を出していない。

一方で上流の MCP ツール契約は完全に SQL の形をしている。

```
query_records(dataset_id, q, search_fields, select, where, order_by, limit, cursor)
  → SELECT {select} FROM t WHERE {where} AND {q} ORDER BY {order_by} LIMIT {limit}

summarize_records(dataset_id, metrics, group_by, where, having, explode, limit)
  → SELECT {group_by}, {agg} FROM t WHERE {where} GROUP BY {group_by} HAVING {having}
```

`where` の演算子は7種のみ（文字列=部分一致 / 配列=IN / `$gte` / `$lte` / `$ne` / `$not_contains` / `$not_empty`）。polars を D1 に置き換えれば素直に成立する。

## 構成

```
[ローカル / CI]                                   [Cloudflare]

XLSX (14.7MB, 75,071行 x 38列)
  └ prepare_dataset.py ── 上流の Python をそのまま使用
      └ data.parquet
          └ polars + sqlite3
              └ dump.sql ──wrangler d1 import──→ D1
                                                  ↑
                                         Hono + createMcpHandler
                                         (ステートレス, Durable Objects 不要)
```

XLSX のヘッダ2行処理や表記ゆれ吸収という一番泥臭い部分は、上流の Python 資産をビルド側で使い回す。TypeScript で新規に書くのは Worker 側だけ。

## 設計判断

**全文検索に FTS5 を使わない。** 上流は `str.contains(..., literal=True)` の部分一致でしかなく、FTS5 のデフォルトトークナイザ（unicode61）は日本語を分かち書きできない。`LIKE '%...%'` にすれば上流と挙動が一致する。75,071行の全走査は D1 の Paid 枠（25B rows read/月）に対して月33万クエリ相当で、実用上問題にならない。

**`inspect_dataset` の品質統計は事前計算する。** null 率・ユニーク数などはビルド時に算出して meta テーブルへ入れ、実行時ロジックを持たない。

**`explode`（multi_value 展開）は ingest 時に解決する。** `手続ID x 値` の正規化テーブルを作り、実行時は JOIN で済ませる。

**Durable Objects を使わない。** Agents SDK の `createMcpHandler` がステートレスな Streamable HTTP に対応したため、読み取り専用のこのサーバーには DO が要らない。バインディングは D1 ひとつ。

## ステータス

設計フェーズ。実装はこれから。

## ライセンス

MIT。上流および同梱データの帰属は [NOTICE](NOTICE) を参照。
