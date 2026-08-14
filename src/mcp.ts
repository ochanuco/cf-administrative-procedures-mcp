/**
 * MCP サーバーの組み立て。
 *
 * ステートレスなので、リクエストごとに factory がこの関数を呼んで新しい
 * McpServer を作る。セッション状態を持たないぶん Durable Object が要らない。
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { DATASET_ID, dataset, UserError } from "./dataset.js";
import { inspectDataset, listDatasets } from "./inspect.js";
import { queryRecords, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT } from "./query.js";
import {
  summarizeRecords,
  DEFAULT_AGGREGATE_LIMIT,
  MAX_AGGREGATE_LIMIT,
} from "./summarize.js";

type Json = Record<string, unknown>;

/**
 * LLM クライアントは配列やオブジェクトを JSON 文字列で渡してくることがある。
 * 上流も同じ coercion をしているので、受け取り側で吸収する。
 */
const jsonish = <T>(schema: z.ZodType<T>) =>
  z.preprocess((v) => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }, schema);

const whereSchema = jsonish(z.record(z.string(), z.any()).optional());
const listSchema = jsonish(z.array(z.string()).optional());

function ok(payload: Json) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(err: unknown) {
  const message = err instanceof UserError ? err.message : "内部エラーが発生しました";
  if (!(err instanceof UserError)) console.error(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

async function guard(fn: () => Promise<Json> | Json) {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

export function createServer(env: Env): McpServer {
  const server = new McpServer({
    name: "administrative-procedures",
    version: "0.1.0",
  });

  server.registerTool(
    "list_datasets",
    {
      description:
        "利用可能なデータセットの一覧を返す。まずこれで dataset_id を確認する。",
      inputSchema: {},
    },
    async () => guard(() => listDatasets()),
  );

  server.registerTool(
    "inspect_dataset",
    {
      description:
        "データセットの構造と品質を返す。フィールド名・役割・コードリスト・欠損率を含む。" +
        "query_records や summarize_records を呼ぶ前に、必ずこれでフィールド名を確認すること。",
      inputSchema: {
        dataset_id: z.string().optional().describe(`データセット識別子（既定: ${DATASET_ID}）`),
      },
    },
    async () => guard(() => inspectDataset()),
  );

  server.registerTool(
    "query_records",
    {
      description:
        "レコードをフィルタ・選択・ソートして取得する。カーソルページネーション対応。" +
        "返却値のみを提示し、null や欠損を推測・補完しないこと。" +
        "notes がある場合は回答の脚注に含めること。" +
        "resolved_fields がある場合、入力フィールド名が正式名に補正されているので回答で言及すること。",
      inputSchema: {
        dataset_id: z.string().optional(),
        q: z.string().optional().describe("全文検索キーワード（部分一致 OR、where と AND 結合）"),
        search_fields: listSchema.describe("全文検索の対象フィールド名（既定: 全テキスト列）"),
        select: listSchema.describe("出力するフィールド名（未指定は全フィールド）"),
        where: whereSchema.describe(
          "フィルタ条件。文字列=部分一致、配列=IN、$gte/$lte=範囲、$ne=不一致、" +
            "$not_contains=部分不一致、$not_empty=非空",
        ),
        order_by: z.string().optional().describe("ソートフィールド（'-' 接頭辞で降順）"),
        limit: z
          .number()
          .int()
          .optional()
          .describe(`最大レコード数（1-${MAX_QUERY_LIMIT}、既定 ${DEFAULT_QUERY_LIMIT}）`),
        cursor: z.string().optional().describe("ページネーションカーソル"),
      },
    },
    async (args) => guard(() => queryRecords(env.DB, args as Json)),
  );

  server.registerTool(
    "summarize_records",
    {
      description:
        "集計統計を計算する（GROUP BY × metrics）。件数・合計・平均が必要なときに使う。" +
        "個別レコードが必要なら query_records を使うこと。" +
        "返却値のみを提示し、丸め・推定・補完をしないこと。" +
        `算出数値項目: ${dataset.computed_measures.map((m) => `avg:${m.name}`).join(", ")}`,
      inputSchema: {
        dataset_id: z.string().optional(),
        metrics: listSchema.describe(
          "'count' / 'sum:フィールド' / 'avg:フィールド' / 'min:...' / 'max:...'。既定 ['count']",
        ),
        group_by: listSchema.describe("グループ化するフィールド名。空なら全体で1グループ"),
        where: whereSchema.describe("フィルタ条件（query_records と同じ構文）"),
        having: jsonish(z.record(z.string(), z.any()).optional()).describe(
          '集計後フィルタ。キーは結果列名（例: {"count": {"$gte": 10}}）',
        ),
        explode: z.string().optional().describe("multi_value フィールドを展開して集計する"),
        limit: z
          .number()
          .int()
          .optional()
          .describe(`最大グループ数（既定 ${DEFAULT_AGGREGATE_LIMIT}、上限 ${MAX_AGGREGATE_LIMIT}）`),
      },
    },
    async (args) => guard(() => summarizeRecords(env.DB, args as Json)),
  );

  return server;
}
