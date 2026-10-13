import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { liveDb } from "@/lib/db/clients";
import { readDemoJson } from "../files";
import { ensureDemoDataLoaded } from "../loader";
import { DEMO_TABLES } from "../schema";

interface Metric {
  name: string;
  page: string;
  source: string;
}
interface DatabaseCoverage {
  table: string;
  columns: string[];
  where?: SQL;
  jsonArray?: string;
}
interface Coverage {
  database?: DatabaseCoverage[];
  fixtures?: string[];
}

// Parse the actual declaration without importing the client page or executing TS.
function referenceMetrics(): Metric[] {
  const filename = path.resolve(process.cwd(), "src", "app", "reference", "page.tsx");
  const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration: ts.ArrayLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "METRICS") {
      if (!node.initializer || !ts.isArrayLiteralExpression(node.initializer)) throw new Error("METRICS must be an array literal");
      declaration = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!declaration) throw new Error("Reference page METRICS declaration not found");
  return declaration.elements.map((element) => {
    if (!ts.isObjectLiteralExpression(element)) throw new Error("Unsupported METRICS entry");
    const fields: Record<string, string> = {};
    for (const property of element.properties) {
      if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)) {
        fields[property.name.getText(source)] = property.initializer.text;
      }
    }
    if (!fields.name || !fields.page || !fields.source) throw new Error("Metric is missing name/page/source");
    return { name: fields.name, page: fields.page, source: fields.source };
  });
}

const metrics = referenceMetrics();
// METRICS has no stable id or structured columns: its unique name is the id.
const coverage: Record<string, Coverage> = {};
function map(names: string[], database: DatabaseCoverage[], fixtures?: string[]): void {
  for (const name of names) {
    if (coverage[name]) throw new Error(`Duplicate coverage mapping: ${name}`);
    coverage[name] = { database, fixtures };
  }
}
const usage = (columns: string[], where?: SQL): DatabaseCoverage => ({ table: "fact_copilot_usage_daily", columns, where });
const fact = (table: string, columns: string[], where?: SQL): DatabaseCoverage => ({ table, columns, where });
const agent = sql`${sql.identifier("used_agent")} = true`;
const cli = sql`${sql.identifier("used_cli")} = true`;
const ideAgent = sql`${agent} AND ${sql.identifier("used_copilot_coding_agent")} = false`;
const rawAgent = sql`value->>'feature' IN (${"chat_panel_agent_mode"}, ${"chat_panel_edit_mode"}, ${"chat_panel_custom_mode"}, ${"agent_edit"})`;
const agentFeature = sql`${sql.identifier("feature_id")} IN (SELECT feature_id FROM demo.dim_feature WHERE feature_name LIKE ${"%agent%"})`;
const completionFeature = sql`${sql.identifier("feature_id")} IN (SELECT feature_id FROM demo.dim_feature WHERE feature_name = ${"code_completion"})`;
const model = fact("dim_model", ["model_name"]);
const feature = fact("dim_feature", ["feature_name"]);
const language = fact("dim_language", ["language_name"]);
const interactions = ["user_initiated_interaction_count"];
const activities = ["code_generation_activity_count", "code_acceptance_activity_count"];
const loc = ["loc_suggested_to_add_sum", "loc_suggested_to_delete_sum", "loc_added_sum", "loc_deleted_sum"];

