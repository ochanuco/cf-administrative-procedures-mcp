# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""MCP エンドポイントのスモークテスト。

    uv run --script tools/smoke.py [--url http://127.0.0.1:8787/mcp]

tools/list と 4 つのツールを一通り呼び、応答の要点だけを表示する。
"""

from __future__ import annotations

import argparse
import json
import sys

import httpx

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
}


def parse_body(res: httpx.Response) -> dict:
    """JSON と SSE のどちらで返ってきても JSON-RPC 本体を取り出す。"""
    text = res.text
    if text.lstrip().startswith("{"):
        return json.loads(text)
    for line in text.splitlines():
        if line.startswith("data:"):
            return json.loads(line[5:].strip())
    raise ValueError(f"応答を解釈できません: {text[:400]}")


class Client:
    def __init__(self, url: str) -> None:
        self.url = url
        self.http = httpx.Client(timeout=60)
        self.n = 0

    def rpc(self, method: str, params: dict | None = None) -> dict:
        self.n += 1
        payload = {"jsonrpc": "2.0", "id": self.n, "method": method}
        if params is not None:
            payload["params"] = params
        res = self.http.post(self.url, headers=HEADERS, json=payload)
        if res.status_code >= 400:
            raise RuntimeError(f"HTTP {res.status_code}: {res.text[:400]}")
        return parse_body(res)

    def call(self, tool: str, args: dict) -> dict:
        body = self.rpc("tools/call", {"name": tool, "arguments": args})
        if "error" in body:
            raise RuntimeError(f"{tool}: {body['error']}")
        content = body["result"]["content"][0]["text"]
        return json.loads(content)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8787/mcp")
    args = ap.parse_args()
    c = Client(args.url)
    failures = 0

    def check(label: str, fn) -> None:
        nonlocal failures
        try:
            out = fn()
            print(f"✅ {label}\n   {out}")
        except Exception as e:  # スモークなので落とさず続行する
            failures += 1
            print(f"❌ {label}\n   {type(e).__name__}: {e}")

    c.rpc(
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "smoke", "version": "0"},
        },
    )

    check(
        "tools/list",
        lambda: sorted(t["name"] for t in c.rpc("tools/list")["result"]["tools"]),
    )

    check(
        "list_datasets",
        lambda: c.call("list_datasets", {})["datasets"][0]["record_count"],
    )

    def inspect() -> str:
        r = c.call("inspect_dataset", {})
        f = next(x for x in r["fields"] if x["name"] == "所管府省庁")
        return f"{len(r['fields'])} フィールド / 所管府省庁 の上位: {f['stats']['top_values'][0]}"

    check("inspect_dataset", inspect)

    def q_basic() -> str:
        r = c.call("query_records", {
            "select": ["手続ID", "所管府省庁", "手続名"],
            "where": {"所管府省庁": ["国土交通省"], "手続名": "届出"},
            "limit": 3,
        })
        return f"count={r['count']} has_more={r['has_more']} 先頭={r['records'][0]['手続名']}"

    check("query_records (配列=IN + 文字列=部分一致)", q_basic)

    def q_range() -> str:
        r = c.call("query_records", {
            "select": ["手続名", "総手続件数"],
            "where": {"総手続件数": {"$gte": 1000000}},
            "order_by": "-総手続件数",
            "limit": 3,
        })
        return f"count={r['count']} 最大={r['records'][0]}"

    check("query_records ($gte + order_by 降順)", q_range)

    def q_cursor() -> str:
        p1 = c.call("query_records", {"select": ["手続ID"], "limit": 2})
        p2 = c.call("query_records", {"select": ["手続ID"], "limit": 2, "cursor": p1["next_cursor"]})
        ids1 = [r["手続ID"] for r in p1["records"]]
        ids2 = [r["手続ID"] for r in p2["records"]]
        assert not set(ids1) & set(ids2), "ページが重複している"
        return f"page1={ids1} page2={ids2}"

    check("query_records (カーソルページネーション)", q_cursor)

    def q_fulltext() -> str:
        r = c.call("query_records", {"q": "マイナンバー", "select": ["手続名"], "limit": 2})
        return f"count={r['count']} 例={r['records'][0]['手続名'] if r['records'] else None}"

    check("query_records (全文検索 q)", q_fulltext)

    def q_notempty() -> str:
        r = c.call("query_records", {
            "select": ["手続名", "経由機関"],
            "where": {"経由機関": {"$not_empty": True}},
            "limit": 2,
        })
        return f"count={r['count']} 例={r['records'][0]['経由機関'] if r['records'] else None}"

    check("query_records ($not_empty)", q_notempty)

    def s_group() -> str:
        r = c.call("summarize_records", {
            "group_by": ["所管府省庁"],
            "metrics": ["count", "avg:オンライン率", "sum:総手続件数"],
            "limit": 3,
        })
        return f"groups={r['group_count']} 先頭={r['groups'][0]}"

    check("summarize_records (group_by + 算出数値項目)", s_group)

    def s_having() -> str:
        r = c.call("summarize_records", {
            "group_by": ["手続類型"],
            "metrics": ["count"],
            "having": {"count": {"$gte": 10000}},
        })
        return f"groups={r['group_count']} {[g['手続類型'] for g in r['groups']]}"

    check("summarize_records (having)", s_having)

    def s_explode() -> str:
        r = c.call("summarize_records", {
            "explode": "手続が行われるイベント(法人)",
            "metrics": ["count"],
            "limit": 3,
        })
        return f"groups={r['group_count']} 先頭={r['groups'][0]}"

    check("summarize_records (explode)", s_explode)

    def s_crosstab() -> str:
        r = c.call("summarize_records", {
            "group_by": ["手続主体", "オンライン化の実施状況"],
            "metrics": ["count"],
            "limit": 3,
        })
        return f"groups={r['group_count']} 先頭={r['groups'][0]}"

    check("summarize_records (クロス集計)", s_crosstab)

    def err_unknown_field() -> str:
        r = c.call("query_records", {"where": {"存在しない列": "x"}})
        assert "error" in r, f"エラーが返らなかった: {r}"
        return r["error"]

    check("不明フィールドがエラーになる", err_unknown_field)

    def resolved() -> str:
        r = c.call("query_records", {"select": [" 所管府省庁 "], "limit": 1})
        assert r.get("resolved_fields"), "resolved_fields が返っていない"
        return str(r["resolved_fields"])

    check("フィールド名の補正 (resolved_fields)", resolved)

    print(f"\n{'失敗 ' + str(failures) + ' 件' if failures else '全て成功'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
