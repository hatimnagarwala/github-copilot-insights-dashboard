import { readFileSync } from "node:fs";
import { describe, it, expect, afterAll } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { parseNdjson, flattenAggregateReport } from "@/lib/github/copilot-api";
import { persistOrgAggregates } from "@/lib/etl/ingest";
import { liveDb as db } from "@/lib/db";
import {
  factOrgAggregateDaily,
  factOrgAdoptionPhaseDaily,
  factOrgPrCommentTypeDaily,
} from "@/lib/db/schema";
import type { AggregateReportLine } from "@/types/copilot-api";

const read = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function fixtureRecords() {
  const lines = parseNdjson<AggregateReportLine>(read("enterprise-aggregate-28day.ndjson"));
  return flattenAggregateReport(lines, "enterprise");
}

const dayFilter = (col: typeof factOrgAggregateDaily.day) =>
  sql`${col} in ('2026-06-02','2026-06-04')`;

/**
 * Integration test for the aggregate ingest path. Requires a live Postgres;
 * skipped in the unit suite (no DATABASE_URL). Run with:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/copilot_insights \
 *     pnpm vitest run src/lib/etl/__tests__/persist-org-aggregates.int.test.ts
 */
describe.skipIf(!process.env.DATABASE_URL)("persistOrgAggregates (integration)", () => {
  afterAll(async () => {
    await db.delete(factOrgAggregateDaily).where(and(eq(factOrgAggregateDaily.scope, "enterprise"), isNull(factOrgAggregateDaily.orgId), dayFilter(factOrgAggregateDaily.day)));
    await db.delete(factOrgAdoptionPhaseDaily).where(and(eq(factOrgAdoptionPhaseDaily.scope, "enterprise"), isNull(factOrgAdoptionPhaseDaily.orgId), dayFilter(factOrgAdoptionPhaseDaily.day)));
    await db.delete(factOrgPrCommentTypeDaily).where(and(eq(factOrgPrCommentTypeDaily.scope, "enterprise"), isNull(factOrgPrCommentTypeDaily.orgId), dayFilter(factOrgPrCommentTypeDaily.day)));
  });

  async function counts() {
    const one = async (t: typeof factOrgAggregateDaily | typeof factOrgAdoptionPhaseDaily | typeof factOrgPrCommentTypeDaily) => {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(t)
        .where(and(eq(t.scope, "enterprise"), isNull(t.orgId), dayFilter(t.day)));
      return rows[0].n;
    };
    return {
      agg: await one(factOrgAggregateDaily),
      phase: await one(factOrgAdoptionPhaseDaily),
      cmt: await one(factOrgPrCommentTypeDaily),
    };
  }

  it("loads aggregate + phase + comment-type rows and is idempotent on re-ingest", async () => {
    await persistOrgAggregates(fixtureRecords(), new Map());
    const first = await counts();
    expect(first.agg).toBe(2); // 2 enterprise days
    expect(first.phase).toBe(3); // 06-02: phases 0 & 3 + 06-04: 1 phase
    expect(first.cmt).toBe(4); // 06-02: 2 + 06-04: 2 comment types

    // Re-ingest â†’ delete-then-insert keeps counts identical (no duplicates).
    await persistOrgAggregates(fixtureRecords(), new Map());
    expect(await counts()).toEqual(first);

    // New active-user column persisted.
    const [aggRow] = await db
      .select()
      .from(factOrgAggregateDaily)
      .where(and(eq(factOrgAggregateDaily.day, "2026-06-02"), eq(factOrgAggregateDaily.scope, "enterprise"), isNull(factOrgAggregateDaily.orgId)));
    expect(aggRow.weeklyActiveCloudAgentUsers).toBe(1);

    // Phase row + numeric round-trip on avg_* (stored as String, read as numeric).
    const [p3] = await db
      .select()
      .from(factOrgAdoptionPhaseDaily)
      .where(and(eq(factOrgAdoptionPhaseDaily.day, "2026-06-02"), eq(factOrgAdoptionPhaseDaily.phaseNumber, 3), isNull(factOrgAdoptionPhaseDaily.orgId)));
    expect(p3.phaseLabel).toBe("Phase 3");
    expect(Number(p3.avgPullRequestsMerged)).toBe(4);
    expect(Number(p3.avgPullRequestsMedianMinutesToMerge)).toBeCloseTo(1.58, 2);

    // Comment-type apply rate available.
    const [bug] = await db
      .select()
      .from(factOrgPrCommentTypeDaily)
      .where(and(eq(factOrgPrCommentTypeDaily.day, "2026-06-02"), eq(factOrgPrCommentTypeDaily.commentType, "bug"), isNull(factOrgPrCommentTypeDaily.orgId)));
    expect(bug.totalCopilotSuggestions).toBe(2);
    expect(bug.totalCopilotAppliedSuggestions).toBe(2);
  });
});
