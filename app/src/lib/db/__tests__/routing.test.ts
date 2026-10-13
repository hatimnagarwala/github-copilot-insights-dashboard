import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ mode: "live", postgres: vi.fn(), drizzle: vi.fn() }));
vi.mock("@/lib/demo/data-mode", () => ({ getDataModeSync: () => mocks.mode }));
vi.mock("postgres", () => ({ default: mocks.postgres }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: mocks.drizzle }));

beforeEach(() => {
  vi.resetModules();
  mocks.mode = "live";
  mocks.postgres.mockReset().mockImplementation((_url, options) => Object.assign(
    vi.fn(), { options, reserve: vi.fn(), end: vi.fn() },
  ));
  mocks.drizzle.mockReset().mockImplementation(({ client }) => ({
    label: client.options.connection ? "demo" : "live",
    $client: client,
    execute(this: { label: string }) { return this.label; },
    transaction(this: { label: string }) { return this.label; },
    select(this: { label: string }) { return this.label; },
  }));
  vi.stubEnv("DATABASE_URL", "postgres://localhost/copilot_insights");
});
afterEach(() => {
  vi.unstubAllEnvs();
  Reflect.deleteProperty(globalThis, "copilotDatabaseClients");
});

describe("database routing", () => {
  it("imports without DATABASE_URL and does not create either pool eagerly", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { db } = await import("../index");
    expect(mocks.postgres).not.toHaveBeenCalled();
    expect(() => db.select()).toThrow("DATABASE_URL");
  });

  it("routes methods to the current mode and pins explicit clients", async () => {
    const { db, liveDb, demoDb } = await import("../index");
    expect(db.select()).toBe("live");
    mocks.mode = "demo";
    expect(db.select()).toBe("demo");
    expect(liveDb.select()).toBe("live");
    expect(demoDb.select()).toBe("demo");
    expect(mocks.postgres).toHaveBeenNthCalledWith(1, expect.any(String), {
      max: 10, idle_timeout: 20, connect_timeout: 10,
    });
    expect(mocks.postgres).toHaveBeenNthCalledWith(2, expect.any(String), {
      max: 5, idle_timeout: 20, connect_timeout: 10,
      connection: { search_path: "demo,public" },
    });
  });

  it("binds execute and transaction, including destructured methods", async () => {
    const { db } = await import("../index");
    mocks.mode = "demo";
    const { execute, transaction } = db;
    expect(execute.call(undefined, {} as never)).toBe("demo");
    expect(transaction.call(undefined, async () => {})).toBe("demo");
    mocks.mode = "live";
    expect(db.execute({} as never)).toBe("live");
  });

  it("preserves attached methods on the callable postgres client", async () => {
    const { db, liveDb } = await import("../index");
    expect(liveDb.$client.reserve).toBeTypeOf("function");
    expect(db.$client).toBe(liveDb.$client);
  });

  it("reuses both pools after module reload", async () => {
    const { liveDb, demoDb } = await import("../index");
    liveDb.select();
    demoDb.select();
    vi.resetModules();
    const reloaded = await import("../index");
    reloaded.liveDb.select();
    reloaded.demoDb.select();
    expect(mocks.postgres).toHaveBeenCalledTimes(2);
  });
});
