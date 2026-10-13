export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { liveDb as db } from "@/lib/db";
import { aiInsights } from "@/lib/db/schema";
import { logAudit, getClientIp } from "@/lib/audit";
import { safeErrorMessage } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET — number of cached AI insight records + the most recent generation time. */
export async function GET() {
  try {
    const [row] = await db
      .select({
        count: sql<number>`count(*)::int`,
        lastUpdated: sql<string | null>`max(${aiInsights.createdAt})`,
      })
      .from(aiInsights);

    return NextResponse.json({
      count: row?.count ?? 0,
      lastUpdated: row?.lastUpdated ?? null,
    });
  } catch (err) {
    console.error("AI cache GET error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to read cache info") },
      { status: 500 },
    );
  }
}

/** DELETE — clear all cached AI insight narratives (they regenerate on demand). */
export async function DELETE(request: NextRequest) {
  try {
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(aiInsights);
    const cleared = row?.count ?? 0;

    await db.delete(aiInsights);

    console.info(`AI insights cache cleared (${cleared} record(s))`);
    logAudit({
      action: "ai_cache_cleared",
      category: "settings",
      details: { cleared },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ cleared });
  } catch (err) {
    console.error("AI cache DELETE error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to clear cache") },
      { status: 500 },
    );
  }
}
