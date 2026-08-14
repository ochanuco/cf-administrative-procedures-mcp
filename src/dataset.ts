/**
 * データセット定義 (DSD) の読み込みとフィールド解決。
 *
 * 定義はビルド時に tools/build_sqlite.py が生成した JSON を同梱する。品質統計も
 * そこで計算済みなので、inspect_dataset は D1 を一切叩かずに応答できる。
 */
import definition from "./generated/dataset.json" with { type: "json" };

export type FieldRole = "id" | "dim" | "attr" | "measure";

export interface FieldStats {
  null_count: number;
  null_ratio: number;
  distinct_count: number;
  min?: number | null;
  max?: number | null;
  sum?: number | null;
  top_values?: { value: string; count: number }[];
}

export interface Field {
  name: string;
  role: FieldRole;
  /** procedure_values.field_id と対応する。multi_value 列の絞り込みに使う。 */
  field_id: number;
  sql_type: "TEXT" | "INTEGER" | "REAL";
  desc?: string;
  notes?: string[];
  multi_value?: boolean;
  codelist?: "auto" | { [k: string]: string }[];
  data_type?: string;
  stats: FieldStats;
}

export interface ComputedMeasure {
  name: string;
  mode: "count_where";
  condition_field: string;
  condition_values: string[];
  desc?: string;
}

export interface Dataset {
  id: string;
  schema_version: string;
  title: string;
  publisher: string;
  id_field: string;
  published_at: string;
  source_url: string;
  computed_measures: ComputedMeasure[];
  generic_values: string[];
  multi_value_separator: string;
  record_count: number;
  fields: Field[];
}

/**
 * 現状データセットは1つ。dataset_id は上流のツール契約に合わせて受け取るが、
 * 実体はこの1件に固定する。増えたらビルド時に JSON を作り直す。
 */
export const DATASET_ID = "procedures-survey-r6";

export const dataset: Dataset = {
  id: DATASET_ID,
  ...(definition as Omit<Dataset, "id">),
};

const byName = new Map<string, Field>(dataset.fields.map((f) => [f.name, f]));

/** 表記ゆれを吸収するための正規化。全角空白・空白除去・小文字化。 */
function normalize(name: string): string {
  return name.replace(/[\s　]/g, "").toLowerCase();
}

const byNormalized = new Map<string, Field>(
  dataset.fields.map((f) => [normalize(f.name), f]),
);

export interface Resolution {
  field: Field;
  /** 入力名が正式名と異なっていた場合に、その入力名を保持する。 */
  correctedFrom?: string;
}

/**
 * フィールド名を解決する。完全一致を優先し、外れたら正規化して照合する。
 *
 * SQL に列名を埋め込む箇所は必ずここを通す。DSD に無い名前は解決できないため、
 * 列名経由の SQL インジェクションはここで塞がる。
 */
export function resolveField(name: string): Resolution | null {
  const exact = byName.get(name);
  if (exact) return { field: exact };
  const loose = byNormalized.get(normalize(name));
  if (loose) return { field: loose, correctedFrom: name };
  return null;
}

export function requireField(name: string, label: string): Resolution {
  const r = resolveField(name);
  if (!r) {
    throw new UserError(`${label}に不明なフィールド '${name}' が指定されました`);
  }
  return r;
}

export function computedMeasure(name: string): ComputedMeasure | undefined {
  return dataset.computed_measures.find((m) => m.name === name);
}

/** 全文検索の既定対象。上流に合わせて文字列型の全フィールドを対象にする。 */
export function defaultSearchFields(): Field[] {
  return dataset.fields.filter((f) => f.sql_type === "TEXT");
}

/** 列名を SQL 識別子として引用する。名前は DSD 由来のものだけを渡すこと。 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * 利用者の入力に起因するエラー。MCP 応答として整形して返し、スタックは出さない。
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
