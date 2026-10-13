import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const DAY_MS = 86_400_000;

/** Absolute path to the committed demo fixtures (`app/demo-data`). */
export function getDemoDataDir(): string {
  const candidates = [
    process.env.DEMO_DATA_DIR,
    path.join(process.cwd(), "demo-data"),
    path.join(process.cwd(), "app", "demo-data"),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/** Read a fixture file, transparently gunzipping `*.gz`. */
export async function readDemoFile(name: string): Promise<string> {
  const buf = await readFile(path.join(getDemoDataDir(), name));
  return name.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
}

export async function readDemoJson<T>(name: string): Promise<T> {
  return JSON.parse(await readDemoFile(name)) as T;
}

export async function readDemoNdjson<T>(name: string): Promise<T[]> {
  const text = await readDemoFile(name);
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

/** Whole days between the fixture anchor and `today` (UTC). */
export function computeDayOffset(anchorDate: string, today: Date = new Date()): number {
  const anchor = Date.parse(`${anchorDate}T00:00:00Z`);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((todayUtc - anchor) / DAY_MS);
}

/** Shift a `YYYY-MM-DD` date by `days`. */
export function shiftDate(date: string, days: number): string {
  if (days === 0) return date;
  const t = Date.parse(`${date}T00:00:00Z`) + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/** Shift an ISO timestamp by `days`, preserving its time-of-day. */
export function shiftTimestamp(ts: string, days: number): string {
  if (days === 0) return ts;
  return new Date(Date.parse(ts) + days * DAY_MS).toISOString();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Deep-copy `value`, shifting every `YYYY-MM-DD` date string and ISO timestamp
 * string by `days`. Keys listed in `skipKeys` are copied unchanged.
 */
export function shiftDatesDeep<T>(value: T, days: number, skipKeys: ReadonlySet<string> = new Set()): T {
  if (days === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (DATE_RE.test(v)) return shiftDate(v, days);
      if (TIMESTAMP_RE.test(v)) return shiftTimestamp(v, days);
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v)) {
        out[k] = skipKeys.has(k) ? child : walk(child);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
