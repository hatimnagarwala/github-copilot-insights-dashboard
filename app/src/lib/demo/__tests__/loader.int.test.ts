import { createHash } from "node:crypto";
import { count, eq, getTableName, is, max } from "drizzle-orm";
import { PgTable, pgSchema } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { demoDb, liveDb } from "@/lib/db/clients";
import { runMigrations } from "@/lib/db/migrate";
import * as schema from "@/lib/db/schema";
import { ensureDemoDataLoaded, loadDemoData } from "../loader";
import { DEMO_TABLES, getDemoMeta } from "../schema";

// Explicit DATABASE_URL opt-in, matching the ETL integration tests. Never cleans
// demo data up: the populated schema is useful for local report verification.
describe.skipIf(!process.env.DATABASE_URL)("demo loader (integration)", () => {
  async function publicFacts() {
    const snapshots: Record<string, string> = {};
    for (const table of Object.values(schema)) {
      if (!is(table, PgTable) || !getTableName(table).startsWith("fact_")) continue;
      const rows = await liveDb.select().from(table);
      // Order independent, exact row-content fingerprint, not merely a count.
      const serialized = rows.map((row) => JSON.stringify(row)).sort();
      snapshots[getTableName(table)] = createHash("sha256").update(JSON.stringify(serialized)).digest("hex");
    }
    return snapshots;
  }

  it("populates every demo table, preserves live facts and skips current reloads", async () => {
    const migration = await runMigrations();
    expect(migration.migrationError).toBeFalsy();
    expect(migration.fixupError).toBeFalsy();
    const before = await publicFacts();
    const start = Date.now();
    const loaded = await loadDemoData({ force: true });
    console.info("Demo integration full-load timing (ms):", Date.now() - start);
    console.info("Demo integration per-table counts:", loaded.counts);
    for (const name of DEMO_TABLES) {
      const [row] = await demoDb.select({ n: count() }).from(pgSchema("demo").table(name, {}));
      expect(row.n, name).toBeGreaterThan(0);
      expect(row.n, name).toBe(loaded.counts[name]);
    }
    expect(await publicFacts()).toEqual(before);
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const [latest] = await demoDb.select({ day: max(schema.factCopilotUsageDaily.day) }).from(schema.factCopilotUsageDaily);
    expect([today, yesterday]).toContain(latest.day);
    expect(loaded.anchor).toBe(today);
    const orgs = await demoDb.select().from(schema.dimOrg);
    const users = await demoDb.select().from(schema.dimUser);
    expect(users).toHaveLength(50);
    expect(users.every((user) => user.isCurrent && orgs.some((org) => org.orgId === user.orgId))).toBe(true);
    const [premium] = await demoDb.select({ n: count() }).from(schema.dimModel).where(eq(schema.dimModel.isPremium, true));
    expect(premium.n).toBeGreaterThan(0);
    const meta = await getDemoMeta();
    await ensureDemoDataLoaded();
    expect(await getDemoMeta()).toEqual(meta);
    await ensureDemoDataLoaded();
    expect(await getDemoMeta()).toEqual(meta);
    const messages: string[] = [];
    expect((await loadDemoData({ onLog: (msg) => messages.push(msg) })).counts).toEqual(loaded.counts);
    expect(messages.some((msg) => msg.includes("skipping reload"))).toBe(true);
    expect(await getDemoMeta()).toEqual(meta);
    expect(await publicFacts()).toEqual(before);
  }, 180000);
});
