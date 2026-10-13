import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDataMode, setDataMode } from "@/lib/demo/data-mode";
import { logAudit, getClientIp } from "@/lib/audit";
import { requireAdminAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  mode: z.enum(["live", "demo"]),
});

/**
 * POST /api/settings/data-mode
 * Switch the dashboard between live and demo data. Admin only.
 */
export async function POST(request: NextRequest) {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.issues },
        { status: 400 },
      );
    }

    const { mode } = parsed.data;
    const previous = await getDataMode();
    await setDataMode(mode);

    console.info(`Data mode switched: ${previous} -> ${mode}`);
    logAudit({
      action: "data_mode_changed",
      category: "settings",
      details: { from: previous, to: mode },
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ mode });
  } catch (err) {
    console.error("Data mode POST error:", err);
    return NextResponse.json({ error: "Failed to switch data mode" }, { status: 500 });
  }
}
