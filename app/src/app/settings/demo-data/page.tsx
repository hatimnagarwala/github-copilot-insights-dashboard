"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarRange,
  CheckCircle,
  Clock,
  FlaskConical,
  Info,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Tag,
  Terminal,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n/locale-provider";
import { useDataMode } from "@/lib/demo/use-data-mode";
import { DataModeToggle } from "@/components/layout/data-mode-toggle";

const AUTO_SCROLL_THRESHOLD = 160;

interface ReloadResult {
  version?: string | number;
  anchor?: string;
  offsetDays?: number;
  counts?: Record<string, number>;
  durationMs?: number;
}

function totalRows(counts: Record<string, number> | undefined): number {
  if (!counts) return 0;
  return Object.values(counts).reduce((sum, n) => sum + (typeof n === "number" ? n : 0), 0);
}

export default function DemoDataSettingsPage() {
  const { t, locale } = useTranslation();
  const { mode, demo, loading, refresh } = useDataMode();
  const [reloading, setReloading] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const fmtDateTime = (iso: string | null | undefined) => {
    if (!iso) return t("demoMode.never");
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const handleReload = async () => {
    setReloading(true);
    setLogs([]);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/demo-data/reload", { method: "POST" });
      if (!res.ok) {
        const text =
          res.status === 401 || res.status === 403
            ? t("demoMode.onlyAdmins")
            : res.status === 409
              ? t("demoMode.reloadInProgress")
              : t("demoMode.reloadFailed");
        setMessage({ type: "error", text });
        setLogs((prev) => [...prev, `✗ ${text}`]);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setMessage({ type: "error", text: t("demoMode.reloadFailed") });
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const raw of events) {
          const match = raw.match(/^data: (.+)$/);
          if (!match) continue;
          try {
            const event = JSON.parse(match[1]) as { type: string; message: string };
            if (event.type === "log") {
              setLogs((prev) => [...prev, event.message]);
            } else if (event.type === "done") {
              const result = JSON.parse(event.message) as ReloadResult;
              const rows = totalRows(result.counts).toLocaleString(locale);
              const seconds = ((result.durationMs ?? 0) / 1000).toFixed(1);
              const text = t("demoMode.reloadComplete", rows, seconds);
              setLogs((prev) => [...prev, `✓ ${text}`]);
              setMessage({ type: "success", text });
            } else if (event.type === "error") {
              setLogs((prev) => [...prev, `✗ ${event.message}`]);
              setMessage({ type: "error", text: t("demoMode.reloadFailed") });
            }
          } catch {
            /* skip malformed events */
          }
        }
      }
    } catch (err) {
      console.error("Demo data reload request failed:", err);
      setMessage({ type: "error", text: t("demoMode.reloadFailed") });
      setLogs((prev) => [...prev, `✗ ${t("auth.networkError")}`]);
    } finally {
      setReloading(false);
      void refresh();
    }
  };

  const rangeLabel =
    demo?.rangeStart && demo.rangeEnd ? `${demo.rangeStart} – ${demo.rangeEnd}` : "—";

  const summary = [
    { icon: Users, label: t("demoMode.users"), value: demo?.users != null ? String(demo.users) : "—" },
    { icon: CalendarRange, label: t("demoMode.days"), value: demo?.days != null ? String(demo.days) : "—" },
    { icon: Tag, label: t("demoMode.version"), value: demo?.version ?? "—" },
    { icon: CalendarRange, label: t("demoMode.dateRange"), value: rangeLabel },
    { icon: Clock, label: t("demoMode.lastLoaded"), value: fmtDateTime(demo?.loadedAt) },
  ];

  return (
    <div className="space-y-6">
      {message && (
        <div
          role={message.type === "error" ? "alert" : "status"}
          className={cn(
            "flex items-center gap-2 rounded-lg border px-4 py-3 text-sm",
            message.type === "success"
              ? "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-900/30 dark:text-green-300"
              : "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300",
          )}
        >
          {message.type === "success" ? <CheckCircle className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          {message.text}
        </div>
      )}

      {/* About demo data */}
      <div className="flex gap-3 rounded-lg border border-blue-100 bg-linear-to-r from-blue-50 to-indigo-50 p-4 dark:border-blue-800 dark:from-blue-900/30 dark:to-indigo-900/30">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-500 dark:text-blue-400" />
        <div>
          <p className="text-sm font-medium text-blue-900 dark:text-blue-200">{t("demoMode.aboutTitle")}</p>
          <p className="mt-1 text-xs leading-relaxed text-blue-700 dark:text-blue-300">{t("demoMode.aboutBody")}</p>
          <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-blue-700 dark:text-blue-300">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t("demoMode.isolationNote")}
          </p>
        </div>
      </div>

      {/* Current mode */}
      <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        <div className="mb-1 flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t("demoMode.currentMode")}</h2>
        </div>
        <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">{t("demoMode.switchDescription")}</p>
        <div className="flex flex-wrap items-center gap-4">
          <DataModeToggle size="md" canSwitch className="w-56" />
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {loading && !mode ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : mode === "demo" ? (
              t("demoMode.currentlyDemo")
            ) : (
              t("demoMode.currentlyLive")
            )}
          </span>
        </div>
      </div>

      {/* Dataset summary */}
      <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        <h2 className="mb-4 text-sm font-semibold text-gray-900 dark:text-gray-100">{t("demoMode.datasetSummary")}</h2>
        {loading && !demo ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {summary.map((item) => (
              <div key={item.label} className="h-14 animate-pulse rounded-md bg-gray-100 dark:bg-gray-700" />
            ))}
          </div>
        ) : (
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {summary.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.label}
                  className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-600 dark:bg-gray-700/50"
                >
                  <dt className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {item.label}
                  </dt>
                  <dd className="mt-1 text-sm font-medium text-gray-900 tabular-nums dark:text-gray-100">{item.value}</dd>
                </div>
              );
            })}
          </dl>
        )}
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{t("demoMode.dateShiftNote")}</p>
      </div>

      {/* Reload */}
      <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        <div className="mb-1 flex items-center gap-2">
          <RefreshCw className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t("demoMode.reloadTitle")}</h2>
        </div>
        <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">{t("demoMode.reloadDescription")}</p>
        <button
          type="button"
          onClick={() => void handleReload()}
          disabled={reloading}
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {reloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {reloading ? t("demoMode.reloading") : t("demoMode.reloadButton")}
        </button>

        {logs.length > 0 && (
          <div className="mt-4 rounded-md border border-gray-300 bg-gray-900 dark:border-gray-600">
            <div className="flex items-center gap-2 border-b border-gray-700 px-3 py-2">
              <Terminal className="h-3.5 w-3.5 text-gray-400" />
              <span className="text-xs font-medium text-gray-400">{t("demoMode.reloadLog")}</span>
              {reloading && <Loader2 className="ms-auto h-3 w-3 animate-spin text-green-400" />}
            </div>
            <div
              ref={logRef}
              role="log"
              aria-live="polite"
              className="scrollbar-log max-h-64 overflow-y-auto p-3 font-mono text-xs leading-5"
            >
              {logs.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.startsWith("✗")
                      ? "text-red-400"
                      : line.startsWith("✓")
                        ? "text-green-400"
                        : "text-gray-300"
                  }
                >
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
