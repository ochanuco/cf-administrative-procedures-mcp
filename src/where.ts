/**
 * where DSL を SQL の条件式に変換する。
 *
 * 上流 (query.py の FilterPredicate 群) の意味論をそのまま SQL に写す。対応表:
 *
 *   文字列          → 部分一致 (大文字小文字を無視)
 *   配列            → いずれかに一致 (multi_value 列はセミコロン分割相当)
 *   数値            → 完全一致
 *   {$eq|$in: v}    → 完全一致
 *   {$ne: v}        → 不一致
 *   {$gte|$lte: n}  → 数値比較
 *   {$not_contains} → 部分不一致
 *   {$not_empty: true} → 非空
 *
 * 部分一致に LIKE ではなく instr() を使うのは、上流が literal=True で
 * ワイルドカードを解釈しないため。LIKE だと検索語中の % と _ を毎回
 * エスケープする必要があり、取りこぼすと意味が変わる。
 */
import {
  dataset,
  quoteIdent,
  requireField,
  UserError,
  type Field,
} from "./dataset.js";

export const MAX_Q_LENGTH = 1024;
export const MAX_WHERE_FIELDS = 200;
export const MAX_WHERE_ARRAY_SIZE = 200;
export const MAX_WHERE_STRING_LENGTH = 10_000;

export interface Fragment {
  sql: string;
  binds: unknown[];
}

export type WhereValue =
  | string
  | number
  | (string | number)[]
  | Record<string, unknown>;

const and = (parts: Fragment[]): Fragment => ({
  sql: parts.map((p) => `(${p.sql})`).join(" AND "),
  binds: parts.flatMap((p) => p.binds),
});

const or = (parts: Fragment[]): Fragment => ({
  sql: parts.map((p) => `(${p.sql})`).join(" OR "),
  binds: parts.flatMap((p) => p.binds),
});

function checkString(v: unknown, label: string): void {
  if (typeof v === "string" && v.length > MAX_WHERE_STRING_LENGTH) {
    throw new UserError(
      `${label} の文字列は ${MAX_WHERE_STRING_LENGTH} 文字以内です（入力: ${v.length}）`,
    );
  }
}

function checkArray(v: unknown[], label: string): void {
  if (v.length > MAX_WHERE_ARRAY_SIZE) {
    throw new UserError(
      `${label} の配列は ${MAX_WHERE_ARRAY_SIZE} 要素以内です（入力: ${v.length}）`,
    );
  }
  for (const el of v) checkString(el, label);
}

/** 大文字小文字を無視した部分一致。値は生の文字列として扱う。 */
function contains(field: Field, needle: string, negate: boolean): Fragment {
  const col = `lower(COALESCE(${quoteIdent(field.name)}, ''))`;
  return {
    sql: `instr(${col}, lower(?)) ${negate ? "=" : ">"} 0`,
    binds: [needle],
  };
}

/**
 * 完全一致。multi_value 列は正規化済みの procedure_values を引く。
 * 実行時に文字列を分割しないのはこのため。
 */
function equals(field: Field, values: (string | number)[]): Fragment {
  const placeholders = values.map(() => "?").join(", ");
  if (field.multi_value) {
    return {
      sql:
        `${quoteIdent(dataset.id_field)} IN (` +
        `SELECT id FROM procedure_values WHERE field_id = ? AND value IN (${placeholders}))`,
      binds: [field.field_id, ...values],
    };
  }
  // 上流は null を "" として比較するため、COALESCE で揃える。
  return {
    sql: `COALESCE(${quoteIdent(field.name)}, '') IN (${placeholders})`,
    binds: values.map((v) => String(v)),
  };
}