map(["IDE Active Users", "Daily Active Users", "Weekly Active Users"], [usage(["user_id"])]);
map(["Agent Adoption Rate", "Agent Users", "Agent Adoption Rate (Agent Page)", "Agent Users Over Time", "Weekly Agent Adoption Rate"], [usage(["used_agent"])]);
map(["Cloud Agent Users"], [usage(["used_copilot_cloud_agent"])]);
map(["Code Review Active Users"], [usage(["used_code_review_active"])]);
map(["Code Review Passive Users"], [usage(["used_code_review_passive"])]);
map(["Average Chat Requests per Active User"], [usage(interactions)]);
map(["Requests per Chat Mode"], [fact("fact_user_feature_daily", interactions), feature]);
map(["Code Completions (Suggested vs Accepted)", "Code Completions Acceptance Rate"], [fact("fact_user_feature_daily", activities, completionFeature)]);
map(["Most Used Chat Model", "Chat Model Usage (Donut)", "Model Usage per Chat Mode", "Model Usage by Feature"], [fact("fact_user_model_daily", interactions), model, feature]);
map(["Model Usage per Day"], [fact("fact_user_model_daily", [...interactions, "code_generation_activity_count"]), model]);
map(["Language Usage per Day", "Language Usage (Donut)"], [fact("fact_user_language_daily", activities), language]);
map(["Model Usage per Language"], [fact("fact_user_language_model_daily", activities), language, model]);
map(["LOC by Feature"], [fact("fact_user_feature_daily", loc), feature]);
map(["LOC by IDE"], [fact("fact_user_ide_daily", loc), fact("dim_ide", ["ide_name"])]);
map(["IDE Version Distribution"], [fact("fact_user_ide_version_daily", ["ide_version", "plugin_version"])]);
map(["Agent Acceptance Rate"], [usage(activities, agent)]);
map(["Agent LOC Added"], [usage(["loc_added_sum"], agent)]);
map(["Agent Mode Requests Over Time"], [fact("fact_user_feature_daily", interactions, agentFeature)]);
map(["Agent Model Usage (Donut)"], [fact("fact_user_model_daily", interactions, agentFeature), model]);
map(["Agent vs Non-Agent Code Generation"], [usage(["code_generation_activity_count"], agent), usage(["code_generation_activity_count"], sql`NOT ${agent}`)]);
map(["Top Agent Users"], [usage([...interactions, ...activities, "loc_added_sum"], agent)]);
map(["Coding Agent Users"], [usage(["used_copilot_coding_agent"])]);
map(["IDE Agent Users"], [usage(["user_id"], ideAgent)]);
map(["IDE Agent Interactions"], [usage(interactions, ideAgent)]);
map(["Coding Agent Interactions"], [usage(interactions, sql`${sql.identifier("used_copilot_coding_agent")} = true`)]);

const pr = (columns: string[]): DatabaseCoverage => fact("fact_org_aggregate_daily", columns);
map(["PRs Reviewed by Copilot", "Reviewed by Copilot"], [pr(["pr_total_reviewed_by_copilot"])]);
map(["Copilot Review Suggestions", "Copilot Suggestions", "Suggestion Apply Rate", "Copilot Suggestions Over Time", "Suggestion Outcome"], [pr(["pr_total_copilot_suggestions", "pr_total_copilot_applied_suggestions"])]);
map(["PRs Created by Copilot", "Copilot-Created PRs"], [pr(["pr_total_created_by_copilot"])]);
map(["Copilot PRs Merged", "Copilot-Created Merged"], [pr(["pr_total_merged_created_by_copilot"])]);
map(["Pull Requests Created"], [pr(["pr_total_created"])]);
map(["Pull Requests Merged"], [pr(["pr_total_merged"])]);
map(["Avg Time to Merge"], [pr(["pr_median_minutes_to_merge"])]);
map(["Avg TTM (Copilot)"], [pr(["pr_median_minutes_to_merge_copilot_authored"])]);
map(["Review Suggestions"], [pr(["pr_total_suggestions", "pr_total_applied_suggestions"])]);
map(["PRs Reviewed"], [pr(["pr_total_reviewed", "pr_total_reviewed_by_copilot"])]);
map(["PR Activity Over Time"], [pr(["pr_total_created", "pr_total_merged"])]);
map(["Copilot Impact on PRs", "Copilot vs Standard PRs"], [pr(["pr_total_created", "pr_total_created_by_copilot"])]);
map(["Time to Merge (Minutes)"], [pr(["pr_median_minutes_to_merge", "pr_median_minutes_to_merge_copilot_authored"])]);
map(["PR & Autofix by Organization"], [pr(["org_id", "pr_total_created", "pr_total_merged", "pr_total_created_by_copilot", "pr_total_reviewed_by_copilot", "pr_total_copilot_suggestions", "pr_total_copilot_applied_suggestions"]), fact("dim_org", ["org_name"])]);
map(["Copilot-Reviewed Merged"], [pr(["pr_total_merged_reviewed_by_copilot"])]);
map(["Copilot Review Activity"], [pr(["pr_total_reviewed_by_copilot", "pr_total_reviewed"])]);

