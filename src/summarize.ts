/**
 * summarize_records — GROUP BY × metrics の集計。
 *
 * 結果列の命名は上流 (query.py compute_aggregation) に合わせる:
 *   count            → "count"
 *   sum:<field>      → "sum:<field>" と "sum:<field>:null_excluded"
 *   avg:<computed>   → "avg:<算出項目名>"
 */
import {
  computedMeasure,
  dataset,
  quoteIdent,
  requireField,
  UserError,
  type Field,
} from "./dataset.js";
import { buildWhere, combine, type Fragment, type WhereValue } from "./where.js";

export const DEFAULT_AGGREGATE_LIMIT = 200;
export const MAX_AGGREGATE_LIMIT = 10_000;
const MAX_GROUP_BY_FIELDS = 200;
const MAX_METRICS = 200;
const SIMPLE_METRICS = new Set(["sum", "avg", "min", "max"]);

export interface SummarizeArgs {
  dataset_id?: string;
  metrics?: string[];
  group_by?: string[];
  where?: Record<string, WhereValue>;
  having?: Record<string, Record<string, number>>;
  explode?: string;
  limit?: number;
}

interface Aggregate {
  /** SELECT に並べる "式 AS 別名" の断片。 */
  select: string[];
  binds: unknown[];
  /** HAVING で参照できる結果列名。 */
  columns: string[];
}

function buildMetrics(
  metrics: string[],
  resolved: Record<string, string>,
): Aggregate {
  if (metrics.length > MAX_METRICS) {
    throw new UserError(`metrics は ${MAX_METRICS} 個以内です（入力: ${metrics.length}）`);
  }
  const agg: Aggregate = { select: [], binds: [], columns: [] };

  for (const metric of metrics) {
    const idx = metric.indexOf(":");
    const type = idx === -1 ? metric : metric.slice(0, idx);
    const target = idx === -1 ? null : metric.slice(idx + 1);

    if (type === "count" && !target) {
      agg.select.push(`COUNT(*) AS "count"`);
      agg.columns.push("count");
      continue;
    }
    if (!target) {
      throw new UserError(
        `集計 '${type}' にはフィールドが必要です。'${type}:フィールド名' の形式で指定してください`,
      );
    }
    if (type !== "count" && !SIMPLE_METRICS.has(type)) {
      throw new UserError(
        `不明な集計種別 '${type}'。使用可能: count, sum, avg, min, max`,
      );
    }

    // 算出数値項目 (computed_measures) は加重平均としてのみ扱う。
    const cm = computedMeasure(target);
    if (cm) {
      if (type !== "avg") {
        throw new UserError(
          `算出数値項目 '${target}' は avg のみ対応しています。'avg:${target}' を使ってください`,
        );
      }
      const cond = requireField(cm.condition_field, "computed_measures");
      const placeholders = cm.condition_values.map(() => "?").join(", ");
      const alias = `avg:${cm.name}`;
      agg.select.push(
        `ROUND(SUM(CASE WHEN COALESCE(${quoteIdent(cond.field.name)}, '') IN (${placeholders}) ` +
          `THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 4) AS ${quoteIdent(alias)}`,
      );
      agg.binds.push(...cm.condition_values);
      agg.columns.push(alias);
      continue;
    }

    const { field, correctedFrom } = requireField(target, "metrics");
    if (correctedFrom) resolved[correctedFrom] = field.name;
    if (field.role !== "measure") {
      throw new UserError(
        `フィールド '${target}' は集計対象外です。数値項目のみ集計できます`,
      );
    }

    const col = quoteIdent(field.name);
    const alias = `${type}:${field.name}`;
    const expr =
      type === "sum"
        ? `CAST(SUM(CAST(${col} AS REAL)) AS INTEGER)`
        : type === "avg"
          ? `ROUND(AVG(CAST(${col} AS REAL)), 2)`
          : `${type.toUpperCase()}(CAST(${col} AS REAL))`;
    agg.select.push(`${expr} AS ${quoteIdent(alias)}`);
    // 集計から外れた欠損の件数を併記する。上流と同じく利用者が母数を誤解しないため。
    agg.select.push(
      `SUM(CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END) AS ${quoteIdent(`${alias}:null_excluded`)}`,
    );
    agg.columns.push(alias);
  }

  if (!agg.select.length) {
    throw new UserError("metrics が空です");
  }
  return agg;
}

