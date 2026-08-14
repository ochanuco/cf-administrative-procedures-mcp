/**
 * list_datasets / inspect_dataset — どちらも D1 を叩かない。
 *
 * 品質統計もコードリストもビルド時に dataset.json へ焼き込んであるため、
 * これらのツールは同梱データを整形して返すだけで済む。
 */
import { dataset } from "./dataset.js";

export function listDatasets() {
  return {
    datasets: [
      {
        dataset_id: dataset.id,
        title: dataset.title,
        publisher: dataset.publisher,
        published_at: dataset.published_at,
        source_url: dataset.source_url,
        record_count: dataset.record_count,
        field_count: dataset.fields.length,
      },
    ],
  };
}

export function inspectDataset() {
  return {
    dataset_id: dataset.id,
    title: dataset.title,
    publisher: dataset.publisher,
    published_at: dataset.published_at,
    source_url: dataset.source_url,
    record_count: dataset.record_count,
    id_field: dataset.id_field,
    multi_value_separator: dataset.multi_value_separator,
    generic_values: dataset.generic_values,
    computed_measures: dataset.computed_measures,
    fields: dataset.fields.map((f) => ({
      name: f.name,
      role: f.role,
      sql_type: f.sql_type,
      desc: f.desc,
      ...(f.multi_value ? { multi_value: true } : {}),
      ...(f.notes?.length ? { notes: f.notes } : {}),
      // codelist が "auto" の列は実データ由来の頻度上位が stats.top_values に入る。
      ...(Array.isArray(f.codelist) ? { codelist: f.codelist } : {}),
      groupable: f.role === "dim" || f.role === "attr",
      aggregatable: f.role === "measure",
      stats: f.stats,
    })),
  };
}