map(["CLI Users", "CLI Adoption Rate", "CLI Users Over Time", "Weekly CLI Adoption Rate"], [usage(["used_cli"])]);
map(["CLI Acceptance Rate"], [usage(activities, cli)]);
map(["CLI Sessions"], [fact("fact_cli_daily", ["session_count"])]);
map(["CLI Requests"], [fact("fact_cli_daily", ["request_count"])]);
map(["CLI Prompt Tokens"], [fact("fact_cli_daily", ["prompt_tokens"])]);
map(["CLI Completion Tokens"], [fact("fact_cli_daily", ["completion_tokens"])]);
map(["Avg Tokens Per Request"], [fact("fact_cli_daily", ["total_tokens", "request_count", "avg_tokens_per_request"])]);
map(["CLI Sessions & Requests"], [fact("fact_cli_daily", ["session_count", "request_count"])]);
map(["Token Consumption"], [fact("fact_cli_daily", ["prompt_tokens", "completion_tokens"])]);
map(["CLI Version Distribution"], [fact("fact_cli_daily", ["cli_version", "session_count"])]);
map(["CLI vs Non-CLI Code Generation", "CLI vs Non-CLI Productivity"], [usage(["code_generation_activity_count"], cli), usage(["code_generation_activity_count"], sql`NOT ${cli}`)]);
map(["Top CLI Users"], [usage([...activities, "loc_added_sum"], cli), fact("fact_cli_daily", ["session_count", "request_count", "total_tokens"])]);

// Reference prose names an older JSON shape; these are the paths actually read
// by /api/metrics/code-generation (the normalized API totals_by_* arrays).
const rawLoc: DatabaseCoverage = { table: "raw_copilot_usage", columns: ["loc_added_sum", "loc_deleted_sum"], jsonArray: "totals_by_feature" };
map(["Lines of Code Changed with AI", "Agent Contribution %", "Daily Code Changes"], [usage(["loc_added_sum", "loc_deleted_sum"]), usage(["loc_added_sum", "loc_deleted_sum"], agent), rawLoc]);
map(["Avg Lines Deleted by Agent"], [usage(["loc_deleted_sum"], agent), { ...rawLoc, columns: ["loc_deleted_sum"], where: rawAgent }]);
for (const [dimension, jsonArray, label] of [
  ["feature", "totals_by_feature", "Feature"],
  ["model", "totals_by_model_feature", "Model"],
  ["language", "totals_by_language_feature", "Language"],
] as const) {
  map([`User-Initiated by ${label}`], [{ table: "raw_copilot_usage", columns: [dimension, "loc_suggested_to_add_sum", "loc_added_sum"], jsonArray,
    where: dimension === "feature" ? undefined : sql`NOT (${rawAgent})` }]);
  map([`Agent-Initiated by ${label}`], [{ table: "raw_copilot_usage", columns: [dimension, "loc_added_sum", "loc_deleted_sum"], jsonArray,
    where: rawAgent }]);
}

map(["Total Seats", "Active Users", "Inactive Users", "Monthly Cost", "Cost Per Active User", "Utilization Rate", "Seat Utilization", "Seats by Plan Type", "Monthly Cost by Plan", "Active Cost vs Enablement Opportunity", "Inactive Users Table", "Licensed Users Table"], [], ["seats.json"]);
map(["Total Premium Requests", "Consumed PRUs", "Additional Usage Requests", "Premium Utilization", "Additional Usage Cost", "Included vs Additional Usage (Donut)", "Premium Requests by Model", "Premium Requests by Organization", "Model Breakdown Table", "User Breakdown Table"], [], ["premium-requests.json.gz"]);
map(["Included Quota"], [], ["seats.json", "premium-requests.json.gz"]);
map(["Total Spend (AI Credits)", "Gross Credits", "Included Credits (Entitlement)", "Billable Credits", "Entitlement Coverage", "Effective Price per Credit", "Credit Composition (Donut)", "AI Credits by Model", "AI Credits by Cost Center", "AI Credits by Organization", "AI Credits by Team", "Daily Credit Usage Trend", "Model Breakdown Table (AI Credits)", "Cost Center Breakdown Table"], [], ["ai-credit-usage.json.gz"]);
map(["Net Spend Trend (6-Month)"], [fact("fact_ai_credit_usage", ["net_amount", "net_quantity"])], ["ai-credit-usage.json.gz"]);
map(["Efficiency Metrics"], [usage([...activities, "loc_added_sum", "used_agent"])], ["ai-credit-usage.json.gz"]);
map(["AI Credit Consumption (by user)", "User Breakdown Table (AI Credits)"], [usage(["ai_credits_used"])]);
map(["Team Breakdown Table (AI Credits)"], [usage(["ai_credits_used"]), fact("dim_enterprise_team_member", ["user_id", "team_id"])]);
map(["Total Models"], [model]);
map(["Premium vs Included Models"], [fact("dim_model", ["model_name"], sql`${sql.identifier("is_premium")} = true`), fact("dim_model", ["model_name"], sql`${sql.identifier("is_premium")} = false`)]);
map(["Users Directory"], [usage(["user_id", "user_login"])], ["seats.json"]);
map(["Enterprise Teams"], [usage(["user_id"]), fact("dim_enterprise_team", ["team_name"]), fact("dim_enterprise_team_member", ["team_id", "user_id"])]);
map(["Team Filter"], [fact("dim_enterprise_team_member", ["team_id", "user_id"])]);
map(["Cohort Distribution", "Cohort Progression Over Time", "Top Users by Cohort"], [usage(["ai_adoption_phase"])]);
map(["Agent Adoption Rate (Cohorts)"], [usage(["ai_adoption_phase"], sql`${sql.identifier("ai_adoption_phase")} IN (${2}, ${3})`)]);
map(["Per-Cohort Productivity Metrics"], [usage(["ai_adoption_phase", "ai_credits_used", ...activities, "loc_added_sum"])]);

