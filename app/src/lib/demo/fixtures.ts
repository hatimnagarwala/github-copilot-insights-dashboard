import { readDemoJson, shiftDatesDeep, computeDayOffset } from "@/lib/demo/files";

interface DemoUser {
  userId: number;
  login: string;
  displayName: string;
  orgLogin: string;
  teams: string[];
  licenseAssignedDate: string;
}

interface DemoManifest {
  anchorDate: string;
  enterprise: { id: number; slug: string };
}

interface DemoSeat {
  created_at: string;
  updated_at: string;
  pending_cancellation_date: string | null;
  last_activity_at: string | null;
  last_activity_editor: string | null;
  last_authenticated_at: string | null;
  plan_type: string;
  assignee: { id: number; login: string };
  assigning_team: { id: number; name: string; slug: string } | null;
  organization?: { id: number; login: string };
}

interface PremiumUsageItem {
  date: string;
  [key: string]: unknown;
}

interface PremiumPeriod {
  year: number;
  month: number;
  usageItems: PremiumUsageItem[];
}

interface PremiumFixture {
  anchorDate: string;
  periods: PremiumPeriod[];
}

const cache = globalThis as typeof globalThis & {
  copilotDemoFixtureCache?: {
    manifest?: Promise<DemoManifest>;
    users?: Promise<DemoUser[]>;
    rawSeats?: Promise<DemoSeat[]>;
    rawPremium?: Promise<PremiumFixture>;
    seats?: Map<number, Promise<DemoSeat[]>>;
    premium?: Map<number, Promise<PremiumPeriod[]>>;
  };
};
const fixtures = (cache.copilotDemoFixtureCache ??= {});

function cached<T>(map: Map<number, Promise<T>>, key: number, load: () => Promise<T>): Promise<T> {
  const existing = map.get(key);
  if (existing) return existing;
  const pending = load().catch((error: unknown) => {
    map.delete(key);
    throw error;
  });
  map.set(key, pending);
  return pending;
}

export function getDemoManifest(): Promise<DemoManifest> {
  return (fixtures.manifest ??= readDemoJson<DemoManifest>("manifest.json"));
}

export function getDemoUsers(): Promise<DemoUser[]> {
  return (fixtures.users ??= readDemoJson<DemoUser[]>("users.json"));
}

export async function getDemoDayOffset(): Promise<number> {
  const manifest = await getDemoManifest();
  return computeDayOffset(manifest.anchorDate);
}

export async function getDemoSeats(): Promise<DemoSeat[]> {
  const offset = await getDemoDayOffset();
  const seatsCache = (fixtures.seats ??= new Map());
  return cached(seatsCache, offset, async () => {
    const rows = await (fixtures.rawSeats ??= readDemoJson<DemoSeat[]>("seats.json"));
    return shiftDatesDeep(rows, offset);
  });
}

export function shiftAndRegroupPremiumPeriods(
  periods: PremiumPeriod[],
  offset: number,
): PremiumPeriod[] {
  const shifted = shiftDatesDeep(periods.flatMap((period) => period.usageItems), offset);
  const grouped = new Map<string, PremiumUsageItem[]>();
  for (const item of shifted) {
    const [yearText, monthText] = item.date.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    const key = `${year}-${month}`;
    const rows = grouped.get(key) ?? [];
    rows.push(item);
    grouped.set(key, rows);
  }
  return Array.from(grouped, ([key, usageItems]) => {
    const [year, month] = key.split("-").map(Number);
    return { year, month, usageItems };
  }).sort((a, b) => a.year - b.year || a.month - b.month);
}

export async function getDemoPremiumPeriods(): Promise<PremiumPeriod[]> {
  const offset = await getDemoDayOffset();
  const premiumCache = (fixtures.premium ??= new Map());
  return cached(premiumCache, offset, async () => {
    const fixture = await (fixtures.rawPremium ??= readDemoJson<PremiumFixture>("premium-requests.json.gz"));
    return shiftAndRegroupPremiumPeriods(fixture.periods, offset);
  });
}
