import { and, eq } from "drizzle-orm";
import { liveDb as db, liveDb } from "@/lib/db";
import type { EtlDatabase } from "./ingest";
import {
  dimOrg,
  dimOrgMember,
  factCopilotSeatAssignment,
} from "@/lib/db/schema";
import {
  listEnterpriseCopilotSeats,
  listEnterpriseOrgs,
  listOrgMembers,
  type CopilotSeat,
} from "@/lib/github/copilot-api";

const INSERT_BATCH_SIZE = 500;

type SyncStatus<T> =
  | ({ status: "success" } & T)
  | { status: "error"; error: string; apiRequestCount: 0 };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function toDateOnly(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null;
}

async function insertBatches<T extends Record<string, unknown>>(
  table: Parameters<typeof db.insert>[0],
  rows: T[],
  database: EtlDatabase = liveDb,
): Promise<void> {
  const db = database;
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    await db.insert(table).values(rows.slice(i, i + INSERT_BATCH_SIZE));
  }
}

function seatAssignmentMethod(seat: CopilotSeat): "team" | "organization" | "enterprise" {
  if (seat.assigning_team) return "team";
  if (seat.organization?.login) return "organization";
  return "enterprise";
}

export async function syncCopilotSeatAssignments(opts: {
  enterpriseSlug: string;
  token: string;
  snapshotDate?: string;
}): Promise<{ totalSeats: number; assignmentsSynced: number; apiRequestCount: number; snapshotDate: string }> {
  const snapshotDate = opts.snapshotDate ?? todayIso();
  const { seats, totalSeats, apiRequestCount } = await listEnterpriseCopilotSeats({
    enterpriseSlug: opts.enterpriseSlug,
    token: opts.token,
  });

  const persisted = await persistCopilotSeatAssignments({
    enterpriseSlug: opts.enterpriseSlug,
    seats,
    snapshotDate,
  });

  return { totalSeats, assignmentsSynced: persisted.assignmentsSynced, apiRequestCount, snapshotDate };
}

export async function persistCopilotSeatAssignments(opts: {
  enterpriseSlug: string;
  seats: CopilotSeat[];
  snapshotDate?: string;
}, database: EtlDatabase = liveDb): Promise<{ assignmentsSynced: number; snapshotDate: string }> {
  const db = database;
  const snapshotDate = opts.snapshotDate ?? todayIso();

  await db
    .delete(factCopilotSeatAssignment)
    .where(
      and(
        eq(factCopilotSeatAssignment.enterpriseSlug, opts.enterpriseSlug),
        eq(factCopilotSeatAssignment.snapshotDate, snapshotDate),
      ),
    );

  const rows = opts.seats.map((seat) => ({
    snapshotDate,
    enterpriseSlug: opts.enterpriseSlug,
    assigneeLogin: seat.assignee?.login ?? "unknown",
    assigneeGithubId: seat.assignee?.id ?? null,
    organizationLogin: seat.organization?.login ?? null,
    organizationGithubId: seat.organization?.id ?? null,
    assigningTeamGithubId: seat.assigning_team?.id ?? null,
    assigningTeamName: seat.assigning_team?.name ?? null,
    assigningTeamSlug: seat.assigning_team?.slug ?? null,
    assignmentMethod: seatAssignmentMethod(seat),
    planType: seat.plan_type || "unknown",
    seatCreatedAt: toDate(seat.created_at),
    seatUpdatedAt: toDate(seat.updated_at),
    pendingCancellationDate: toDateOnly(seat.pending_cancellation_date),
    lastActivityAt: toDate(seat.last_activity_at),
    lastAuthenticatedAt: toDate(seat.last_authenticated_at),
    lastActivityEditor: seat.last_activity_editor ?? null,
    rawJson: seat,
    capturedAt: new Date(),
  }));

  if (rows.length > 0) await insertBatches(factCopilotSeatAssignment, rows, database);

  return { assignmentsSynced: rows.length, snapshotDate };
}

export async function syncEnterpriseOrgMembers(opts: {
  enterpriseSlug: string;
  token: string;
}): Promise<{ orgsSynced: number; membersSynced: number; apiRequestCount: number }> {
  const { orgs, apiRequestCount: orgReq } = await listEnterpriseOrgs({
    enterpriseSlug: opts.enterpriseSlug,
    token: opts.token,
  });
  let apiRequestCount = orgReq;
  let membersSynced = 0;

  for (const org of orgs) {
    const [orgRow] = await db
      .insert(dimOrg)
      .values({ orgName: org.login, githubOrgId: org.id })
      .onConflictDoUpdate({
        target: dimOrg.orgName,
        set: { githubOrgId: org.id, updatedAt: new Date() },
      })
      .returning({ orgId: dimOrg.orgId });

    const { members, apiRequestCount: memberReq } = await listOrgMembers({
      orgLogin: org.login,
      token: opts.token,
    });
    apiRequestCount += memberReq;

    await db.delete(dimOrgMember).where(eq(dimOrgMember.orgId, orgRow.orgId));

    const rows = members.map((member) => ({
      orgId: orgRow.orgId,
      orgLogin: org.login,
      githubOrgId: org.id,
      userId: member.id,
      userLogin: member.login,
      avatarUrl: member.avatar_url ?? null,
      memberType: member.type ?? "User",
      siteAdmin: member.site_admin ?? false,
      syncedAt: new Date(),
    }));

    if (rows.length > 0) await insertBatches(dimOrgMember, rows);
    membersSynced += rows.length;
  }

  return { orgsSynced: orgs.length, membersSynced, apiRequestCount };
}

export async function syncEnterpriseContext(opts: {
  enterpriseSlug: string;
  token: string;
}): Promise<{
  seats: SyncStatus<Awaited<ReturnType<typeof syncCopilotSeatAssignments>>>;
  orgMembers: SyncStatus<Awaited<ReturnType<typeof syncEnterpriseOrgMembers>>>;
}> {
  const [seatResult, orgMembersResult] = await Promise.allSettled([
    syncCopilotSeatAssignments(opts),
    syncEnterpriseOrgMembers(opts),
  ]);
  return {
    seats: seatResult.status === "fulfilled"
      ? { status: "success", ...seatResult.value }
      : { status: "error", error: errorMessage(seatResult.reason), apiRequestCount: 0 },
    orgMembers: orgMembersResult.status === "fulfilled"
      ? { status: "success", ...orgMembersResult.value }
      : { status: "error", error: errorMessage(orgMembersResult.reason), apiRequestCount: 0 },
  };
}
