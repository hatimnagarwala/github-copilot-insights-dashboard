import { and, count, eq, getTableName, inArray, isNull, sql } from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { pgSchema } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { demoDb } from "@/lib/db/clients";
import * as tables from "@/lib/db/schema";
import { ensureDimensions, ensureUsers, persistOrgAggregates } from "@/lib/etl/ingest";
import type { EtlDatabase } from "@/lib/etl/ingest";
import { persistCopilotSeatAssignments } from "@/lib/etl/enterprise-context";
import * as transform from "@/lib/etl/transform";
import type { CopilotUsageRecord, CopilotAggregateRecord } from "@/types/copilot-api";
import type { CopilotSeat } from "@/lib/github/copilot-api";
import type { DemoManifest, DemoUser, DemoOrg, DemoTeam, DemoAiCreditRow } from "./generate";
import { computeDayOffset, readDemoJson, readDemoNdjson, shiftDate, shiftDatesDeep } from "./files";
import { DEMO_TABLES, ensureDemoSchema, getDemoMeta, isDemoSchemaEmpty, setDemoMeta } from "./schema";

const BATCH_SIZE = 1000;

export interface DemoLoadResult {
  version: string;
  anchor: string;
  offsetDays: number;
  counts: Record<string, number>;
}

async function tableCounts(database: EtlDatabase): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const name of DEMO_TABLES) {
    const [row] = await database.select({ n: count() }).from(pgSchema("demo").table(name, {}));
    counts[name] = row.n;
  }
  return counts;
}

/** Plain inserts are intentional: all tables were truncated in this transaction. */
async function insertBatches<T extends PgTable>(
  database: EtlDatabase, table: T, rows: InferInsertModel<T>[], log: (msg: string) => void,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await database.insert(table).values(rows.slice(i, i + BATCH_SIZE));
  }
  log(`${getTableName(table)}: ${rows.length} rows`);
}

/** Resolve every fixture reference explicitly; never fall back to public IDs. */
function requireId<K>(map: Map<K, number>, key: K): number {
  const id = map.get(key);
  if (id === undefined) throw new Error(`Demo fixture references unknown dimension: ${String(key)}`);
  return id;
}

function dateDimension(day: string): typeof tables.dimDate.$inferInsert {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = date.getUTCDay();
  // ISO week number (Thursday determines the week-year).
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 4 - (weekday || 7));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return {
    dateKey: day, year: date.getUTCFullYear(), quarter: Math.ceil((date.getUTCMonth() + 1) / 3),
    month: date.getUTCMonth() + 1,
    weekOfYear: Math.ceil(((thursday.getTime() - yearStart) / 86400000 + 1) / 7),
    dayOfWeek: weekday, dayOfMonth: date.getUTCDate(), isWeekend: weekday === 0 || weekday === 6,
    monthName: date.toLocaleString("en-US", { month: "long", timeZone: "UTC" }),
    dayName: date.toLocaleString("en-US", { weekday: "long", timeZone: "UTC" }),
  };
}

