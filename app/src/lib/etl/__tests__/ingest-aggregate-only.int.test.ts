import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { liveDb as db } from "@/lib/db";
import { ingestCopilotUsage } from "@/lib/etl/ingest";
import { dimOrg, factOrgAdoptionPhaseDaily, factOrgAggregateDaily, factOrgPrCommentTypeDaily } from "@/lib/db/schema";

const DAY = "2026-06-09";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: { cancel: () => {} },
  } as unknown as Response;
}

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers: { get: () => null },
    json: async () => JSON.parse(body),
    text: async () => body,
    body: { cancel: () => {} },
  } as unknown as Response;
}

async function cleanup() {
  await db.delete(factOrgAggregateDaily).where(and(eq(factOrgAggregateDaily.day, DAY), eq(factOrgAggregateDaily.scope, "organization")));
  await db.delete(factOrgAdoptionPhaseDaily).where(and(eq(factOrgAdoptionPhaseDaily.day, DAY), eq(factOrgAdoptionPhaseDaily.scope, "organization")));
  await db.delete(factOrgPrCommentTypeDaily).where(and(eq(factOrgPrCommentTypeDaily.day, DAY), eq(factOrgPrCommentTypeDaily.scope, "organization")));
  await db.delete(dimOrg).where(eq(dimOrg.orgName, "aggregate-only-org"));
}

describe.skipIf(!process.env.DATABASE_URL)("ingestCopilotUsage aggregate-only path (integration)", () => {
  beforeEach(cleanup);
  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanup();
  });

  it("persists org aggregate rows even when the org user report has no records", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/reports/users-28-day/latest")) {
        return jsonResponse({ download_links: [] });
      }
      if (u.includes("/reports/organization-28-day/latest")) {
        return jsonResponse({ download_links: ["https://download.example/aggregate-only.ndjson"] });
      }
      if (u === "https://download.example/aggregate-only.ndjson") {
        return textResponse(
          JSON.stringify({
            organization_id: "12345",
            day_totals: [
              {
                day: DAY,
                daily_active_users: 2,
                weekly_active_users: 3,
                monthly_active_users: 4,
              },
            ],
          }) + "\n",
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await ingestCopilotUsage({
      enterpriseSlug: "enterprise",
      token: "token",
      scopes: ["organization"],
      orgLogins: ["aggregate-only-org"],
    });

    expect(result.recordsFetched).toBe(0);
    expect(result.recordsInserted).toBe(0);
    expect(result.aggregateRecords).toBe(1);

    const rows = await db
      .select({
        orgId: factOrgAggregateDaily.orgId,
        dailyActiveUsers: factOrgAggregateDaily.dailyActiveUsers,
        weeklyActiveUsers: factOrgAggregateDaily.weeklyActiveUsers,
        monthlyActiveUsers: factOrgAggregateDaily.monthlyActiveUsers,
      })
      .from(factOrgAggregateDaily)
      .where(and(eq(factOrgAggregateDaily.day, DAY), eq(factOrgAggregateDaily.scope, "organization")));

    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toEqual(expect.any(Number));
    expect(rows[0].dailyActiveUsers).toBe(2);
    expect(rows[0].weeklyActiveUsers).toBe(3);
    expect(rows[0].monthlyActiveUsers).toBe(4);
  });
});
