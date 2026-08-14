/**
 * query_records — レコードのフィルタ・選択・ソート・ページネーション。
 */
import {
  dataset,
  defaultSearchFields,
  quoteIdent,
  requireField,
  UserError,
  type Field,
} from "./dataset.js";
import { buildFullText, buildWhere, combine, type WhereValue } from "./where.js";

export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 5_000;
const MAX_CURSOR_LENGTH = 2048;

export interface QueryArgs {
  dataset_id?: string;
  q?: string;
  search_fields?: string[];
  select?: string[];
  where?: Record<string, WhereValue>;
  order_by?: string;
  limit?: number;
  cursor?: string;
}

function encodeCursor(offset: number): string {
  return btoa(JSON.stringify({ o: offset }));
}

function decodeCursor(cursor: string): number {
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new UserError(`cursor が長すぎます（${cursor.length} 文字）`);
  }
  try {
    const parsed = JSON.parse(atob(cursor)) as { o?: unknown };
    const offset = parsed.o;
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
      throw new Error("bad offset");
    }
    return offset;
  } catch {
    throw new UserError("cursor が壊れています。cursor を外して取り直してください");
  }
}

function resolveList(
  names: string[] | undefined,
  label: string,
  resolved: Record<string, string>,
): Field[] | null {
  if (!names || !names.length) return null;
  return names.map((n) => {
    const { field, correctedFrom } = requireField(n, label);
    if (correctedFrom) resolved[correctedFrom] = field.name;
    return field;
  });
}

export async function queryRecords(db: D1Database, args: QueryArgs) {
  const resolvedFields: Record<string, string> = {};

  const selectFields = resolveList(args.select, "select", resolvedFields) ?? dataset.fields;
  const searchFields = resolveList(args.search_fields, "search_fields", resolvedFields);

  const { fragment: whereFragment, resolvedFields: whereResolved } = buildWhere(args.where);
  Object.assign(resolvedFields, whereResolved);

  const textFragment = args.q
    ? buildFullText(args.q, searchFields ?? defaultSearchFields())
    : null;
  const filter = combine([whereFragment, textFragment]);

  let orderClause = "";
  if (args.order_by) {
    const desc = args.order_by.startsWith("-");
    const raw = desc ? args.order_by.slice(1) : args.order_by;
    const { field, correctedFrom } = requireField(raw, "order_by");
    if (correctedFrom) resolvedFields[correctedFrom] = field.name;
    orderClause = ` ORDER BY ${quoteIdent(field.name)} ${desc ? "DESC" : "ASC"} NULLS LAST`;
  }

  const limit = Math.min(Math.max(args.limit ?? DEFAULT_QUERY_LIMIT, 1), MAX_QUERY_LIMIT);
  const offset = args.cursor ? decodeCursor(args.cursor) : 0;

  const columns = selectFields.map((f) => quoteIdent(f.name)).join(", ");
  const sql =
    `SELECT ${columns} FROM procedures` +
    (filter ? ` WHERE ${filter.sql}` : "") +
    orderClause +
    // 1 件多く取って、COUNT(*) を撃たずに次ページの有無を判定する。
    ` LIMIT ? OFFSET ?`;
  const binds = [...(filter?.binds ?? []), limit + 1, offset];

  const { results, meta } = await db
    .prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();

  const hasMore = results.length > limit;
  const records = hasMore ? results.slice(0, limit) : results;

  const notes = selectFields
    .filter((f) => f.notes?.length)
    .map((f) => ({ field: f.name, notes: f.notes! }));

  return {
    dataset_id: dataset.id,
    count: records.length,
    offset,
    has_more: hasMore,
    next_cursor: hasMore ? encodeCursor(offset + limit) : null,
    records,
    ...(Object.keys(resolvedFields).length ? { resolved_fields: resolvedFields } : {}),
    ...(notes.length ? { notes } : {}),
    _meta: { rows_read: meta.rows_read },
  };
}
