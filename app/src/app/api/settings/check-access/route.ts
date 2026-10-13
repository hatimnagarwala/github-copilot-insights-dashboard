import { NextResponse } from "next/server";
import { liveDb as db } from "@/lib/db";
import { githubAccessCheckSnapshot } from "@/lib/db/schema";
import { getGitHubConfig } from "@/lib/db/settings";
import { checkGitHubAccess } from "@/lib/github/access-check";
import { safeErrorMessage } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET — Probe what the saved GitHub token and enterprise slug can access.
 * Returns token identity/scopes, per-endpoint access results, and visible orgs.
 * The token itself is never returned.
 */
export async function GET() {
  try {
    const { token, enterpriseSlug } = await getGitHubConfig();

    if (!token) {
      return NextResponse.json(
        { error: "GitHub token must be configured first." },
        { status: 400 },
      );
    }

    const result = await checkGitHubAccess(token, enterpriseSlug);
    await db.insert(githubAccessCheckSnapshot).values({
      checkedAt: new Date(result.checkedAt),
      enterpriseSlug: result.enterpriseSlug,
      tokenLogin: result.token.login,
      tokenName: result.token.name,
      tokenType: result.token.type,
      tokenValid: result.token.valid,
      representativeOrg: result.representativeOrg,
      representativeTeam: result.representativeTeam,
      scopes: result.token.scopes,
      orgs: result.orgs,
      checks: result.checks,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("Access check error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to check access") },
      { status: 500 },
    );
  }
}
