import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { factCopilotUsageDaily, ingestionLog } from "@/lib/db/schema";
import { sql, eq, desc } from "drizzle-orm";
import { safeErrorMessage } from "@/lib/auth";
import { isDemoMode } from "@/lib/demo/data-mode";
import { getDemoMeta } from "@/lib/demo/schema";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const demoMode = await isDemoMode();
    const [dateRange, lastSync, demoMeta] = await Promise.all([
      db
        .select({
          minDate: sql<string>`MIN(${factCopilotUsageDaily.day})`,
          maxDate: sql<string>`MAX(${factCopilotUsageDaily.day})`,
          totalRows: sql<number>`COUNT(*)`,
        })
        .from(factCopilotUsageDaily),
      demoMode
        ? Promise.resolve([])
        : db
            .select({
              completedAt: ingestionLog.completedAt,
              status: ingestionLog.status,
              source: ingestionLog.source,
            })
            .from(ingestionLog)
            .where(eq(ingestionLog.status, "success"))
            .orderBy(desc(ingestionLog.completedAt))
            .limit(1),
      demoMode ? getDemoMeta() : Promise.resolve(null),
    ]);

    const range = dateRange[0];
    const sync = lastSync[0];

    return NextResponse.json({
      dataStart: range?.minDate ?? null,
      dataEnd: range?.maxDate ?? null,
      totalRows: Number(range?.totalRows ?? 0),
      lastSyncAt: demoMode ? demoMeta?.loadedAt ?? range?.maxDate ?? null : sync?.completedAt ?? null,
      lastSyncSource: demoMode ? "demo" : sync?.source ?? null,
    });
  } catch (err) {
    console.error("Data range API error:", err);
    return NextResponse.json({ error: safeErrorMessage(err, "Internal server error") }, { status: 500 });
  }
}
