import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEMO_ANCHOR_DATE, DEMO_DAYS, DEMO_FEATURES, DEMO_IDES, DEMO_LANGUAGES,
  DEMO_MODELS, DEMO_SEED, generateDemoData, mulberry32, serializeDemoFiles,
} from "../generate";
import type { DemoDataset } from "../generate";
import type { CopilotUsageRecord } from "@/types/copilot-api";
import {
  extractAiAdoptionPhase, transformToFactUsage, transformToFactFeatures,
  transformToFactIdes, transformToFactIdeVersions, transformToFactLanguages,
  transformToFactModels, transformToFactLanguageModels, transformToFactCli,
  transformToFactOrgAggregate, transformToFactOrgAdoptionPhase, transformToFactOrgPrCommentTypes,
} from "@/lib/etl/transform";

const activityFields = [
  "user_initiated_interaction_count", "code_generation_activity_count", "code_acceptance_activity_count",
  "loc_suggested_to_add_sum", "loc_suggested_to_delete_sum", "loc_added_sum", "loc_deleted_sum",
] as const;

let data: DemoDataset;
beforeAll(() => { data = generateDemoData(); }, 15_000);

function assertNumericCoverage(rows: object[], excluded: string[] = []) {
  expect(rows.length).toBeGreaterThan(0);
  const totals = new Map<string, number>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (excluded.includes(key)) continue;
      if (typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value))) {
        if (!Number.isFinite(Number(value))) throw new Error(`Non-finite ${key}`);
        totals.set(key, (totals.get(key) ?? 0) + Number(value));
      }
    }
  }
  for (const [key, total] of totals) expect(total, key).toBeGreaterThan(0);
}

