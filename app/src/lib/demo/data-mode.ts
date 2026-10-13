import { eq } from "drizzle-orm";
import { liveDb } from "@/lib/db/clients";
import { appSettings } from "@/lib/db/schema";

export type DataMode = "live" | "demo";

const REFRESH_INTERVAL_MS = 30_000;
type ModeState = {
  mode: DataMode;
  refreshedAt: number;
  revision: number;
  pending?: Promise<DataMode>;
  timer?: ReturnType<typeof setInterval>;
};
const globals = globalThis as typeof globalThis & {
  copilotDataMode?: ModeState;
};
const state = (globals.copilotDataMode ??= {
  mode: "live",
  refreshedAt: 0,
  revision: 0,
});

function startBackgroundRefresh(): void {
  if (typeof window !== "undefined" || state.timer) return;
  state.timer = setInterval(() => {
    void refreshDataMode().catch((error: unknown) => {
      console.warn("Data mode background refresh failed:", error);
    });
  }, REFRESH_INTERVAL_MS);
  state.timer.unref();
}

export function getDataModeSync(): DataMode {
  return state.mode;
}

export async function refreshDataMode(): Promise<DataMode> {
  startBackgroundRefresh();
  if (state.pending) return state.pending;
  const revision = state.revision;
  const pending = (async () => {
    const rows = await liveDb.select({ value: appSettings.value })
      .from(appSettings).where(eq(appSettings.key, "data_mode")).limit(1);
    // A read already in flight must not overwrite a newer local switch.
    if (state.revision === revision) {
      state.mode = rows[0]?.value === "demo" ? "demo" : "live";
      state.refreshedAt = Date.now();
    }
    return state.mode;
  })();
  state.pending = pending;
  try {
    return await pending;
  } finally {
    if (state.pending === pending) state.pending = undefined;
  }
}

export async function getDataMode(): Promise<DataMode> {
  startBackgroundRefresh();
  if (state.refreshedAt === 0 || Date.now() - state.refreshedAt >= REFRESH_INTERVAL_MS) {
    return refreshDataMode();
  }
  return state.mode;
}

export async function setDataMode(mode: DataMode): Promise<void> {
  if (mode !== "live" && mode !== "demo") throw new Error("Invalid data mode");
  const updatedAt = new Date();
  await liveDb.insert(appSettings).values({ key: "data_mode", value: mode, updatedAt })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: mode, updatedAt } });
  state.revision++;
  state.mode = mode;
  state.refreshedAt = Date.now();
}

export async function isDemoMode(): Promise<boolean> {
  return (await getDataMode()) === "demo";
}
