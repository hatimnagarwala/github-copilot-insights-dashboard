import { randomUUID } from "node:crypto";
import { count, eq, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, demoDb, liveDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getDataModeSync, refreshDataMode, setDataMode } from "../data-mode";
import type { DataMode } from "../data-mode";
import { ensureDemoDataLoaded } from "../loader";

// Explicit DATABASE_URL opt-in, matching loader.int.test.ts. All mutations are
// confined to a unique shared setting and a mode switch restored even on failure.
describe.skipIf(!process.env.DATABASE_URL)("demo mode isolation (integration)", () => {
  const settingKey = `demo-isolation-test-${randomUUID()}`;
  let originalSetting: typeof schema.appSettings.$inferSelect | undefined;
  let originalMode: DataMode;
  let capturedOriginal = false;

  async function publicFactCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of Object.values(schema)) {
      if (!is(table, PgTable) || !getTableName(table).startsWith("fact_")) continue;
      const name = getTableName(table);
      const [row] = await liveDb.execute<{ rows: number }>(sql`
        SELECT COUNT(*)::int AS rows FROM ${sql.identifier("public")}.${sql.identifier(name)}
      `);
      counts[name] = row.rows;
    }
    return counts;
  }

  async function restoreMode(): Promise<void> {
    if (!capturedOriginal) return;
    await setDataMode(originalMode);
    // Restore the exact row (including timestamps), or its original absence.
    if (originalSetting) {
      await liveDb.insert(schema.appSettings).values(originalSetting)
        .onConflictDoUpdate({ target: schema.appSettings.key, set: originalSetting });
    } else {
      await liveDb.delete(schema.appSettings).where(eq(schema.appSettings.key, "data_mode"));
    }
    await refreshDataMode();
  }

  beforeAll(async () => {
    [originalSetting] = await liveDb.select().from(schema.appSettings)
      .where(eq(schema.appSettings.key, "data_mode"));
    originalMode = originalSetting?.value === "demo" ? "demo" : "live";
    capturedOriginal = true;
    await ensureDemoDataLoaded();
  }, 180000);

  afterAll(async () => {
    try {
      await liveDb.delete(schema.appSettings).where(eq(schema.appSettings.key, settingKey));
    } finally {
      await restoreMode();
    }
  }, 30000);

  it("routes reports to demo while liveDb and shared settings remain public", async () => {
    const before = await publicFactCounts();
    expect(Object.keys(before).length).toBeGreaterThan(0);
    const publicUsers = await liveDb.select().from(schema.dimUser).orderBy(schema.dimUser.userKey);
    const [explicitPublic] = await liveDb.execute<{ rows: number }>(sql`
      SELECT COUNT(*)::int AS rows FROM ${sql.identifier("public")}.${sql.identifier("dim_user")}
    `);
    expect(publicUsers).toHaveLength(explicitPublic.rows);

    await setDataMode("demo");
    expect(getDataModeSync()).toBe("demo");
    const demoUsers = await demoDb.select().from(schema.dimUser).orderBy(schema.dimUser.userKey);
    const routedUsers = await db.select().from(schema.dimUser).orderBy(schema.dimUser.userKey);
    expect(routedUsers.length).toBeGreaterThan(0);
    expect(routedUsers).toEqual(demoUsers);
    expect(routedUsers.every((user) => user.userId >= 90000001)).toBe(true);
    expect(await liveDb.select().from(schema.dimUser).orderBy(schema.dimUser.userKey)).toEqual(publicUsers);
    expect(await db.select({ rows: count() }).from(schema.factCopilotUsageDaily))
      .toEqual(await demoDb.select({ rows: count() }).from(schema.factCopilotUsageDaily));

    const value = `public-${randomUUID()}`;
    await liveDb.insert(schema.appSettings).values({ key: settingKey, value });
    const [shared] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, settingKey));
    expect(shared?.value).toBe(value);
    const [explicitSetting] = await liveDb.execute<{ value: string }>(sql`
      SELECT value FROM ${sql.identifier("public")}.${sql.identifier("app_settings")}
      WHERE key = ${settingKey}
    `);
    expect(explicitSetting.value).toBe(value);
    const [demoShadow] = await liveDb.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = ${"demo"} AND table_name = ${"app_settings"}
      ) AS exists
    `);
    expect(demoShadow.exists).toBe(false);

    await restoreMode();
    expect(getDataModeSync()).toBe(originalMode);
    expect(await publicFactCounts()).toEqual(before);
    expect(await db.select().from(schema.dimUser).orderBy(schema.dimUser.userKey))
      .toEqual(originalMode === "demo" ? demoUsers : publicUsers);
    expect(await liveDb.select().from(schema.appSettings).where(eq(schema.appSettings.key, "data_mode")))
      .toEqual(originalSetting ? [originalSetting] : []);
  }, 30000);
});