function buildOperator(field: Field, op: string, val: unknown): Fragment {
  const col = quoteIdent(field.name);
  switch (op) {
    case "$eq":
    case "$in": {
      const arr = Array.isArray(val) ? val : [val];
      checkArray(arr, `${op}（${field.name}）`);
      return equals(field, arr as (string | number)[]);
    }
    case "$ne": {
      const arr = (Array.isArray(val) ? val : [val]).map((v) => String(v));
      checkArray(arr, `$ne（${field.name}）`);
      return {
        sql: `COALESCE(${col}, '') NOT IN (${arr.map(() => "?").join(", ")})`,
        binds: arr,
      };
    }
    case "$gte":
    case "$lte": {
      if (typeof val !== "number") {
        throw new UserError(
          `${op}（${field.name}）には数値を指定してください（入力: ${JSON.stringify(val)}）`,
        );
      }
      // NULL や数値化できない値は比較結果が NULL になり、一致しない。
      // 上流が null を NaN で埋めて弾いているのと同じ挙動。
      return {
        sql: `CAST(${col} AS REAL) ${op === "$gte" ? ">=" : "<="} ?`,
        binds: [val],
      };
    }
    case "$not_contains": {
      const arr = Array.isArray(val) ? val : [val];
      checkArray(arr, `$not_contains（${field.name}）`);
      return and(arr.map((v) => contains(field, String(v), true)));
    }
    case "$not_empty": {
      if (val === false) {
        return { sql: `TRIM(COALESCE(${col}, '')) = ''`, binds: [] };
      }
      return {
        sql: `${col} IS NOT NULL AND TRIM(COALESCE(${col}, '')) <> ''`,
        binds: [],
      };
    }
    default:
      throw new UserError(
        `未対応の演算子 '${op}'（${field.name}）。使えるのは ` +
          `$eq, $in, $ne, $gte, $lte, $not_contains, $not_empty です`,
      );
  }
}

export interface WhereResult {
  fragment: Fragment | null;
  /** 入力名を正式名へ補正した対応。応答で利用者に伝える。 */
  resolvedFields: Record<string, string>;
}

export function buildWhere(where: Record<string, WhereValue> | null | undefined): WhereResult {
  const resolvedFields: Record<string, string> = {};
  if (!where) return { fragment: null, resolvedFields };

  const keys = Object.keys(where);
  if (keys.length > MAX_WHERE_FIELDS) {
    throw new UserError(
      `where は ${MAX_WHERE_FIELDS} フィールド以内です（入力: ${keys.length}）`,
    );
  }

  const parts: Fragment[] = [];
  for (const key of keys) {
    const { field, correctedFrom } = requireField(key, "where");
    if (correctedFrom) resolvedFields[correctedFrom] = field.name;
    const condition = where[key];

    if (Array.isArray(condition)) {
      checkArray(condition, `where（${key}）`);
      parts.push(equals(field, condition));
    } else if (typeof condition === "string") {
      checkString(condition, `where（${key}）`);
      parts.push(contains(field, condition, false));
    } else if (typeof condition === "number") {
      parts.push(equals(field, [condition]));
    } else if (condition && typeof condition === "object") {
      for (const [op, val] of Object.entries(condition)) {
        parts.push(buildOperator(field, op, val));
      }
    } else {
      throw new UserError(
        `where（${key}）の条件が解釈できません: ${JSON.stringify(condition)}`,
      );
    }
  }

  return {
    fragment: parts.length ? and(parts) : null,
    resolvedFields,
  };
}

/** 全文検索 (q)。対象フィールドの OR 部分一致。 */
export function buildFullText(
  keyword: string,
  fields: Field[],
): Fragment {
  if (keyword.length > MAX_Q_LENGTH) {
    throw new UserError(
      `q は ${MAX_Q_LENGTH} 文字以内です（入力: ${keyword.length}）`,
    );
  }
  if (!fields.length) return { sql: "0 = 1", binds: [] };
  return or(fields.map((f) => contains(f, keyword, false)));
}

export function combine(fragments: (Fragment | null)[]): Fragment | null {
  const present = fragments.filter((f): f is Fragment => f !== null);
  if (!present.length) return null;
  return and(present);
}
