import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  columns: vi.fn(), execute: vi.fn(), release: vi.fn(), reserve: vi.fn(),
  select: vi.fn(), values: vi.fn(), upsert: vi.fn(), construct: vi.fn(),
}));
vi.mock("@/lib/db/clients", () => ({
  liveDb: {
    $client: { reserve: mocks.reserve, options: { parsers: {}, serializers: {} } },
    select: mocks.select,
    insert: () => ({ values: mocks.values }),
  },
}));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: mocks.construct }));

import { DEMO_TABLES, ensureDemoSchema, getDemoMeta, isDemoSchemaEmpty, setDemoMeta } from "../schema";

function catalog(schema: string) {
  return DEMO_TABLES.map((tableName) => ({
    tableSchema: schema, tableName, columnName: "id", dataType: "integer",
    udtSchema: "pg_catalog", udtName: "int4", characterMaximumLength: null,
    numericPrecision: 32, numericScale: 0, datetimePrecision: null,
  }));
}
const queries = () => mocks.execute.mock.calls.map(([query]: unknown[]) => new PgDialect().sqlToQuery(query as SQL).sql);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.reserve.mockResolvedValue({ release: mocks.release });
  mocks.construct.mockReturnValue({
    execute: mocks.execute,
    select: () => ({ from: () => ({ where: mocks.columns }) }),
  });
  mocks.execute.mockResolvedValue([]);
  mocks.columns.mockResolvedValue([...catalog("public"), ...catalog("demo")]);
  mocks.values.mockReturnValue({ onConflictDoUpdate: mocks.upsert });
  mocks.upsert.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("demo schema", () => {
  it("is a no-op when all demo column names and types match", async () => {
    expect(DEMO_TABLES).toHaveLength(25);
    expect(await ensureDemoSchema()).toEqual({ recreated: false });
    expect(queries()).toEqual([
      "SELECT pg_advisory_lock(427915)", "CREATE SCHEMA IF NOT EXISTS demo",
      "SELECT pg_advisory_unlock(427915)",
    ]);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("creates every missing table using allowlisted quoted identifiers", async () => {
    mocks.columns.mockResolvedValue(catalog("public"));
    expect(await ensureDemoSchema()).toEqual({ recreated: true });
    for (const table of DEMO_TABLES) {
      expect(queries()).toContain(`DROP TABLE IF EXISTS demo."${table}" CASCADE`);
      expect(queries()).toContain(`CREATE TABLE demo."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    }
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("recreates only a table with changed column types", async () => {
    const demo = catalog("demo");
    demo[0].dataType = "text";
    mocks.columns.mockResolvedValue([...catalog("public"), ...demo]);
    expect(await ensureDemoSchema()).toEqual({ recreated: true });
    expect(queries().filter((query) => query.startsWith("DROP TABLE"))).toEqual([
      'DROP TABLE IF EXISTS demo."dim_date" CASCADE',
    ]);
  });

  it("does not drop demo tables before public migrations finish", async () => {
    mocks.columns.mockResolvedValue(catalog("demo"));
    await expect(ensureDemoSchema()).rejects.toThrow("migrations must finish first");
    expect(queries().some((query) => query.startsWith("DROP TABLE"))).toBe(false);
    expect(queries().at(-1)).toBe("SELECT pg_advisory_unlock(427915)");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("unlocks and releases the same session after a DDL failure", async () => {
    mocks.columns.mockResolvedValue(catalog("public"));
    mocks.execute.mockImplementation(async (query: SQL) => {
      if (new PgDialect().sqlToQuery(query).sql.startsWith("CREATE TABLE")) throw new Error("DDL failed");
      return [];
    });
    await expect(ensureDemoSchema()).rejects.toThrow("DDL failed");
    expect(queries().at(-1)).toBe("SELECT pg_advisory_unlock(427915)");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("releases a reservation even if Drizzle construction fails", async () => {
    mocks.construct.mockImplementation(() => { throw new Error("constructor failed"); });
    await expect(ensureDemoSchema()).rejects.toThrow("constructor failed");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("reports emptiness based on the demo fact count", async () => {
    mocks.select.mockReturnValue({ from: () => Promise.resolve([{ rows: 0 }]) });
    expect(await isDemoSchemaEmpty()).toBe(true);
    mocks.select.mockReturnValue({ from: () => Promise.resolve([{ rows: 12 }]) });
    expect(await isDemoSchemaEmpty()).toBe(false);
  });

  it("treats missing tables as empty without hiding database failures", async () => {
    mocks.select.mockReturnValue({ from: () => Promise.reject({ cause: { code: "42P01" } }) });
    expect(await isDemoSchemaEmpty()).toBe(true);
    mocks.select.mockReturnValue({ from: () => Promise.reject(new Error("offline")) });
    await expect(isDemoSchemaEmpty()).rejects.toThrow("offline");
  });

  it("reads and upserts all three metadata keys through live settings", async () => {
    mocks.select.mockReturnValue({ from: () => ({ where: async () => [
      { key: "demo_data_version", value: "1" },
      { key: "demo_data_loaded_at", value: "2026-10-13T09:00:00Z" },
      { key: "demo_data_anchor", value: "2026-10-13" },
    ] }) });
    const meta = await getDemoMeta();
    expect(meta).toEqual({ version: "1", loadedAt: "2026-10-13T09:00:00Z", anchor: "2026-10-13" });
    await setDemoMeta({ version: "1", loadedAt: "2026-10-13T09:00:00Z", anchor: "2026-10-13" });
    expect(mocks.values).toHaveBeenCalledWith([
      { key: "demo_data_version", value: meta.version, updatedAt: expect.any(Date) },
      { key: "demo_data_loaded_at", value: meta.loadedAt, updatedAt: expect.any(Date) },
      { key: "demo_data_anchor", value: meta.anchor, updatedAt: expect.any(Date) },
    ]);
    expect(mocks.upsert).toHaveBeenCalledOnce();
  });
});
