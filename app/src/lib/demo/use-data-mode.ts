"use client";

import { useCallback, useEffect, useState } from "react";
import type { DataMode } from "@/lib/demo/data-mode";

export type { DataMode };

/** Demo dataset summary returned by `GET /api/data-mode`. */
export interface DemoDatasetInfo {
  version: string | null;
  loadedAt: string | null;
  anchor: string | null;
  manifestAnchor: string | null;
  users: number | null;
  days: number | null;
  rangeStart: string | null;
  rangeEnd: string | null;
}

export interface DataModeResponse {
  mode: DataMode;
  demo: DemoDatasetInfo;
}

/* ── Module-level cache shared by every component on the page ── */

let cached: DataModeResponse | null = null;
let inflight: Promise<DataModeResponse | null> | null = null;
const listeners = new Set<(value: DataModeResponse | null) => void>();

function notify(value: DataModeResponse | null) {
  for (const listener of listeners) listener(value);
}

async function fetchDataMode(force = false): Promise<DataModeResponse | null> {
  if (cached && !force) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/data-mode", { cache: "no-store" });
      if (!res.ok) {
        console.warn(`Data mode request failed with status ${res.status}`);
        return cached;
      }
      const data = (await res.json()) as DataModeResponse;
      cached = data;
      notify(data);
      return data;
    } catch (err) {
      console.error("Failed to load data mode:", err);
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export type SwitchResult =
  | { ok: true; mode: DataMode }
  | { ok: false; reason: "forbidden" | "failed" };

/** Ask the server to switch the data mode (admin only). */
export async function switchDataMode(mode: DataMode): Promise<SwitchResult> {
  try {
    const res = await fetch("/api/settings/data-mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "forbidden" };
    if (!res.ok) return { ok: false, reason: "failed" };
    const data = (await res.json()) as { mode: DataMode };
    if (cached) {
      cached = { ...cached, mode: data.mode };
      notify(cached);
    }
    return { ok: true, mode: data.mode };
  } catch (err) {
    console.error("Failed to switch data mode:", err);
    return { ok: false, reason: "failed" };
  }
}

/**
 * Client hook exposing the active data mode and demo dataset summary.
 * The first caller fetches `/api/data-mode`; later callers reuse the cache.
 */
export function useDataMode() {
  const [data, setData] = useState<DataModeResponse | null>(cached);
  const [loading, setLoading] = useState(cached === null);

  useEffect(() => {
    let active = true;
    const listener = (value: DataModeResponse | null) => {
      if (active) setData(value);
    };
    listeners.add(listener);
    void fetchDataMode().then((value) => {
      if (!active) return;
      setData(value);
      setLoading(false);
    });
    return () => {
      active = false;
      listeners.delete(listener);
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    const value = await fetchDataMode(true);
    setData(value);
    setLoading(false);
    return value;
  }, []);

  return {
    mode: data?.mode ?? null,
    demo: data?.demo ?? null,
    loading,
    refresh,
  };
}
