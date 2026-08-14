/**
 * Worker のエントリポイント。
 *
 * /mcp が MCP の Streamable HTTP エンドポイント。createMcpHandler はリクエスト
 * ごとに独立したサーバーを作るステートレス実装なので、Durable Object を使わない。
 */
import { createMcpHandler } from "agents/mcp/server";
import { Hono } from "hono";

import { dataset } from "./dataset.js";
import { createServer } from "./mcp.js";

const app = new Hono<{ Bindings: Env }>();

/**
 * createMcpHandler は自身でもリクエストパスを検証するため、Hono 側で
 * ルーティングしただけでは末尾スラッシュ付きが 404 になる。route を
 * 明示して両方受けられるようにする。
 */
const mcp = (route: string) => (c: { req: { raw: Request }; env: Env; executionCtx: unknown }) =>
  createMcpHandler(() => createServer(c.env), { route })(
    c.req.raw,
    c.env,
    // Hono が公開する ExecutionContext 型は Workers ランタイムの型と定義が
    // 揃っていないため、実体は同一だが明示的に合わせる。
    c.executionCtx as ExecutionContext,
  );

app.all("/mcp", mcp("/mcp"));
app.all("/mcp/", mcp("/mcp/"));

app.get("/health", (c) => c.json({ ok: true }));

app.get("/", (c) =>
  c.json({
    name: "cf-administrative-procedures-mcp",
    description: dataset.title,
    publisher: dataset.publisher,
    source_url: dataset.source_url,
    record_count: dataset.record_count,
    mcp_endpoint: new URL("/mcp", c.req.url).toString(),
    repository: "https://github.com/ochanuco/cf-administrative-procedures-mcp",
  }),
);

// Hono インスタンスはオブジェクトなので default export して問題ない。
// createMcpHandler の戻り値を直接 default export すると、Wrangler が関数の
// default export を WorkerEntrypoint クラスとみなすため避けること。
export default app;
