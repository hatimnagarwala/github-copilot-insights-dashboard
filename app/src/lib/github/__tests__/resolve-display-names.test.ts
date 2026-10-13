import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ config: vi.fn(), users: vi.fn() }));
vi.mock("@/lib/db/settings", () => ({ getGitHubConfig: mocks.config }));
vi.mock("@/lib/demo/data-mode", () => ({ isDemoMode: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/demo/fixtures", () => ({ getDemoUsers: mocks.users }));

afterEach(() => {
  vi.restoreAllMocks();
  mocks.config.mockReset();
  mocks.users.mockReset().mockResolvedValue([
    { userId: 90000001, login: "demo-user", displayName: "Demo User" },
  ]);
});

describe("demo display-name resolution", () => {
  it("resolves logins and numeric user IDs without calling GitHub", async () => {
    vi.resetModules();
    mocks.users.mockResolvedValue([{ userId: 90000001, login: "demo-user", displayName: "Demo User" }]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { resolveUserNames } = await import("../resolve-display-names");
    const names = await resolveUserNames(["demo-user", "90000001"]);
    expect(names.name("demo-user")).toBe("Demo User");
    expect(names.name("90000001")).toBe("Demo User");
    expect(names.label("demo-user")).toBe("Demo User (demo-user)");
    expect(mocks.config).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns login-keyed display names in resolveDisplayNames", async () => {
    vi.resetModules();
    mocks.users.mockResolvedValue([{ userId: 90000001, login: "demo-user", displayName: "Demo User" }]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { resolveDisplayNames } = await import("../resolve-display-names");
    await expect(resolveDisplayNames(["DEMO-USER"], "unused")).resolves.toEqual(
      new Map([["DEMO-USER", "Demo User"]]),
    );
    expect(mocks.config).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