describe("deterministic demo generator", () => {
  it("reproduces the complete dataset and serialized bytes, including gzip", () => {
    const second = generateDemoData();
    expect(second).toEqual(data);
    const firstFiles = serializeDemoFiles(data);
    const secondFiles = serializeDemoFiles(second);
    for (const name of Object.keys(firstFiles)) expect(firstFiles[name].equals(secondFiles[name]), name).toBe(true);
    expect(Object.keys(firstFiles)).toHaveLength(9);
    expect(data.manifest.seed).toBe(DEMO_SEED);
    expect(data.manifest.anchorDate).toBe(DEMO_ANCHOR_DATE);
    for (const name of Object.keys(firstFiles).filter((name) => name !== "manifest.json")) expect(data.manifest.files[name]).toBeTruthy();
    const ndjson = gunzipSync(firstFiles["usage.ndjson.gz"]).toString("utf8").trim().split("\n");
    expect(ndjson.map((line) => JSON.parse(line))).toEqual(data.usage);
    for (const [name, bytes] of Object.entries(firstFiles)) {
      if (name.endsWith(".json") && bytes.length >= 2_000_000) expect(bytes.toString("utf8").split("\n")).toHaveLength(2);
    }
  }, 20_000);

  it("uses seeded mulberry32 rather than ambient random state", () => {
    const first = mulberry32(DEMO_SEED);
    const second = mulberry32(DEMO_SEED);
    const different = mulberry32(DEMO_SEED + 1);
    const values = Array.from({ length: 100 }, first);
    expect(values).toEqual(Array.from({ length: 100 }, second));
    expect(values).not.toEqual(Array.from({ length: 100 }, different));
    expect(values.every((n) => n >= 0 && n < 1)).toBe(true);
    expect(generateDemoData(DEMO_SEED + 1).usage).not.toEqual(data.usage);
  }, 15_000);

  it("has fifty synthetic seats, three organizations, five teams and 180 distinct days", () => {
    expect(data.users).toHaveLength(50);
    expect(data.seats).toHaveLength(50);
    expect(new Set(data.users.map((u) => u.userId)).size).toBe(50);
    expect(data.users.every((u) => u.userId >= 90000001 && u.login.startsWith("demo-") && u.displayName)).toBe(true);
    expect(data.orgs.map((org) => data.users.filter((u) => u.orgLogin === org.login).length)).toEqual([25, 15, 10]);
    expect(data.enterpriseTeams).toHaveLength(5);
    expect(data.enterpriseTeams.every((t) => t.members.length >= 5)).toBe(true);
    expect(new Set(data.enterpriseTeams.flatMap((t) => t.members)).size).toBe(50);
    for (const user of data.users) {
      expect(data.enterpriseTeams.some((t) => t.slug === user.teams[0] && t.members.includes(user.userId))).toBe(true);
    }
    const days = [...new Set(data.usage.map((r) => r.day))].sort();
    expect(days).toHaveLength(DEMO_DAYS);
    expect(days.at(-1)).toBe(DEMO_ANCHOR_DATE);
    expect((Date.parse(days.at(-1)!) - Date.parse(days[0])) / 86_400_000).toBe(DEMO_DAYS - 1);
    expect(new Set(data.usage.map((r) => `${r.day}|${r.user_id}`)).size).toBe(data.usage.length);
  });

  it("models dormant seats, churn, onboarding, weekday rhythm, growth and spikes", () => {
    expect(new Set(data.users.map((u) => u.persona)).size).toBe(7);
    for (const user of data.users) {
      const usage = data.usage.filter((r) => r.user_id === user.userId);
      const seat = data.seats.find((s) => s.assignee.id === user.userId)!;
      expect(usage.every((r) => r.day >= user.licenseAssignedDate)).toBe(true);
      if (user.persona === "dormant") {
        expect(usage).toHaveLength(0);
        expect(seat.last_activity_at).toBeNull();
      } else {
        expect(usage.length).toBeGreaterThan(0);
        expect(seat.last_activity_at?.slice(0, 10)).toBe(usage.at(-1)!.day);
      }
      if (user.persona === "churned") {
        expect(usage.at(-1)!.day < "2026-08-01").toBe(true);
        expect(seat.pending_cancellation_date).toBeTruthy();
      }
      if (user.persona === "completions-only") expect(usage.every((r) => !r.used_chat && !r.used_agent && !r.used_cli)).toBe(true);
    }
    expect(data.users.some((u) => u.licenseAssignedDate > data.usage[0].day)).toBe(true);
    const days = [...new Set(data.usage.map((r) => r.day))];
    const totals = days.map((day) => ({ day, rows: data.usage.filter((r) => r.day === day) }));
    const isWeekend = (day: string) => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
    const average = (rows: typeof totals) => rows.reduce((n, r) => n + r.rows.length, 0) / rows.length;
    expect(average(totals.filter((r) => !isWeekend(r.day)))).toBeGreaterThan(average(totals.filter((r) => isWeekend(r.day))) * 2);
    const generations = (rows: typeof totals) => rows.reduce((n, d) => n + d.rows.reduce((m, r) => m + r.code_generation_activity_count, 0), 0);
    expect(generations(totals.slice(-30))).toBeGreaterThan(generations(totals.slice(0, 30)));
    const dailyGenerations = totals.map((d) => generations([d]));
    expect(Math.max(...dailyGenerations)).toBeGreaterThan(dailyGenerations.reduce((a, b) => a + b) / dailyGenerations.length * 2);
  });

  it("keeps all activity and LOC totals consistent across breakdowns and flags", () => {
    for (const r of data.usage) {
      const all = [r, ...r.totals_by_feature, ...r.totals_by_ide, ...r.totals_by_language_feature, ...r.totals_by_model_feature, ...r.totals_by_language_model];
      for (const row of all) {
        expect(row.code_acceptance_activity_count).toBeLessThanOrEqual(row.code_generation_activity_count);
        expect(row.loc_added_sum ?? 0).toBeLessThanOrEqual(row.loc_suggested_to_add_sum ?? 0);
        expect(row.loc_deleted_sum ?? 0).toBeLessThanOrEqual(row.loc_suggested_to_delete_sum ?? 0);
      }
      for (const rows of [r.totals_by_feature, r.totals_by_ide, r.totals_by_language_feature, r.totals_by_model_feature]) {
        for (const field of activityFields) expect(rows.reduce((n, row) => n + (row[field] ?? 0), 0)).toBe(r[field]);
      }
      const has = (name: string) => r.totals_by_feature.some((f) => f.feature === name);
      expect(r.used_cli).toBe(has("cli"));
      expect(r.used_cli).toBe(Boolean(r.totals_by_cli));
      expect(r.used_copilot_cloud_agent).toBe(has("cloud_agent"));
      expect(r.used_copilot_coding_agent).toBe(has("cloud_agent"));
      expect(r.used_copilot_code_review_active).toBe(has("code_review"));
      if (r.used_copilot_code_review_passive) expect(has("code_review")).toBe(true);
      expect(r.used_chat).toBe(r.totals_by_feature.some((f) => f.feature.startsWith("chat_panel_")));
      expect(r.used_agent).toBe(r.totals_by_feature.some((f) => ["chat_panel_agent_mode", "agent_edit", "chat_panel_custom_mode", "chat_panel_edit_mode"].includes(f.feature)));
      if (r.totals_by_cli) {
        const c = r.totals_by_cli;
        expect(c.token_usage.avg_tokens_per_request).toBe((c.token_usage.prompt_tokens_sum + c.token_usage.output_tokens_sum) / c.request_count);
      }
    }
  });

  it("covers every dimension, activity/LOC field, CLI token/version field and adoption phase", () => {
    const dimensions = [
      [DEMO_FEATURES, data.usage.flatMap((r) => r.totals_by_feature.map((f) => f.feature))],
      [DEMO_IDES, data.usage.flatMap((r) => r.totals_by_ide.map((f) => f.ide))],
      [DEMO_LANGUAGES, data.usage.flatMap((r) => r.totals_by_language_feature.map((f) => f.language))],
      [DEMO_MODELS, data.usage.flatMap((r) => r.totals_by_model_feature.map((f) => f.model))],
    ] as const;
    for (const [expected, actual] of dimensions) expect([...new Set(actual)].sort()).toEqual([...expected].sort());
    for (const feature of DEMO_FEATURES) assertNumericCoverage(data.usage.flatMap((r) => r.totals_by_feature).filter((f) => f.feature === feature));
    assertNumericCoverage(data.usage.flatMap((r) => r.totals_by_ide));
    assertNumericCoverage(data.usage.flatMap((r) => r.totals_by_language_feature));
    assertNumericCoverage(data.usage.flatMap((r) => r.totals_by_language_model));
    assertNumericCoverage(data.usage.flatMap((r) => r.totals_by_model_feature));
    assertNumericCoverage(data.usage.flatMap((r) => r.totals_by_cli ? [r.totals_by_cli] : []));
    assertNumericCoverage(data.usage.flatMap((r) => r.totals_by_cli ? [r.totals_by_cli.token_usage] : []));
    expect([...new Set(data.usage.map((r) => extractAiAdoptionPhase(r.ai_adoption_phase).phase))].sort()).toEqual([0, 1, 2, 3]);
    const flags: (keyof CopilotUsageRecord)[] = ["used_agent", "used_chat", "used_cli", "used_copilot_coding_agent", "used_copilot_cloud_agent", "used_copilot_code_review_active", "used_copilot_code_review_passive"];
    for (const flag of flags) expect(data.usage.some((r) => r[flag]), flag).toBe(true);
    expect(data.usage.every((r) => r.totals_by_ide.every((i) => i.last_known_ide_version?.ide_version && i.last_known_plugin_version?.plugin_version))).toBe(true);
  });

  it("feeds every existing transform without errors and populates every numeric fact metric", () => {
    assertNumericCoverage(data.usage.map(transformToFactUsage));
    const transforms: ((record: CopilotUsageRecord) => object[])[] = [transformToFactFeatures, transformToFactIdes, transformToFactIdeVersions,
      transformToFactLanguages, transformToFactModels, transformToFactLanguageModels, transformToFactCli];
    for (const transform of transforms) assertNumericCoverage(data.usage.flatMap((r) => transform(r)));
    assertNumericCoverage(data.orgAggregates.map(transformToFactOrgAggregate));
    assertNumericCoverage(data.orgAggregates.flatMap(transformToFactOrgAdoptionPhase));
    assertNumericCoverage(data.orgAggregates.flatMap(transformToFactOrgPrCommentTypes));
    // The reference's raw_json queries read these paths directly, bypassing transforms.
    for (const r of data.usage) {
      for (const rows of [r.totals_by_feature, r.totals_by_model_feature, r.totals_by_language_feature]) {
        expect(rows.every((row) => activityFields.every((key) => typeof row[key] === "number"))).toBe(true);
      }
    }
  });

  it("derives enterprise/org aggregates and phase/PR children consistently", () => {
    expect(data.orgAggregates).toHaveLength(180 * 4);
    for (const agg of data.orgAggregates) {
      expect(agg.monthly_active_users).toBeGreaterThanOrEqual(agg.weekly_active_users!);
      expect(agg.weekly_active_users).toBeGreaterThanOrEqual(agg.daily_active_users!);
      const daily = data.usage.filter((r) => r.day === agg.day && (agg._scope === "enterprise" || r._orgLogin === agg._orgLogin));
      expect(agg.daily_active_users).toBe(daily.length);
      for (const field of activityFields) expect(agg[field]).toBe(daily.reduce((n, r) => n + r[field], 0));
      expect(agg.totals_by_ai_adoption_phase!.reduce((n, p) => n + p.total_engaged_users, 0)).toBe(daily.length);
      const pr = agg.pull_requests!;
      expect(pr.total_merged!).toBeLessThanOrEqual(pr.total_created!);
      expect(pr.total_merged_created_by_copilot!).toBeLessThanOrEqual(pr.total_created_by_copilot!);
      expect(pr.total_copilot_applied_suggestions!).toBeLessThanOrEqual(pr.total_copilot_suggestions!);
      expect(agg.totals_by_ai_adoption_phase!.reduce((n, p) => n + p.total_pull_requests_merged!, 0)).toBe(pr.total_merged);
      expect(pr.copilot_suggestions_by_comment_type!.reduce((n, p) => n + p.total_copilot_suggestions!, 0)).toBe(pr.total_copilot_suggestions);
      expect(pr.copilot_suggestions_by_comment_type!.reduce((n, p) => n + p.total_copilot_applied_suggestions!, 0)).toBe(pr.total_copilot_applied_suggestions);
    }
  });

  it("provides seven daily billing periods with additive quantities and amounts", () => {
    expect(data.premiumRequests.periods).toHaveLength(7);
    expect(new Set(data.aiCreditUsage.map((r) => `${r.periodYear}-${r.periodMonth}`)).size).toBe(7);
    const credits = new Map<string, number>();
    for (const row of data.aiCreditUsage) {
      expect(row.periodYear).toBe(Number(row.usageDate!.slice(0, 4)));
      expect(row.periodMonth).toBe(Number(row.usageDate!.slice(5, 7)));
      expect(row.grossQuantity).toBe(row.discountQuantity + row.netQuantity);
      expect(row.grossAmount).toBeCloseTo(row.discountAmount + row.netAmount, 8);
      expect(row.grossAmount).toBeCloseTo(row.pricePerUnit * row.grossQuantity, 8);
      expect(row.orgName && row.userLogin && row.teamName && row.costCenter && row.model).toBeTruthy();
      const key = `${row.usageDate}|${row.userLogin}`;
      credits.set(key, (credits.get(key) ?? 0) + row.grossQuantity);
    }
    for (const r of data.usage) expect(credits.get(`${r.day}|${r.user_login}`)).toBe(r.ai_credits_used);
    assertNumericCoverage(data.aiCreditUsage);
    for (const period of data.premiumRequests.periods) {
      for (const seat of data.seats) {
        const includedCredits = data.aiCreditUsage.filter((r) => r.periodYear === period.year && r.periodMonth === period.month && r.userLogin === seat.assignee.login).reduce((n, r) => n + r.discountQuantity, 0);
        const promo = period.year === 2026 && period.month >= 6 && period.month <= 8;
        const creditQuota = (seat.plan_type === "business" ? (promo ? 30 : 19) : (promo ? 70 : 39)) * 100;
        expect(includedCredits).toBeLessThanOrEqual(creditQuota);
        const includedPremium = period.usageItems.filter((r) => r.user === seat.assignee.login).reduce((n, r) => n + r.grossQuantity - r.netQuantity, 0);
        expect(includedPremium).toBeLessThanOrEqual(seat.plan_type === "business" ? 300 : 1000);
      }
    }
    for (const period of data.premiumRequests.periods) {
      expect(period.usageItems.length).toBeGreaterThan(0);
      for (const row of period.usageItems) {
        expect(row.date.startsWith(`${period.year}-${String(period.month).padStart(2, "0")}`)).toBe(true);
        expect(row.organizationName && row.repositoryName && row.user && row.team && row.sku).toBeTruthy();
        expect(row.netQuantity).toBeLessThanOrEqual(row.grossQuantity);
        expect(row.grossAmount).toBeCloseTo(row.discountAmount + row.netAmount, 8);
      }
    }
    assertNumericCoverage(data.premiumRequests.periods.flatMap((p) => p.usageItems));
    expect(new Set(data.seats.map((s) => s.plan_type))).toEqual(new Set(["business", "enterprise"]));
    expect(data.seats.some((s) => s.assigning_team)).toBe(true);
    expect(data.seats.some((s) => !s.assigning_team && s.organization)).toBe(true);
    expect(data.orgs.map((org) => data.seats.filter((s) => s.organization?.login === org.login).length)).toEqual([25, 15, 10]);
  });

  it("backs every Metrics Reference source with a populated fixture", () => {
    const reference = readFileSync(resolve(process.cwd(), "src", "app", "reference", "page.tsx"), "utf8");
    const entries = reference.slice(reference.indexOf("const METRICS:"), reference.indexOf("/* ──", reference.indexOf("const METRICS:") + 1));
    const sources = [...entries.matchAll(/source: "([^"]+)"/g)].map((match) => match[1]);
    expect(sources.length).toBeGreaterThan(100);
    const covered = /fact_copilot_usage_daily|fact_user_(?:feature|model|language|language_model|ide|ide_version)_daily|fact_cli_daily|fact_org_aggregate_daily|fact_ai_credit_usage|raw_copilot_usage|dim_model|dim_enterprise_team|GitHub API: .*\/(?:seats|premium_requests|ai_credit\/usage)|Derived from|Calculated from/;
    for (const source of sources) expect(covered.test(source), source).toBe(true);
  });
});
