import type { SqliteBrokerLoadSource } from "./core/store.js";

export type BrokerPersistenceBackend = "json-file" | "sqlite";

export function normalizePersistenceBackend(value: string | undefined): BrokerPersistenceBackend {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "sqlite") {
    return "sqlite";
  }
  return "json-file";
}

export function normalizeSqliteLoadSource(value: string | undefined): SqliteBrokerLoadSource {
  const normalized = value?.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "hot-tables" || normalized === "hot-table" || normalized === "hot-runtime") {
    return "hot-tables";
  }
  return "snapshot";
}