async function checkDatabase(metric: string, target: DatabaseCoverage): Promise<void> {
  expect(DEMO_TABLES, metric).toContain(target.table);
  const table = sql`${sql.identifier("demo")}.${sql.identifier(target.table)}`;
  const from = target.jsonArray
    ? sql`${table}, jsonb_array_elements(${sql.identifier("raw_json")}->${target.jsonArray}) AS value`
    : table;
  const counts = target.columns.map((column, index) => {
    const value = target.jsonArray ? sql`value->>${column}` : sql`${sql.identifier(column)}::text`;
    // Empty JSON containers, false booleans and numeric zero are not coverage.
    const populated = sql`${value} IS NOT NULL AND ${value} NOT IN (${""}, ${"false"}, ${"null"}, ${"{}"}, ${"[]"}) AND ${value} !~ ${"^0(\\.0+)?$"}`;
    return sql`COUNT(*) FILTER (WHERE ${populated})::int AS ${sql.identifier(`c${index}`)}`;
  });
  const [result] = await liveDb.execute<Record<string, number>>(sql`
    SELECT COUNT(*)::int AS rows, ${sql.join(counts, sql`, `)} FROM ${from}
    ${target.where ? sql`WHERE ${target.where}` : sql``}
  `);
  expect(result.rows, `${metric}: demo.${target.table} matching rows`).toBeGreaterThan(0);
  for (const [index, column] of target.columns.entries()) {
    expect(result[`c${index}`], `${metric}: ZERO demo coverage for ${target.table}.${target.jsonArray ? `${target.jsonArray}.` : ""}${column}`).toBeGreaterThan(0);
  }
}

describe("reference metrics demo coverage", () => {
  it("explicitly covers every METRICS entry (including newly added metrics)", () => {
    expect(metrics.length).toBeGreaterThan(0);
    expect(new Set(metrics.map(({ name }) => name)).size).toBe(metrics.length);
    expect(Object.keys(coverage).sort()).toEqual(metrics.map(({ name }) => name).sort());
    for (const { name } of metrics) {
      expect((coverage[name].database?.length ?? 0) + (coverage[name].fixtures?.length ?? 0), name).toBeGreaterThan(0);
    }
  });

  it.each(metrics.filter(({ name }) => coverage[name]?.fixtures?.length))("$name has API fixture data", async ({ name }) => {
    for (const fixture of coverage[name].fixtures!) {
      const data = await readDemoJson<unknown>(fixture);
      if (fixture === "premium-requests.json.gz") {
        const periods = (data as { periods: { usageItems: unknown[] }[] }).periods;
        expect(periods.length, `${name}: billing periods`).toBeGreaterThan(0);
        for (const period of periods) expect(period.usageItems.length, `${name}: ${fixture}`).toBeGreaterThan(0);
      } else {
        expect(Array.isArray(data), `${name}: ${fixture} shape`).toBe(true);
        expect((data as unknown[]).length, `${name}: ZERO API fixture coverage`).toBeGreaterThan(0);
      }
    }
  });

  describe.skipIf(!process.env.DATABASE_URL)("database (integration)", () => {
    beforeAll(async () => { await ensureDemoDataLoaded(); }, 180000);
    it.each(metrics.filter(({ name }) => coverage[name]?.database?.length))("$name has populated demo columns", async ({ name }) => {
      for (const target of coverage[name].database!) await checkDatabase(name, target);
    }, 60000);
  });
});
