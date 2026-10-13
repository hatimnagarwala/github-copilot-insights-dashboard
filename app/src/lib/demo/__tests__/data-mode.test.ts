import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/db/clients", () => ({
  liveDb: {
    select: () => ({ from: () => ({ where: () => ({ limit: mocks.read }) }) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: mocks.write }) }),
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T09:00:00Z"));
  mocks.read.mockReset().mockResolvedValue([]);
  mocks.write.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "copilotDataMode");
});

const load = () => import("../data-mode");

describe("data mode", () => {
  it("defaults synchronously to live without reading or starting a timer", async () => {
    const mode = await load();
    expect(mode.getDataModeSync()).toBe("live");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the live settings table and caches reads for 30 seconds", async () => {
    const mode = await load();
    mocks.read.mockResolvedValue([{ value: "demo" }]);
    expect(await mode.getDataMode()).toBe("demo");
    vi.setSystemTime(Date.now() + 29_999);
    expect(await mode.isDemoMode()).toBe(true);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    mocks.read.mockResolvedValue([{ value: "live" }]);
    expect(await mode.getDataMode()).toBe("live");
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("forces refresh and treats unrecognized stored values as live", async () => {
    const mode = await load();
    mocks.read.mockResolvedValue([{ value: "demo" }]);
    await mode.getDataMode();
    mocks.read.mockResolvedValue([{ value: "invalid" }]);
    expect(await mode.refreshDataMode()).toBe("live");
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("updates cache immediately after a successful upsert", async () => {
    const mode = await load();
    await mode.setDataMode("demo");
    expect(mode.getDataModeSync()).toBe("demo");
    expect(await mode.getDataMode()).toBe("demo");
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("does not change cache when persistence fails", async () => {
    const mode = await load();
    mocks.write.mockRejectedValue(new Error("unavailable"));
    await expect(mode.setDataMode("demo")).rejects.toThrow("unavailable");
    expect(mode.getDataModeSync()).toBe("live");
  });

  it("coalesces simultaneous reads without letting stale reads undo a switch", async () => {
    const mode = await load();
    let finish!: (rows: { value: string }[]) => void;
    mocks.read.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const first = mode.getDataMode();
    const second = mode.refreshDataMode();
    await mode.setDataMode("demo");
    finish([{ value: "live" }]);
    expect(await first).toBe("demo");
    expect(await second).toBe("demo");
    expect(mocks.read).toHaveBeenCalledOnce();
  });

  it("refreshes in the background and keeps only one timer across module reloads", async () => {
    const mode = await load();
    await mode.getDataMode();
    vi.resetModules();
    const reloaded = await load();
    await reloaded.getDataMode();
    expect(vi.getTimerCount()).toBe(1);
    mocks.read.mockResolvedValue([{ value: "demo" }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reloaded.getDataModeSync()).toBe("demo");
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("logs background failures and retains the last known mode", async () => {
    const mode = await load();
    await mode.setDataMode("demo");
    await mode.getDataMode();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.read.mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(warn).toHaveBeenCalledOnce();
    expect(mode.getDataModeSync()).toBe("demo");
  });
});