function buildHaving(
  having: Record<string, Record<string, number>> | undefined,
  columns: string[],
): Fragment | null {
  if (!having || !Object.keys(having).length) return null;
  const parts: Fragment[] = [];
  for (const [col, condition] of Object.entries(having)) {
    if (!columns.includes(col)) {
      throw new UserError(
        `having に不明な結果列 '${col}' が指定されました。使えるのは: ${columns.join(", ")}`,
      );
    }
    for (const [op, val] of Object.entries(condition)) {
      const sqlOp =
        op === "$gte" ? ">=" : op === "$lte" ? "<=" : op === "$ne" ? "!=" : op === "$eq" ? "=" : null;
      if (!sqlOp) {
        throw new UserError(
          `having の未対応の演算子 '${op}'。使えるのは $eq, $ne, $gte, $lte です`,
        );
      }
      parts.push({ sql: `${quoteIdent(col)} ${sqlOp} ?`, binds: [val] });
    }
  }
  return {
    sql: parts.map((p) => `(${p.sql})`).join(" AND "),
    binds: parts.flatMap((p) => p.binds),
  };
}

export async function summarizeRecords(db: D1Database, args: SummarizeArgs) {
  const resolvedFields: Record<string, string> = {};
  const metrics = args.metrics?.length ? args.metrics : ["count"];
  const groupByNames = args.group_by ?? [];

  if (groupByNames.length > MAX_GROUP_BY_FIELDS) {
    throw new UserError(
      `group_by は ${MAX_GROUP_BY_FIELDS} フィールド以内です（入力: ${groupByNames.length}）`,
    );
  }

  // explode 対象は自動的にグループ化キーへ加える (上流と同じ挙動)。
  let explodeField: Field | null = null;
  if (args.explode) {
    const { field, correctedFrom } = requireField(args.explode, "explode");
    if (correctedFrom) resolvedFields[correctedFrom] = field.name;
    if (!field.multi_value) {
      throw new UserError(
        `フィールド '${args.explode}' は multi_value ではないため explode できません`,
      );
    }
    explodeField = field;
  }

  const groupFields = groupByNames.map((n) => {
    const { field, correctedFrom } = requireField(n, "group_by");
    if (correctedFrom) resolvedFields[correctedFrom] = field.name;
    return field;
  });

  const groupExprs: string[] = [];
  if (explodeField && !groupFields.some((f) => f.name === explodeField!.name)) {
    groupExprs.push(`v.value AS ${quoteIdent(explodeField.name)}`);
  }
  for (const f of groupFields) {
    if (explodeField && f.name === explodeField.name) {
      groupExprs.push(`v.value AS ${quoteIdent(f.name)}`);
    } else {
      groupExprs.push(`COALESCE(p.${quoteIdent(f.name)}, '') AS ${quoteIdent(f.name)}`);
    }
  }

  const agg = buildMetrics(metrics, resolvedFields);
  const { fragment: whereFragment, resolvedFields: whereResolved } = buildWhere(args.where);
  Object.assign(resolvedFields, whereResolved);
  const having = buildHaving(args.having, agg.columns);

  // 集計式・where は "p." 修飾なしの列名で組んでいるので、explode の JOIN が
  // 入るときだけ procedures を p に別名付けし、曖昧さは列名の一意性で回避する。
  const joinClause = explodeField
    ? ` JOIN procedure_values v ON v.id = p.${quoteIdent(dataset.id_field)} AND v.field_id = ?`
    : "";
  const joinBinds = explodeField ? [explodeField.field_id] : [];

  const groupClause = groupExprs.length
    ? ` GROUP BY ${groupExprs.map((_, i) => String(i + 1)).join(", ")}`
    : "";
  const orderColumn = agg.columns[0]!;
  const limit = Math.min(
    Math.max(args.limit ?? DEFAULT_AGGREGATE_LIMIT, 1),
    MAX_AGGREGATE_LIMIT,
  );

  const sql =
    `SELECT ${[...groupExprs, ...agg.select].join(", ")} FROM procedures p` +
    joinClause +
    (whereFragment ? ` WHERE ${whereFragment.sql}` : "") +
    groupClause +
    (having ? ` HAVING ${having.sql}` : "") +
    ` ORDER BY ${quoteIdent(orderColumn)} DESC` +
    ` LIMIT ?`;

  // bind は SQL 内でプレースホルダが現れる順に並べる。算出数値項目の
  // condition_values は SELECT 句にあるため、JOIN や WHERE より先に来る。
  const binds = [
    ...agg.binds,
    ...joinBinds,
    ...(whereFragment?.binds ?? []),
    ...(having?.binds ?? []),
    limit,
  ];

  const { results, meta } = await db
    .prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();

  const notes = [...groupFields, ...(explodeField ? [explodeField] : [])]
    .filter((f) => f.notes?.length)
    .map((f) => ({ field: f.name, notes: f.notes! }));

  return {
    dataset_id: dataset.id,
    metrics,
    group_by: groupExprs.length ? [...new Set([
      ...(explodeField ? [explodeField.name] : []),
      ...groupFields.map((f) => f.name),
    ])] : [],
    group_count: results.length,
    truncated: results.length >= limit,
    groups: results,
    ...(Object.keys(resolvedFields).length ? { resolved_fields: resolvedFields } : {}),
    ...(notes.length ? { notes } : {}),
    _meta: { rows_read: meta.rows_read },
  };
}
