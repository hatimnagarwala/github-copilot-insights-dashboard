import { gzipSync } from "node:zlib";
import type {
  CopilotUsageRecord,
  CopilotAggregateRecord,
  TotalsByFeature,
} from "@/types/copilot-api";
import type { CopilotSeat } from "@/lib/github/copilot-api";
import type { NormalizedAiCreditItem } from "@/lib/db/ai-credit-usage";

export const DEMO_SEED = 20261012;
export const DEMO_ANCHOR_DATE = "2026-10-12";
export const DEMO_DAYS = 180;
export const DEMO_ENTERPRISE = { id: 999001, slug: "demo-enterprise" } as const;
export const DEMO_FEATURES = [
  "code_completion", "chat_panel_ask_mode", "chat_panel_inline_mode",
  "chat_panel_edit_mode", "chat_panel_agent_mode", "chat_panel_custom_mode",
  "chat_panel_plan_mode", "agent_edit", "cli", "code_review", "cloud_agent",
] as const;
export const DEMO_IDES = ["vscode", "jetbrains", "visualstudio", "neovim", "xcode"] as const;
export const DEMO_LANGUAGES = [
  "typescript", "javascript", "python", "csharp", "java", "go",
  "rust", "ruby", "php", "swift", "kotlin", "sql",
] as const;
export const DEMO_MODELS = [
  "gpt-4.1", "gpt-4o", "gpt-5-mini", "gpt-5", "gpt-5.2-codex",
  "claude-sonnet-4", "claude-sonnet-4.5", "claude-opus-4.6",
  "gemini-2.5-pro", "gemini-3.1-pro",
] as const;

export type DemoPersona = "power-agent" | "chat-heavy" | "completions-only" | "cli" | "occasional" | "dormant" | "churned";
export interface DemoUser {
  userId: number;
  login: string;
  displayName: string;
  orgLogin: string;
  teams: string[];
  persona: DemoPersona;
  licenseAssignedDate: string;
}
export interface DemoOrg { githubOrgId: number; login: string }
export interface DemoTeam { githubTeamId: number; name: string; slug: string; description: string; members: number[] }
export interface DemoAiCreditRow extends NormalizedAiCreditItem {
  enterpriseSlug: string;
  periodYear: number;
  periodMonth: number;
}
export interface DemoPremiumItem {
  date: string;
  organizationName: string;
  repositoryName: string;
  user: string;
  team: string;
  sku: string;
  unitType: string;
  grossQuantity: number;
  grossAmount: number;
  discountAmount: number;
  netQuantity: number;
  netAmount: number;
}
export interface DemoPremiumPeriod { year: number; month: number; usageItems: DemoPremiumItem[] }
export interface DemoManifest {
  version: number;
  anchorDate: string;
  seed: number;
  enterprise: { id: number; slug: string };
  users: number;
  days: number;
  files: Record<string, string>;
  notes: string[];
}
export interface DemoDataset {
  manifest: DemoManifest;
  users: DemoUser[];
  orgs: DemoOrg[];
  enterpriseTeams: DemoTeam[];
  usage: CopilotUsageRecord[];
  orgAggregates: CopilotAggregateRecord[];
  seats: CopilotSeat[];
  aiCreditUsage: DemoAiCreditRow[];
  premiumRequests: { anchorDate: string; periods: DemoPremiumPeriod[] };
}

