import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql, desc } from "drizzle-orm";
import { factCopilotUsageDaily, ingestionLog } from "@/lib/db/schema";
import { safeErrorMessage } from "@/lib/auth";
import { isDemoMode } from "@/lib/demo/data-mode";
import { getDemoMeta } from "@/lib/demo/schema";

export const dynamic = "force-dynamic";

/** Data older than this is considered stale (last successful sync). */
const FRESHNESS_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

interface LastSync {
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  ageMs: number | null;
  stale: boolean | null;
}

export async function GET() {
  try {
    const start = Date.now();
    await db.execute(sql`SELECT 1`);
    const latencyMs = Date.now() - start;

    // Demo data has its own load timestamp; live ingestion history remains isolated.
    const demoMode = await isDemoMode();
    let lastSync: LastSync | null = null;
    if (demoMode) {
      const [meta, data] = await Promise.all([
        getDemoMeta(),
        db.select({ maxDate: sql<string>`MAX(${factCopilotUsageDaily.day})`, rows: sql<number>`COUNT(*)` })
          .from(factCopilotUsageDaily),
      ]);
      const loadedAt = meta.loadedAt ?? (Number(data[0]?.rows) > 0 && data[0]?.maxDate
        ? new Date(`${data[0].maxDate}T00:00:00.000Z`).toISOString()
        : null);
      if (loadedAt) {
        const ageMs = Date.now() - new Date(loadedAt).getTime();
        lastSync = {
          status: "success",
          startedAt: loadedAt,
          completedAt: loadedAt,
          ageMs,
          stale: ageMs > FRESHNESS_THRESHOLD_MS,
        };
      }
    }
    try {
      const [row] = demoMode ? [] : await db
        .select({
          status: ingestionLog.status,
          startedAt: ingestionLog.startedAt,
          completedAt: ingestionLog.completedAt,
        })
        .from(ingestionLog)
        .orderBy(desc(ingestionLog.startedAt))
        .limit(1);

      if (!demoMode && row) {
        const reference = row.completedAt ?? row.startedAt;
        const ageMs = reference ? Date.now() - new Date(reference).getTime() : null;
        lastSync = {
          status: row.status,
          startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
          completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
          ageMs,
          stale: ageMs === null ? null : ageMs > FRESHNESS_THRESHOLD_MS,
        };
      }
    } catch (err) {
      // ingestion_log may not exist yet on a brand-new database — don't fail the
      // overall health check just because freshness can't be determined.
      console.warn("Health check: unable to read ingestion freshness:", err);
    }

    return NextResponse.json({
      status: "healthy",
      database: "connected",
      latencyMs,
      lastSync,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Health check failed:", err);
    return NextResponse.json(
      {
        status: "unhealthy",
        database: "disconnected",
        error: safeErrorMessage(err, "Database connection failed"),
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }
}
