# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0,<2", "pyyaml>=6.0"]
# ///
"""Parquet + dataset.yaml から D1 投入用の SQLite と、Worker に同梱する
データセット定義 JSON を生成する。

    uv run --script tools/build_sqlite.py \
        --dataset build/upstream/datasets/procedures-survey-r6

生成物:
    build/apm.db                 D1 へ import する SQLite
    src/generated/dataset.json   DSD + コードリスト + 事前計算した品質統計

品質統計を実行時ではなくここで計算するのは、inspect_dataset が
D1 を叩かずに応答できるようにするため。
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

import polars as pl
import yaml

# multi_value フィールドの区切り文字。上流 (query.py explode_records) と揃える。
MULTI_VALUE_SEP = ";"

# 集計対象になりうる列にだけインデックスを張る。attr は自由記述が多く、
# 張っても効かないうえ書き込み行数を増やすので対象外。
INDEXED_ROLES = {"dim"}


def load_dataset(dataset_dir: Path) -> tuple[dict, pl.DataFrame]:
    ds = yaml.safe_load((dataset_dir / "dataset.yaml").read_text(encoding="utf-8"))
    df = pl.read_parquet(dataset_dir / ds["data_file"])
    return ds, df


def sql_type(field: dict) -> str:
    if field["role"] == "measure":
        return "INTEGER" if field.get("data_type") == "integer" else "REAL"
    return "TEXT"


def build_main_table(con: sqlite3.Connection, ds: dict, df: pl.DataFrame) -> None:
    id_field = ds["id_field"]
    cols = ", ".join(
        f'"{f["name"]}" {sql_type(f)}'
        + (" PRIMARY KEY" if f["name"] == id_field else "")
        for f in ds["fields"]
    )
    con.execute(f"CREATE TABLE procedures ({cols})")

    names = [f["name"] for f in ds["fields"]]
    placeholders = ", ".join("?" * len(names))
    quoted = ", ".join(f'"{n}"' for n in names)
    con.executemany(
        f"INSERT INTO procedures ({quoted}) VALUES ({placeholders})",
        df.select(names).iter_rows(),
    )
    print(f"  procedures: {len(df):,} 行 x {len(names)} 列")


def build_values_table(con: sqlite3.Connection, ds: dict, df: pl.DataFrame) -> None:
    """multi_value 列を (field_id, value, id) に正規化する。

    explode と、multi_value 列に対する IN 一致を実行時の文字列分割なしで
    解決するためのテーブル。

    field は日本語の列名をそのまま持つと 49 万行ぶん繰り返されて肥大するため、
    fields 配列の添字を整数で持つ。WITHOUT ROWID にしているのは、PK
    (field_id, value, id) 自身が検索に使う唯一の索引であり、通常のテーブル
    だと本体・PK 索引・検索用索引で同じ内容を 3 重に持つことになるため。
    """
    id_field = ds["id_field"]
    con.execute(
        """
        CREATE TABLE procedure_values (
            field_id INTEGER NOT NULL,
            value    TEXT NOT NULL,
            id       TEXT NOT NULL,
            PRIMARY KEY (field_id, value, id)
        ) WITHOUT ROWID
        """
    )

    total = 0
    for idx, f in enumerate(ds["fields"]):
        if not f.get("multi_value"):
            continue
        name = f["name"]
        exploded = (
            df.select([pl.col(id_field).alias("id"), pl.col(name).alias("value")])
            .with_columns(
                pl.col("value").cast(pl.Utf8).fill_null("").str.split(MULTI_VALUE_SEP)
            )
            .explode("value")
            .with_columns(pl.col("value").str.strip_chars())
            .filter(pl.col("value") != "")
            .unique()
        )
        rows = [(idx, v, i) for i, v in exploded.iter_rows()]
        con.executemany(
            "INSERT OR IGNORE INTO procedure_values (field_id, value, id) VALUES (?, ?, ?)",
            rows,
        )
        total += len(rows)
        print(f"    [{idx:2d}] {name}: {len(rows):,}")
    print(f"  procedure_values: {total:,} 行")


def create_indexes(con: sqlite3.Connection, ds: dict) -> None:
    made = 0
    for i, f in enumerate(ds["fields"]):
        if f["role"] not in INDEXED_ROLES or f.get("multi_value"):
            continue
        con.execute(f'CREATE INDEX idx_proc_{i:02d} ON procedures("{f["name"]}")')
        made += 1
    print(f"  インデックス: {made} 本")


def field_stats(df: pl.DataFrame, field: dict) -> dict:
    """inspect_dataset が返す品質情報を事前計算する。"""
    name = field["name"]
    s = df[name]
    n = len(s)
    stat = {
        "null_count": s.null_count(),
        "null_ratio": round(s.null_count() / n, 4) if n else 0.0,
        "distinct_count": s.n_unique(),
    }
    if field["role"] == "measure":
        stat |= {
            "min": s.min(),
            "max": s.max(),
            "sum": s.sum(),
        }
    elif field.get("codelist") == "auto" or field["role"] == "dim":
        # コードリストが auto の列は実データから頻度上位を出す
        top = (
            df.select(pl.col(name))
            .drop_nulls()
            .group_by(name)
            .len()
            .sort("len", descending=True)
            .head(30)
        )
        stat["top_values"] = [{"value": v, "count": c} for v, c in top.iter_rows()]
    return stat


def build_definition(ds: dict, df: pl.DataFrame) -> dict:
    fields = []
    for idx, f in enumerate(ds["fields"]):
        entry = {k: v for k, v in f.items() if k != "csv_col_index"}
        # procedure_values.field_id と対応させる。並び順に依存させないよう明示する。
        entry["field_id"] = idx
        entry["sql_type"] = sql_type(f)
        entry["stats"] = field_stats(df, f)
        fields.append(entry)
    return {
        "schema_version": ds["schema_version"],
        "title": ds["title"],
        "publisher": ds["publisher"],
        "id_field": ds["id_field"],
        "published_at": str(ds["published_at"]),
        "source_url": ds["source"]["url"],
        "computed_measures": ds.get("computed_measures", []),
        "generic_values": ds.get("generic_values", []),
        "multi_value_separator": MULTI_VALUE_SEP,
        "record_count": len(df),
        "fields": fields,
    }


def sql_literal(v: object) -> str:
    """SQLite の文字列リテラルに変換する。

    改行は生のまま埋め込む。SQLite の文字列リテラルは改行をそのまま含められ、
    wrangler の文分割もクォートを認識するため問題ない。sqlite3 の .dump は
    改行を含む値を unistr('...\\u000a...') で出力するが、D1 の SQLite には
    unistr() が無く投入時に落ちるので、.dump は使わずここで生成する。
    """
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def write_dump(con: sqlite3.Connection, path: Path, batch: int = 500) -> None:
    """D1 の `wrangler d1 execute --file` に渡す SQL を生成する。"""
    schema = [
        r[0]
        for r in con.execute(
            "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL "
            "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END"
        )
    ]
    tables = [
        r[0]
        for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    ]

    rows_total = 0
    with path.open("w", encoding="utf-8") as out:
        for stmt in schema:
            out.write(stmt.rstrip().rstrip(";") + ";\n")
        for table in tables:
            cols = [r[1] for r in con.execute(f"PRAGMA table_info({table})")]
            quoted = ", ".join(f'"{c}"' for c in cols)
            pending: list[str] = []

            def flush() -> None:
                if pending:
                    out.write(
                        f"INSERT INTO {table} ({quoted}) VALUES\n"
                        + ",\n".join(pending)
                        + ";\n"
                    )
                    pending.clear()

            for row in con.execute(f"SELECT {quoted} FROM {table}"):
                pending.append("(" + ", ".join(sql_literal(v) for v in row) + ")")
                rows_total += 1
                if len(pending) >= batch:
                    flush()
            flush()
    size = path.stat().st_size / 1024 / 1024
    print(f"  → {path} ({size:.1f} MB, {rows_total:,} 行)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, required=True, help="dataset.yaml のあるディレクトリ")
    ap.add_argument("--db", type=Path, default=Path("build/apm.db"))
    ap.add_argument("--dump", type=Path, default=Path("build/dump.sql"))
    ap.add_argument("--definition", type=Path, default=Path("src/generated/dataset.json"))
    args = ap.parse_args()

    ds, df = load_dataset(args.dataset)
    print(f"[load] {ds['title']}: {len(df):,} 件 x {len(ds['fields'])} フィールド")

    args.db.parent.mkdir(parents=True, exist_ok=True)
    args.db.unlink(missing_ok=True)
    con = sqlite3.connect(args.db)
    print("[sqlite]")
    build_main_table(con, ds, df)
    build_values_table(con, ds, df)
    create_indexes(con, ds)
    con.commit()
    con.execute("VACUUM")
    print(f"  → {args.db} ({args.db.stat().st_size / 1024 / 1024:.1f} MB)")

    print("[dump]")
    write_dump(con, args.dump)
    con.close()

    args.definition.parent.mkdir(parents=True, exist_ok=True)
    definition = build_definition(ds, df)
    args.definition.write_text(
        json.dumps(definition, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    size = args.definition.stat().st_size / 1024
    print(f"[definition] → {args.definition} ({size:.0f} KB)")


if __name__ == "__main__":
    main()