/** Fixed unsigned 32-bit PRNG: no clock, locale, or external state. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let n = Math.imul(state ^ (state >>> 15), state | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const dateAt = (offset: number) => new Date(Date.parse(`${DEMO_ANCHOR_DATE}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
const timestamp = (day: string) => `${day}T16:30:00Z`;
const NAMES = [
  "Alice Chen", "Ben Patel", "Carla Rivera", "Daniel Okafor", "Elena Rossi",
  "Farah Ahmed", "George Kim", "Hana Suzuki", "Isaac Brown", "Julia Martin",
  "Kai Nguyen", "Lena Fischer", "Marco Silva", "Nadia Ali", "Owen Clarke",
  "Priya Shah", "Quinn Murphy", "Rosa Garcia", "Sam Wilson", "Tara Singh",
  "Uma Das", "Victor Santos", "Wendy Liu", "Xavier Dupont", "Yara Hassan",
  "Zane Brooks", "Amara Nwosu", "Bruno Costa", "Chloe Laurent", "Diego Torres",
  "Emma Jensen", "Felix Weber", "Grace Park", "Hugo Moreau", "Imani James",
  "Jonah Reed", "Keiko Tanaka", "Lucas Meyer", "Maya Kapoor", "Noah Evans",
  "Olivia Wright", "Pavel Novak", "Rina Sato", "Sofia Mendes", "Theo Anders",
  "Aisha Khan", "Boris Ivanov", "Celia Ruiz", "Darius Bell", "Eva Nielsen",
];
const PERSONAS: DemoPersona[] = [
  ...Array<DemoPersona>(12).fill("power-agent"), ...Array<DemoPersona>(10).fill("chat-heavy"),
  ...Array<DemoPersona>(10).fill("completions-only"), ...Array<DemoPersona>(7).fill("cli"),
  ...Array<DemoPersona>(5).fill("occasional"), ...Array<DemoPersona>(3).fill("dormant"),
  ...Array<DemoPersona>(3).fill("churned"),
];
const METRIC_KEYS = [
  "user_initiated_interaction_count", "code_generation_activity_count", "code_acceptance_activity_count",
  "loc_suggested_to_add_sum", "loc_suggested_to_delete_sum", "loc_added_sum", "loc_deleted_sum",
] as const;
type Activity = Required<Omit<TotalsByFeature, "feature">>;
function sumActivity(rows: Partial<Activity>[]): Activity {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, rows.reduce((sum, r) => sum + (r[key] ?? 0), 0)])) as unknown as Activity;
}
function phaseFor(user: DemoUser, dayIndex: number): number {
  if (user.persona === "occasional") return 0;
  if (user.persona === "power-agent") return dayIndex < 70 ? 2 : 3;
  if (user.persona === "cli") return dayIndex < 110 ? 1 : 2;
  if (user.persona === "chat-heavy" && dayIndex > 100) return 2;
  return 1;
}
function featureNames(persona: DemoPersona, random: () => number): string[] {
  if (persona === "completions-only") return ["code_completion"];
  if (persona === "occasional" || persona === "churned") return ["code_completion", "chat_panel_ask_mode"];
  if (persona === "cli") return ["cli", "code_completion", "chat_panel_agent_mode"];
  if (persona === "chat-heavy") return ["chat_panel_ask_mode", "chat_panel_inline_mode", "chat_panel_plan_mode", "chat_panel_edit_mode"];
  return ["code_completion", "chat_panel_agent_mode", "agent_edit", "chat_panel_custom_mode", "chat_panel_ask_mode",
    ...(random() < 0.38 ? ["cloud_agent"] : []), ...(random() < 0.5 ? ["code_review"] : []),
    ...(random() < 0.3 ? ["cli"] : [])];
}
function makeUsage(users: DemoUser[], orgs: DemoOrg[], teams: DemoTeam[], random: () => number): CopilotUsageRecord[] {
  const records: CopilotUsageRecord[] = [];
  const onCallUsers = users.filter((u) => u.persona === "power-agent" && u.licenseAssignedDate <= dateAt(1 - DEMO_DAYS));
  for (let dayIndex = 0; dayIndex < DEMO_DAYS; dayIndex++) {
    const day = dateAt(dayIndex - DEMO_DAYS + 1);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      if (user.persona === "dormant" || day < user.licenseAssignedDate || (user.persona === "churned" && dayIndex > 105)) continue;
      const chance = user.persona === "occasional" ? 0.25 : user.persona === "power-agent" ? 0.94 : 0.78;
      // One rotating on-call power user keeps weekends represented without zero-activity fact rows.
      if (user.userId !== onCallUsers[dayIndex % onCallUsers.length].userId && random() > chance * (weekend ? 0.23 : 1) * (0.65 + dayIndex / DEMO_DAYS * 0.35)) continue;
      const growth = (0.7 + dayIndex / DEMO_DAYS * 0.6) * (weekend ? 0.45 : 1) * (dayIndex % 43 === 20 ? 2.4 : 1);
      const features = featureNames(user.persona, random).map((feature) => {
        const generations = Math.max(2, Math.round((10 + random() * (feature === "code_completion" ? 85 : 38)) * growth));
        const acceptances = Math.max(1, Math.floor(generations * (0.35 + random() * 0.5)));
        const suggested = generations * (feature === "code_completion" ? 3 : 12);
        const suggestedDelete = Math.max(1, Math.round(suggested * 0.18));
        return {
          feature, user_initiated_interaction_count: Math.max(1, Math.round(generations * (feature === "code_completion" ? 0.08 : 0.85))),
          code_generation_activity_count: generations, code_acceptance_activity_count: acceptances,
          loc_suggested_to_add_sum: suggested, loc_suggested_to_delete_sum: suggestedDelete,
          loc_added_sum: Math.floor(suggested * acceptances / generations),
          loc_deleted_sum: Math.floor(suggestedDelete * acceptances / generations),
        };
      });
      const languageFeatures = features.map((f, j) => ({ ...f, language: DEMO_LANGUAGES[(i + j + Math.floor(dayIndex / 21)) % DEMO_LANGUAGES.length] }));
      const modelFeatures = features.map((f, j) => ({ ...f, model: f.feature === "code_completion" ? DEMO_MODELS[i % 3] : DEMO_MODELS[(i + j + Math.floor(dayIndex / 14)) % DEMO_MODELS.length] }));
      const languageModels = new Map<string, { language: string; model: string } & Activity>();
      features.forEach((f, j) => {
        const language = languageFeatures[j].language;
        const model = modelFeatures[j].model;
        const key = `${language}|${model}`;
        languageModels.set(key, { language, model, ...sumActivity([languageModels.get(key) ?? {}, f]) });
      });
      const totals = sumActivity(features);
      const ide = DEMO_IDES[i % DEMO_IDES.length];
      const cli = features.find((f) => f.feature === "cli");
      const has = (name: string) => features.some((f) => f.feature === name);
      records.push({
        day, report_start_day: day, report_end_day: day, enterprise_id: String(DEMO_ENTERPRISE.id),
        organization_id: String(orgs.find((o) => o.login === user.orgLogin)!.githubOrgId),
        user_id: user.userId, user_login: user.login, _orgLogin: user.orgLogin,
        _teamGithubId: teams.find((t) => t.slug === user.teams[0])!.githubTeamId,
        ...totals, used_agent: features.some((f) => ["chat_panel_agent_mode", "agent_edit", "chat_panel_custom_mode", "chat_panel_edit_mode"].includes(f.feature)),
        used_copilot_coding_agent: has("cloud_agent"), used_copilot_cloud_agent: has("cloud_agent"),
        used_chat: features.some((f) => f.feature.startsWith("chat_panel_")), used_cli: Boolean(cli),
        used_copilot_code_review_active: has("code_review"),
        used_copilot_code_review_passive: has("code_review") && (i + dayIndex) % 2 === 0,
        ai_credits_used: totals.code_generation_activity_count * 4 + totals.user_initiated_interaction_count * 3,
        ai_adoption_phase: { phase: phaseFor(user, dayIndex), version: "2026-05-29" },
        totals_by_feature: features, totals_by_language_feature: languageFeatures,
        totals_by_model_feature: modelFeatures, totals_by_language_model: [...languageModels.values()],
        totals_by_ide: [{
          ide, ...totals,
          last_known_ide_version: { ide_version: ["1.102.0", "2026.1", "17.14", "0.11.0", "26.0"][i % 5], sampled_at: timestamp(day) },
          last_known_plugin_version: { plugin: "github.copilot", plugin_version: i % 9 === 0 ? "1.310.0" : `1.${330 + Math.floor(dayIndex / 30)}.0`, sampled_at: timestamp(day) },
        }],
        ...(cli ? { totals_by_cli: {
          session_count: Math.max(1, Math.ceil(cli.user_initiated_interaction_count / 5)),
          request_count: cli.user_initiated_interaction_count,
          prompt_count: cli.user_initiated_interaction_count + 2,
          last_known_cli_version: { cli_version: i % 3 === 0 ? "1.0.20" : "1.0.68", sampled_at: timestamp(day) },
          token_usage: { prompt_tokens_sum: cli.user_initiated_interaction_count * 1200,
            output_tokens_sum: cli.user_initiated_interaction_count * 640, avg_tokens_per_request: 1840 },
        } } : {}),
      });
    }
  }
  return records;
}

interface UserPr { created: number; reviewed: number; merged: number; authored: number; copilotReviewed: number; authoredMerged: number; reviewedMerged: number }
function userPr(r: CopilotUsageRecord): UserPr {
  const created = Math.floor(r.code_generation_activity_count / 65);
  const reviewed = Math.floor(r.user_initiated_interaction_count / 25);
  const merged = Math.floor(created * 0.75);
  const authored = r.used_copilot_cloud_agent ? Math.min(created, 1 + Math.floor(created / 2)) : 0;
  const copilotReviewed = r.used_copilot_code_review_active ? reviewed : 0;
  return { created, reviewed, merged, authored, copilotReviewed,
    authoredMerged: Math.min(merged, Math.floor(authored * 0.8)), reviewedMerged: Math.floor(copilotReviewed * 0.7) };
}
function makeAggregates(records: CopilotUsageRecord[], orgs: DemoOrg[]): CopilotAggregateRecord[] {
  const result: CopilotAggregateRecord[] = [];
  for (const org of [null, ...orgs]) {
    const scoped = org ? records.filter((r) => r._orgLogin === org.login) : records;
    for (let dayIndex = 0; dayIndex < DEMO_DAYS; dayIndex++) {
      const day = dateAt(dayIndex - DEMO_DAYS + 1);
      const daily = scoped.filter((r) => r.day === day);
      const window = (days: number) => scoped.filter((r) => r.day >= dateAt(dayIndex - DEMO_DAYS + 2 - days) && r.day <= day);
      const weekly = window(7);
      const monthly = window(28);
      const active = (rows: CopilotUsageRecord[], flag?: keyof CopilotUsageRecord) => new Set(rows.filter((r) => !flag || r[flag]).map((r) => r.user_id)).size;
      const prs = daily.map(userPr);
      const prSum = (key: keyof UserPr) => prs.reduce((n, pr) => n + pr[key], 0);
      const suggestions = prs.reduce((n, pr) => n + pr.copilotReviewed * 3, 0);
      const commentTypes = ["bug", "style", "security", "performance"].map((comment_type, i) => ({
        comment_type, total_copilot_suggestions: Math.floor(suggestions / 4) + (i < suggestions % 4 ? 1 : 0),
        total_copilot_applied_suggestions: Math.floor((Math.floor(suggestions / 4) + (i < suggestions % 4 ? 1 : 0)) * 0.65),
      }));
      const applied = commentTypes.reduce((n, c) => n + c.total_copilot_applied_suggestions, 0);
      result.push({
        day, enterprise_id: String(DEMO_ENTERPRISE.id), ...(org ? { organization_id: String(org.githubOrgId), _orgLogin: org.login } : {}),
        _scope: org ? "organization" : "enterprise",
        daily_active_users: active(daily), weekly_active_users: active(weekly), monthly_active_users: active(monthly),
        monthly_active_agent_users: active(monthly, "used_agent"), monthly_active_chat_users: active(monthly, "used_chat"),
        daily_active_cli_users: active(daily, "used_cli"),
        daily_active_copilot_cloud_agent_users: active(daily, "used_copilot_cloud_agent"),
        weekly_active_copilot_cloud_agent_users: active(weekly, "used_copilot_cloud_agent"),
        monthly_active_copilot_cloud_agent_users: active(monthly, "used_copilot_cloud_agent"),
        daily_active_copilot_code_review_users: active(daily, "used_copilot_code_review_active"),
        weekly_active_copilot_code_review_users: active(weekly, "used_copilot_code_review_active"),
        monthly_active_copilot_code_review_users: active(monthly, "used_copilot_code_review_active"),
        daily_passive_copilot_code_review_users: active(daily, "used_copilot_code_review_passive"),
        weekly_passive_copilot_code_review_users: active(weekly, "used_copilot_code_review_passive"),
        monthly_passive_copilot_code_review_users: active(monthly, "used_copilot_code_review_passive"),
        ...sumActivity(daily),
        totals_by_cli: (() => {
          const cli = daily.flatMap((r) => r.totals_by_cli ? [r.totals_by_cli] : []);
          const requests = cli.reduce((n, c) => n + c.request_count, 0);
          const prompt = cli.reduce((n, c) => n + c.token_usage.prompt_tokens_sum, 0);
          const output = cli.reduce((n, c) => n + c.token_usage.output_tokens_sum, 0);
          return { session_count: cli.reduce((n, c) => n + c.session_count, 0), request_count: requests,
            prompt_count: cli.reduce((n, c) => n + c.prompt_count, 0),
            token_usage: { prompt_tokens_sum: prompt, output_tokens_sum: output, avg_tokens_per_request: requests ? (prompt + output) / requests : 0 } };
        })(),
        totals_by_ai_adoption_phase: [0, 1, 2, 3].map((phase) => {
          const cohort = daily.filter((r) => typeof r.ai_adoption_phase === "object" && r.ai_adoption_phase?.phase === phase);
          const totals = sumActivity(cohort);
          const cohortPrs = cohort.map(userPr);
          const mean = (n: number) => cohort.length ? round2(n / cohort.length) : 0;
          const prTotal = (key: keyof UserPr) => cohortPrs.reduce((n, pr) => n + pr[key], 0);
          return { phase: `Phase ${phase}`, phase_number: phase, total_engaged_users: cohort.length,
            total_pull_requests_merged: prTotal("merged"),
            avg_user_initiated_interactions: mean(totals.user_initiated_interaction_count),
            avg_code_generation_activities: mean(totals.code_generation_activity_count),
            avg_code_acceptance_activities: mean(totals.code_acceptance_activity_count),
            avg_loc_added: mean(totals.loc_added_sum), avg_loc_deleted: mean(totals.loc_deleted_sum),
            avg_pull_requests_created: mean(prTotal("created")), avg_pull_requests_merged: mean(prTotal("merged")),
            avg_pull_requests_reviewed: mean(prTotal("reviewed")), avg_pull_requests_median_minutes_to_merge: cohort.length ? 240 - phase * 40 + dayIndex % 31 : 0 };
        }),
        pull_requests: { total_created: prSum("created"), total_reviewed: prSum("reviewed"), total_merged: prSum("merged"),
          median_minutes_to_merge: daily.length ? 190 + dayIndex % 60 : 0,
          total_suggestions: suggestions + prSum("reviewed"), total_applied_suggestions: applied + Math.floor(prSum("reviewed") * 0.5),
          total_created_by_copilot: prSum("authored"), total_reviewed_by_copilot: prSum("copilotReviewed"),
          total_merged_created_by_copilot: prSum("authoredMerged"), total_merged_reviewed_by_copilot: prSum("reviewedMerged"),
          median_minutes_to_merge_copilot_authored: prSum("authored") ? 95 + dayIndex % 25 : 0,
          median_minutes_to_merge_copilot_reviewed: prSum("copilotReviewed") ? 120 + dayIndex % 30 : 0,
          total_copilot_suggestions: suggestions, total_copilot_applied_suggestions: applied,
          copilot_suggestions_by_comment_type: commentTypes },
      });
    }
  }
  return result;
}

export function generateDemoData(seed = DEMO_SEED): DemoDataset {
  const random = mulberry32(seed);
  const orgs: DemoOrg[] = ["web", "platform", "data"].map((name, i) => ({ githubOrgId: 999101 + i, login: `demo-contoso-${name}` }));
  const teamNames = ["Web Experience", "Design Systems", "Platform Engineering", "Developer Productivity", "Data Intelligence"];
  const enterpriseTeams: DemoTeam[] = teamNames.map((name, i) => ({ githubTeamId: 999201 + i, name: `Demo ${name}`,
    slug: `demo-${name.toLowerCase().replaceAll(" ", "-")}`, description: `Synthetic ${name.toLowerCase()} team for demo analytics.`, members: [] }));
  const users = NAMES.map((displayName, i): DemoUser => {
    // Coprime permutation spreads every persona across organizations and teams.
    const persona = PERSONAS[(i * 17) % 50];
    const teamIndex = i < 25 ? i % 2 : i < 40 ? 2 + i % 2 : 4;
    const onboardingDay = persona !== "dormant" && persona !== "churned" && i >= 40 ? (i % 2 ? 45 : 90) : -30 - i;
    const user = { userId: 90000001 + i, login: `demo-${displayName.toLowerCase().replaceAll(" ", "-")}`, displayName,
      orgLogin: orgs[i < 25 ? 0 : i < 40 ? 1 : 2].login,
      teams: [enterpriseTeams[teamIndex].slug], persona,
      licenseAssignedDate: dateAt(onboardingDay - DEMO_DAYS + 1) };
    enterpriseTeams[teamIndex].members.push(user.userId);
    return user;
  });
  const usage = makeUsage(users, orgs, enterpriseTeams, random);
  const seats: CopilotSeat[] = users.map((user, i) => {
    const last = usage.findLast((r) => r.user_id === user.userId);
    const org = orgs.find((o) => o.login === user.orgLogin)!;
    const team = enterpriseTeams.find((t) => t.slug === user.teams[0])!;
    return { created_at: timestamp(user.licenseAssignedDate), updated_at: timestamp(DEMO_ANCHOR_DATE),
      pending_cancellation_date: user.persona === "churned" ? dateAt(14) : null,
      last_activity_at: last ? timestamp(last.day) : null, last_authenticated_at: last ? timestamp(last.day) : null,
      last_activity_editor: last ? last.totals_by_ide[0].ide : null, plan_type: i % 3 === 0 ? "business" : "enterprise",
      assignee: { id: user.userId, login: user.login },
      assigning_team: i % 3 === 0 ? null : { id: team.githubTeamId, name: team.name, slug: team.slug },
      organization: { id: org.githubOrgId, login: org.login } };
  });
  const aiCreditUsage: DemoAiCreditRow[] = [];
  const periods = new Map<string, DemoPremiumPeriod>();
  const creditEntitlementUsed = new Map<string, number>();
  const premiumEntitlementUsed = new Map<string, number>();
  const seatMap = new Map(seats.map((seat) => [seat.assignee.login, seat]));
  const userMap = new Map(users.map((u) => [u.userId, u]));
  for (const r of usage) {
    const user = userMap.get(r.user_id)!;
    const year = Number(r.day.slice(0, 4));
    const month = Number(r.day.slice(5, 7));
    const team = enterpriseTeams.find((t) => t.slug === user.teams[0])!;
    const plan = seatMap.get(user.login)!.plan_type;
    const promotional = year === 2026 && month >= 6 && month <= 8;
    const creditQuota = (plan === "business" ? (promotional ? 30 : 19) : (promotional ? 70 : 39)) * 100;
    const premiumQuota = plan === "business" ? 300 : 1000;
    const entitlementKey = `${year}-${month}|${user.login}`;
    const models = new Map<string, { credits: number; requests: number }>();
    for (const f of r.totals_by_model_feature) {
      const previous = models.get(f.model) ?? { credits: 0, requests: 0 };
      models.set(f.model, { credits: previous.credits + f.code_generation_activity_count * 4 + f.user_initiated_interaction_count * 3,
        requests: previous.requests + f.code_generation_activity_count * 2 + f.user_initiated_interaction_count * 5 });
    }
    for (const [model, quantities] of models) {
      const grossQuantity = quantities.credits;
      const creditsUsed = creditEntitlementUsed.get(entitlementKey) ?? 0;
      const discountQuantity = Math.min(creditQuota - creditsUsed, Math.floor(grossQuantity * (user.persona === "power-agent" ? 0.3 : 0.65)));
      creditEntitlementUsed.set(entitlementKey, creditsUsed + discountQuantity);
      const netQuantity = grossQuantity - discountQuantity;
      aiCreditUsage.push({ enterpriseSlug: DEMO_ENTERPRISE.slug, periodYear: year, periodMonth: month, usageDate: r.day,
        product: "Copilot", sku: "copilot_ai_credits", model, costCenter: user.orgLogin.replace("demo-contoso-", "demo-cc-"),
        orgName: user.orgLogin, userLogin: user.login, teamName: team.name,
        unitType: "ai-credits", pricePerUnit: 0.01, grossQuantity, discountQuantity, netQuantity,
        grossAmount: round2(grossQuantity * 0.01), discountAmount: round2(discountQuantity * 0.01), netAmount: round2(netQuantity * 0.01) });
      const key = `${year}-${month}`;
      if (!periods.has(key)) periods.set(key, { year, month, usageItems: [] });
      const premiumUsed = premiumEntitlementUsed.get(entitlementKey) ?? 0;
      const included = Math.min(premiumQuota - premiumUsed, Math.floor(quantities.requests * 0.55));
      premiumEntitlementUsed.set(entitlementKey, premiumUsed + included);
      periods.get(key)!.usageItems.push({ date: r.day, organizationName: user.orgLogin, repositoryName: `${user.orgLogin}/demo-workbench`,
        user: user.login, team: team.name, sku: model, unitType: "requests", grossQuantity: quantities.requests,
        grossAmount: round2(quantities.requests * 0.04), discountAmount: round2(included * 0.04),
        netQuantity: quantities.requests - included, netAmount: round2((quantities.requests - included) * 0.04) });
    }
  }
  const files = {
    "users.json": "Array<{userId,login,displayName,orgLogin,teams:string[],persona,licenseAssignedDate}>; synthetic GitHub IDs, team slugs. Dates relative to manifest.anchorDate.",
    "orgs.json": "Array<{githubOrgId,login}>",
    "enterprise-teams.json": "Array<{githubTeamId,name,slug,description,members:number[]}>; members are users.json userId values.",
    "usage.ndjson.gz": "gzip UTF-8 NDJSON of CopilotUsageRecord (snake_case API fields), with _orgLogin and _teamGithubId ingestion metadata; only active user-days. All feature/IDE/language/model/CLI/version/LOC/credit/phase fields populated.",
    "org-aggregates.json.gz": "Gzipped Array<CopilotAggregateRecord>; flat API day records with _scope enterprise|organization and _orgLogin for organizations; rolling 7/28-day unique active users, activity totals, CLI totals, pull_requests, totals_by_ai_adoption_phase, and pull_requests.copilot_suggestions_by_comment_type.",
    "seats.json": "Array<CopilotSeat> in billing/seats API shape: {created_at,updated_at,pending_cancellation_date,last_activity_at,last_authenticated_at,last_activity_editor,plan_type,assignee:{id,login},assigning_team:{id,name,slug}|null,organization?:{id,login}}. Snapshot date is manifest.anchorDate; no wrapper.",
    "ai-credit-usage.json.gz": "Gzipped Array<fact_ai_credit_usage insert rows using camelCase Drizzle columns>: {enterpriseSlug,periodYear,periodMonth,usageDate,product,sku,model,costCenter,orgName,userLogin,teamName,unitType,pricePerUnit,grossQuantity,discountQuantity,netQuantity,grossAmount,discountAmount,netAmount}. Numeric columns are JSON numbers; stringify when inserting Drizzle numeric columns. No database-generated id/capturedAt. Daily rows by user/model/org/team across seven periods.",
    "premium-requests.json.gz": "Gzipped {anchorDate,periods:Array<{year,month,usageItems:Array<{date,organizationName,repositoryName,user,team,sku,unitType,grossQuantity,grossAmount,discountAmount,netQuantity,netAmount}>}>}; each period is a raw GitHub BillingUsageResponse plus year/month selectors. Model identifier is sku. Dates span the complete usage period.",
  };
  return {
    manifest: { version: 1, anchorDate: DEMO_ANCHOR_DATE, seed, enterprise: { ...DEMO_ENTERPRISE }, users: users.length, days: DEMO_DAYS, files,
      notes: [
        "All people, organizations, teams, IDs, repositories, workloads and amounts are synthetic. Never use these fixtures as billing estimates.",
        "Arrays intentionally follow the agreed loader contract without envelopes; their date anchor is manifest.anchorDate. premium-requests includes its own anchorDate.",
        "Shift ISO dates/timestamps by today minus anchorDate; derive billing periodYear/periodMonth and premium year/month from the shifted usage dates, regrouping rows if month boundaries change.",
        "Dormant users have seats but no usage records; churned users stop after day 105, and several users onboard on days 45/90. Zero-activity days are omitted because reports count fact rows as active users.",
        "PR counts are derived synthetic outcomes; median merge times are illustrative. Aggregate averages use the same daily cohort members and counts, with rounding to two decimals.",
        "Billing discounts are capped per user/month at synthetic plan entitlements ($19/$39 base, $30/$70 promotional June-August); premium discounts are capped at 300/1000 requests. Both included and additional usage are populated.",
        "Credit quantities match the per-user ai_credits_used signal for this synthetic dataset only; billing and consumption are distinct in real GitHub data.",
        "Premium fixtures include April–October 2026 for demo replay, despite the live premium API cutoff of May 2026. Demo routes must choose fixture periods rather than apply the live cutoff.",
      ] },
    users, orgs, enterpriseTeams, usage, orgAggregates: makeAggregates(usage, orgs), seats, aiCreditUsage,
    premiumRequests: { anchorDate: DEMO_ANCHOR_DATE, periods: [...periods.values()] },
  };
}

/** In-memory serialization is shared by the CLI and byte-for-byte fixture tests. */
export function serializeDemoFiles(data: DemoDataset): Record<string, Buffer> {
  const json = (value: unknown) => {
    const compact = JSON.stringify(value);
    const pretty = compact.length < 2_000_000 ? JSON.stringify(value, null, 2) : compact;
    return Buffer.from((Buffer.byteLength(pretty) < 2_000_000 ? pretty : compact) + "\n", "utf8");
  };
  return {
    "manifest.json": json(data.manifest), "users.json": json(data.users), "orgs.json": json(data.orgs),
    "enterprise-teams.json": json(data.enterpriseTeams),
    "usage.ndjson.gz": gzipSync(data.usage.map((r) => JSON.stringify(r)).join("\n") + "\n", { level: 9 }),
    "org-aggregates.json.gz": gzipSync(JSON.stringify(data.orgAggregates), { level: 9 }),
    "seats.json": json(data.seats),
    "ai-credit-usage.json.gz": gzipSync(JSON.stringify(data.aiCreditUsage), { level: 9 }),
    "premium-requests.json.gz": gzipSync(JSON.stringify(data.premiumRequests), { level: 9 }),
  };
}
