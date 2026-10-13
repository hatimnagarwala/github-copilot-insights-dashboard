import { NextRequest, NextResponse } from "next/server";
import { getDataMode } from "@/lib/demo/data-mode";
import { getDemoMeta } from "@/lib/demo/schema";
import { readDemoJson, computeDayOffset, shiftDate } from "@/lib/demo/files";
import { requireDashboardAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface DemoManifest {
  version: number;
  anchorDate: string;
  users: number;
  days: number;
}

/** The manifest is a static committed fixture — cache it for the process lifetime. */
let manifestCache: Promise<DemoManifest | null> | null = null;

function loadManifest(): Promise<DemoManifest | null> {
  manifestCache ??= readDemoJson<DemoManifest>("manifest.json").catch((err: unknown) => {
    console.warn("Demo manifest unavailable:", err);
    manifestCache = null;
    return null;
  });
  return manifestCache;
}

/**
 * GET /api/data-mode
 * Returns the active data mode (live | demo) and a summary of the demo dataset.
 * Dashboard-level auth (enforced by proxy.ts and re-checked here).
 */
export async function GET(request: NextRequest) {
  const authError = requireDashboardAuth(request);
  if (authError) return authError;

  try {
    const [mode, meta, manifest] = await Promise.all([
      getDataMode(),
      getDemoMeta(),
      loadManifest(),
    ]);

    // The loader shifts every fixture date by (load day − manifest anchor), so
    // the visible window ends on the day the data was last loaded.
    let rangeStart: string | null = null;
    let rangeEnd: string | null = null;
    if (manifest && meta.loadedAt) {
      const loadedAt = new Date(meta.loadedAt);
      if (!Number.isNaN(loadedAt.getTime())) {
        rangeEnd = shiftDate(manifest.anchorDate, computeDayOffset(manifest.anchorDate, loadedAt));
        rangeStart = shiftDate(rangeEnd, -(manifest.days - 1));
      }
    }

    return NextResponse.json({
      mode,
      demo: {
        version: meta.version ?? (manifest ? String(manifest.version) : null),
        loadedAt: meta.loadedAt,
        anchor: meta.anchor,
        manifestAnchor: manifest?.anchorDate ?? null,
        users: manifest?.users ?? null,
        days: manifest?.days ?? null,
        rangeStart,
        rangeEnd,
      },
    });
  } catch (err) {
    console.error("Data mode GET error:", err);
    return NextResponse.json({ error: "Failed to read data mode" }, { status: 500 });
  }
}