export async function loadDemoData(opts: {
  onLog?: (msg: string) => void;
  force?: boolean;
} = {}): Promise<DemoLoadResult> {
  const start = Date.now();
  const log = (msg: string) => {
    console.info(`[demo] ${msg}`);
    opts.onLog?.(msg);
  };
  const { recreated } = await ensureDemoSchema();
  const manifest = await readDemoJson<DemoManifest>("manifest.json");
  const offsetDays = computeDayOffset(manifest.anchorDate);
  const anchor = shiftDate(manifest.anchorDate, offsetDays);
  const version = String(manifest.version);
  log(`Preparing demo dataset v${version}, anchor ${anchor}, offset ${offsetDays} days`);
  const [usersFile, orgs, teams, usageFile, aggregatesFile, seatsFile, creditsFile] = await Promise.all([
    readDemoJson<DemoUser[]>("users.json"),
    readDemoJson<DemoOrg[]>("orgs.json"),
    readDemoJson<DemoTeam[]>("enterprise-teams.json"),
    readDemoNdjson<CopilotUsageRecord>("usage.ndjson.gz"),
    readDemoJson<CopilotAggregateRecord[]>("org-aggregates.json.gz"),
    readDemoJson<CopilotSeat[]>("seats.json"),
    readDemoJson<DemoAiCreditRow[]>("ai-credit-usage.json.gz"),
  ]);
  const users = shiftDatesDeep(usersFile, offsetDays);
  const records = shiftDatesDeep(usageFile, offsetDays);
  const aggregates = shiftDatesDeep(aggregatesFile, offsetDays);
  const seats = shiftDatesDeep(seatsFile, offsetDays);
  const credits = shiftDatesDeep(creditsFile, offsetDays);

  const result = await demoDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(427916)`);
    // Check under the lock, so competing startup/reload calls cannot interleave.
    const meta = await getDemoMeta();
    const countsBefore = await tableCounts(tx);
    if (!opts.force && !recreated && meta.version === version && meta.anchor === anchor
      && DEMO_TABLES.every((name) => countsBefore[name] > 0)) {
      log("Demo data is already current; skipping reload");
      return { loaded: false, counts: countsBefore };
    }
    const identifiers = DEMO_TABLES.map((name) => sql`${sql.identifier("demo")}.${sql.identifier(name)}`);
    await tx.execute(sql`TRUNCATE TABLE ${sql.join(identifiers, sql`, `)} RESTART IDENTITY CASCADE`);
    const insert = <T extends PgTable>(table: T, rows: InferInsertModel<T>[]) => insertBatches(tx, table, rows, log);

    await insert(tables.dimEnterprise, [{ enterpriseId: manifest.enterprise.id, enterpriseSlug: manifest.enterprise.slug }]);
    const { orgMap, orgIdToKeyMap, ideMap, featureMap, langMap, modelMap } = await ensureDimensions(
      records, orgs.map((org) => ({ id: org.githubOrgId, login: org.login })), tx,
    );
    for (const org of orgs) {
      await tx.update(tables.dimOrg).set({ enterpriseId: manifest.enterprise.id })
        .where(eq(tables.dimOrg.orgId, requireId(orgMap, org.login)));
    }
    // Include dormant seat holders too, then reuse the live user resolution logic.
    await ensureUsers(users.map((user) => ({
      user_id: user.userId, user_login: user.login, _orgLogin: user.orgLogin,
    })), orgMap, orgIdToKeyMap, tx);
    for (const user of users) {
      await tx.update(tables.dimUser).set({
        licenseAssignedDate: user.licenseAssignedDate, effectiveFrom: user.licenseAssignedDate,
        effectiveTo: "9999-12-31", isCurrent: true, teamName: user.teams[0] ?? null,
      }).where(eq(tables.dimUser.userId, user.userId));
    }
    const orgGithubIds = new Map(orgs.map((org) => [org.login, org.githubOrgId]));
    await insert(tables.dimOrgMember, users.map((user) => ({
      orgId: requireId(orgMap, user.orgLogin), orgLogin: user.orgLogin,
      githubOrgId: orgGithubIds.get(user.orgLogin), userId: user.userId, userLogin: user.login,
    })));
    const userLogins = new Map(users.map((user) => [user.userId, user.login]));
    for (const team of teams) {
      const [row] = await tx.insert(tables.dimEnterpriseTeam).values({
        githubTeamId: team.githubTeamId, teamName: team.name, teamSlug: team.slug,
        description: team.description, enterpriseId: manifest.enterprise.id,
      }).returning({ teamId: tables.dimEnterpriseTeam.teamId });
      await insert(tables.dimEnterpriseTeamMember, team.members.map((userId) => {
        const userLogin = userLogins.get(userId);
        if (!userLogin) throw new Error(`Unknown demo team member ${userId}`);
        return { teamId: row.teamId, userId, userLogin };
      }));
    }
    for (const [name, modelId] of modelMap) {
      await tx.update(tables.dimModel).set({
        isPremium: !["gpt-4.1", "gpt-4o", "gpt-5-mini"].includes(name), isEnabled: true,
      }).where(eq(tables.dimModel.modelId, modelId));
    }
    // Cover all history, billing rows and license dates, with at least 180 days.
    const firstDay = [shiftDate(anchor, -Math.max(179, manifest.days - 1)),
      ...records.map((r) => r.day), ...credits.map((r) => r.usageDate ?? anchor),
      ...users.map((u) => u.licenseAssignedDate)].sort()[0];
    const dates = [];
    for (let day = firstDay; day <= anchor; day = shiftDate(day, 1)) dates.push(dateDimension(day));
    await insert(tables.dimDate, dates);
    await insert(tables.rawCopilotUsage, records.map((record) => ({
      reportDate: record.day, enterpriseId: parseInt(String(record.enterprise_id), 10) || 0,
      userId: record.user_id, sourceTeamGithubId: record._teamGithubId ?? null,
      rawJson: record, contentHash: transform.computeRecordHash(record),
      reportStartDay: record.report_start_day ?? null, reportEndDay: record.report_end_day ?? null,
    })));
    await insert(tables.factCopilotUsageDaily, records.map((record) => {
      const { organizationId, aiCreditsUsed, ...row } = transform.transformToFactUsage(record);
      const orgId = record._orgLogin ? requireId(orgMap, record._orgLogin)
        : organizationId ? orgMap.get(String(organizationId)) ?? requireId(orgIdToKeyMap, String(organizationId)) : null;
      return { ...row, orgId, aiCreditsUsed: String(aiCreditsUsed) };
    }));
    await insert(tables.factUserFeatureDaily, records.flatMap(transform.transformToFactFeatures).map(({ featureName, ...row }) => ({
      ...row, featureId: requireId(featureMap, featureName),
    })));
    await insert(tables.factUserIdeDaily, records.flatMap(transform.transformToFactIdes).map(({ ideName, ...row }) => ({
      ...row, ideId: requireId(ideMap, ideName),
    })));
    await insert(tables.factUserIdeVersionDaily, records.flatMap(transform.transformToFactIdeVersions).map(({ ideName, sampledAt, ...row }) => ({
      ...row, ideId: requireId(ideMap, ideName), sampledAt: sampledAt ? new Date(sampledAt) : null,
    })));
    await insert(tables.factUserLanguageDaily, records.flatMap(transform.transformToFactLanguages).map(({ languageName, featureName, ...row }) => ({
      ...row, languageId: requireId(langMap, languageName), featureId: requireId(featureMap, featureName),
    })));
    await insert(tables.factUserModelDaily, records.flatMap(transform.transformToFactModels).map(({ modelName, featureName, ...row }) => ({
      ...row, modelId: requireId(modelMap, modelName), featureId: requireId(featureMap, featureName),
    })));
    await insert(tables.factCliDaily, records.flatMap(transform.transformToFactCli));
    await insert(tables.factUserLanguageModelDaily, records.flatMap(transform.transformToFactLanguageModels).map(({ languageName, modelName, ...row }) => ({
      ...row, languageId: requireId(langMap, languageName), modelId: requireId(modelMap, modelName),
    })));
    // Fail instead of silently storing org-scoped facts with a null/public org ID.
    for (const record of aggregates) if (record._orgLogin) requireId(orgMap, record._orgLogin);
    await persistOrgAggregates(aggregates, orgMap, log, tx);
    await persistCopilotSeatAssignments({ enterpriseSlug: manifest.enterprise.slug, seats, snapshotDate: anchor }, tx);
    await insert(tables.factAiCreditUsage, credits.map((row) => {
      const usageDate = row.usageDate ?? anchor;
      return {
        ...row, usageDate, periodYear: Number(usageDate.slice(0, 4)), periodMonth: Number(usageDate.slice(5, 7)),
        pricePerUnit: String(row.pricePerUnit), grossQuantity: String(row.grossQuantity),
        discountQuantity: String(row.discountQuantity), netQuantity: String(row.netQuantity),
        grossAmount: String(row.grossAmount), discountAmount: String(row.discountAmount), netAmount: String(row.netAmount),
      };
    }));
    // ensureDimensions also inserts numeric-ID alias orgs from record organization_id;
    // every demo record resolves via _orgLogin, so drop the unused aliases from filters.
    await tx.delete(tables.dimOrg).where(and(
      isNull(tables.dimOrg.githubOrgId),
      inArray(tables.dimOrg.orgName, orgs.map((org) => String(org.githubOrgId))),
    ));
    const counts = await tableCounts(tx);
    for (const name of DEMO_TABLES) {
      if (!counts[name]) throw new Error(`Demo load left ${name} empty`);
    }
    return { loaded: true, counts };
  });
  if (result.loaded) {
    await setDemoMeta({ version, loadedAt: new Date().toISOString(), anchor });
    log(`Demo data loaded in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  }
  return { version, anchor, offsetDays, counts: result.counts };
}

/** Refresh demo fixtures only when empty, drifted, version-stale or a UTC day older. */
export async function ensureDemoDataLoaded(): Promise<void> {
  const { recreated } = await ensureDemoSchema();
  const manifest = await readDemoJson<DemoManifest>("manifest.json");
  const anchor = shiftDate(manifest.anchorDate, computeDayOffset(manifest.anchorDate));
  const meta = await getDemoMeta();
  if (recreated || await isDemoSchemaEmpty() || meta.version !== String(manifest.version) || meta.anchor !== anchor) {
    await loadDemoData({ force: recreated });
  }
}
