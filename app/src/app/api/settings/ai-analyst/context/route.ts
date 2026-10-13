export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { desc, sql } from "drizzle-orm";
import { liveDb as db } from "@/lib/db";
import {
  dimOrgMember,
  factCopilotSeatAssignment,
  githubAccessCheckSnapshot,
} from "@/lib/db/schema";
import { safeErrorMessage } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET — persisted enterprise context available to AI Analyst snapshots. */
export async function GET() {
  try {
    const [seatRows, memberRows, accessRows] = await Promise.all([
      db
        .select({
          snapshotDate: factCopilotSeatAssignment.snapshotDate,
          assignments: sql<number>`COUNT(*)::int`,
          uniqueAssignees: sql<number>`COUNT(DISTINCT ${factCopilotSeatAssignment.assigneeLogin})::int`,
        })
        .from(factCopilotSeatAssignment)
        .groupBy(factCopilotSeatAssignment.snapshotDate)
        .orderBy(desc(factCopilotSeatAssignment.snapshotDate))
        .limit(1),
      db
        .select({
          orgs: sql<number>`COUNT(DISTINCT ${dimOrgMember.orgId})::int`,
          members: sql<number>`COUNT(*)::int`,
          lastSyncedAt: sql<string | null>`MAX(${dimOrgMember.syncedAt})`,
        })
        .from(dimOrgMember),
      db
        .select({
          checkedAt: githubAccessCheckSnapshot.checkedAt,
          tokenValid: githubAccessCheckSnapshot.tokenValid,
          checks: githubAccessCheckSnapshot.checks,
        })
        .from(githubAccessCheckSnapshot)
        .orderBy(desc(githubAccessCheckSnapshot.checkedAt))
        .limit(1),
    ]);

    const access = accessRows[0] ?? null;
    const checks = Array.isArray(access?.checks)
      ? (access.checks as Array<{ status?: string }>)
      : [];

    return NextResponse.json({
      seats: {
        latestSnapshotDate: seatRows[0]?.snapshotDate ?? null,
        assignments: Number(seatRows[0]?.assignments ?? 0),
        uniqueAssignees: Number(seatRows[0]?.uniqueAssignees ?? 0),
      },
      orgMembers: {
        orgs: Number(memberRows[0]?.orgs ?? 0),
        members: Number(memberRows[0]?.members ?? 0),
        lastSyncedAt: memberRows[0]?.lastSyncedAt ?? null,
      },
      accessHealth: access
        ? {
            checkedAt: access.checkedAt,
            tokenValid: access.tokenValid,
            failedChecks: checks.filter((check) => check.status && check.status !== "ok").length,
          }
        : null,
    });
  } catch (err) {
    console.error("AI context GET error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to read AI context info") },
      { status: 500 },
    );
  }
}
