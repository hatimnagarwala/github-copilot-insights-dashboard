import { and, count, inArray, sql } from "drizzle-orm";
import { integer, pgSchema, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { liveDb } from "@/lib/db/clients";
import { appSettings } from "@/lib/db/schema";

export const DEMO_TABLES: readonly string[] = [
  "dim_date",
  "dim_enterprise",
  "dim_org",
  "dim_enterprise_team",
  "dim_enterprise_team_member",
  "dim_user",
  "dim_org_member",
  "dim_ide",
  "dim_feature",
  "dim_language",
  "dim_model",
  "raw_copilot_usage",
  "fact_copilot_usage_daily",
  "fact_ai_credit_usage",
  "fact_copilot_seat_assignment",
  "fact_user_feature_daily",
  "fact_user_ide_daily",
  "fact_user_language_daily",
  "fact_user_model_daily",
  "fact_user_language_model_daily",
  "fact_cli_daily",
  "fact_user_ide_version_daily",
  "fact_org_aggregate_daily",
  "fact_org_adoption_phase_daily",
  "fact_org_pr_comment_type_daily",
];

// Local read-only catalog mapping; not part of the application's migration schema.
const catalogColumns = pgSchema("information_schema").table("columns", {
  tableSchema: text("table_schema").notNull(),
  tableName: text("table_name").notNull(),
  columnName: text("column_name").notNull(),
  dataType: text("data_type").notNull(),
  udtSchema: text("udt_schema").notNull(),
  udtName: text("udt_name").notNull(),
  characterMaximumLength: integer("character_maximum_length"),
  numericPrecision: integer("numeric_precision"),
  numericScale: integer("numeric_scale"),
  datetimePrecision: integer("datetime_precision"),
});
const demoUsage = pgSchema("demo").table("fact_copilot_usage_daily", {});

/** Recreate only missing/drifted data tables. Never touches public data. */
export async function ensureDemoSchema(): Promise<{ recreated: boolean }> {
  // Session locks cannot safely be acquired/released on arbitrary pooled queries.
  const connection = await liveDb.$client.reserve();
  try {
    // postgres-js reserve() omits options at runtime; Drizzle's constructor
    // requires the parent pool's parser/serializer options even for a reserve.
    const session = drizzle({ client: Object.assign(connection, { options: liveDb.$client.options }) });
    await session.execute(sql`SELECT pg_advisory_lock(427915)`);
    try {
      await session.execute(sql`CREATE SCHEMA IF NOT EXISTS demo`);
      const columns = await session.select().from(catalogColumns).where(and(
        inArray(catalogColumns.tableSchema, ["public", "demo"]),
        inArray(catalogColumns.tableName, [...DEMO_TABLES]),
      ));
      const signature = (schema: string, table: string): string[] => columns
        .filter((column) => column.tableSchema === schema && column.tableName === table)
        .map((column) => JSON.stringify([
          column.columnName, column.dataType, column.udtSchema, column.udtName,
          column.characterMaximumLength, column.numericPrecision,
          column.numericScale, column.datetimePrecision,
        ]))
        .sort();

      // Do not drop any demo data if public migrations have not finished yet.
      for (const table of DEMO_TABLES) {
        if (signature("public", table).length === 0) {
          throw new Error(`Demo schema requires public table ${table}; migrations must finish first`);
        }
      }
      let recreated = false;
      for (const table of DEMO_TABLES) {
        const publicColumns = signature("public", table);
        const demoColumns = signature("demo", table);
        if (JSON.stringify(publicColumns) === JSON.stringify(demoColumns)) continue;
        // Identifiers are exclusively drawn from the constant allowlist above.
        await session.execute(sql`DROP TABLE IF EXISTS demo.${sql.identifier(table)} CASCADE`);
        await session.execute(sql`CREATE TABLE demo.${sql.identifier(table)} (LIKE public.${sql.identifier(table)} INCLUDING ALL)`);
        recreated = true;
      }
      return { recreated };
    } finally {
      await session.execute(sql`SELECT pg_advisory_unlock(427915)`);
    }
  } finally {
    connection.release();
  }
}

export async function isDemoSchemaEmpty(): Promise<boolean> {
  try {
    const [row] = await liveDb.select({ rows: count() }).from(demoUsage);
    return !row || row.rows === 0;
  } catch (error) {
    // Drizzle wraps postgres errors in cause. Only missing schema/table is empty;
    // connection/permission failures must remain visible to the startup caller.
    let cause: unknown = error;
    for (let depth = 0; cause && depth < 5; depth++) {
      const pgError = cause as { code?: string; cause?: unknown };
      if (pgError.code === "42P01" || pgError.code === "3F000") return true;
      cause = pgError.cause;
    }
    throw error;
  }
}

export interface DemoMeta {
  version: string | null;
  loadedAt: string | null;
  anchor: string | null;
}

const META_KEYS = {
  version: "demo_data_version",
  loadedAt: "demo_data_loaded_at",
  anchor: "demo_data_anchor",
} as const;

export async function getDemoMeta(): Promise<DemoMeta> {
  const rows = await liveDb.select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings).where(inArray(appSettings.key, Object.values(META_KEYS)));
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    version: values.get(META_KEYS.version) ?? null,
    loadedAt: values.get(META_KEYS.loadedAt) ?? null,
    anchor: values.get(META_KEYS.anchor) ?? null,
  };
}

export async function setDemoMeta(meta: {
  version: string;
  loadedAt: string;
  anchor: string;
}): Promise<void> {
  const updatedAt = new Date();
  await liveDb.insert(appSettings).values([
    { key: META_KEYS.version, value: meta.version, updatedAt },
    { key: META_KEYS.loadedAt, value: meta.loadedAt, updatedAt },
    { key: META_KEYS.anchor, value: meta.anchor, updatedAt },
  ]).onConflictDoUpdate({
    target: appSettings.key,
    set: { value: sql`excluded.value`, updatedAt },
  });
}
