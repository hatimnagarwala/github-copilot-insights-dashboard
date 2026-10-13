"use client";

import { useEffect, useState } from "react";
import { Database, FlaskConical, Loader2, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n/locale-provider";
import { useDataMode, switchDataMode, type DataMode } from "@/lib/demo/use-data-mode";

/**
 * Whether the current browser session holds admin rights: either no admin
 * password is configured, or the user has unlocked Settings this session
 * (mirrors the logic in `AdminGate`).
 */
export function useIsAdminSession(): boolean | null {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/verify-admin")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed to check admin auth"))))
      .then((data: { required: boolean }) => {
        if (!active) return;
        setIsAdmin(!data.required || sessionStorage.getItem("admin_authenticated") === "true");
      })
      .catch(() => {
        if (active) setIsAdmin(sessionStorage.getItem("admin_authenticated") === "true");
      });
    return () => {
      active = false;
    };
  }, []);

  return isAdmin;
}

const OPTIONS: Array<{ value: DataMode; labelKey: string; icon: typeof Database }> = [
  { value: "live", labelKey: "demoMode.live", icon: Database },
  { value: "demo", labelKey: "demoMode.demo", icon: FlaskConical },
];

/**
 * Segmented Live/Demo switch. Admins can switch (the page reloads afterwards);
 * everyone else sees a read-only indicator.
 */
export function DataModeToggle({
  size = "sm",
  canSwitch,
  className,
}: {
  size?: "sm" | "md";
  /** Override admin detection (e.g. inside the admin-gated Settings area). */
  canSwitch?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const { mode, loading } = useDataMode();
  const detectedAdmin = useIsAdminSession();
  const isAdmin = canSwitch ?? detectedAdmin === true;
  const [pending, setPending] = useState<DataMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const select = async (next: DataMode) => {
    if (!isAdmin) {
      setError(t("demoMode.onlyAdmins"));
      return;
    }
    if (next === mode || pending) return;
    setError(null);
    setPending(next);
    const result = await switchDataMode(next);
    if (result.ok) {
      window.location.reload();
      return;
    }
    setPending(null);
    setError(result.reason === "forbidden" ? t("demoMode.onlyAdmins") : t("demoMode.switchFailed"));
  };

  const readOnlyHint = !isAdmin ? t("demoMode.onlyAdmins") : undefined;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div
        role="radiogroup"
        aria-label={t("demoMode.dataSource")}
        title={readOnlyHint}
        className={cn(
          "inline-flex w-full items-center rounded-full border border-gray-200 bg-gray-100 p-0.5 dark:border-gray-600 dark:bg-gray-700/60",
          loading && "opacity-60",
        )}
      >
        {OPTIONS.map((opt) => {
          const selected = mode === opt.value;
          const Icon = pending === opt.value ? Loader2 : opt.icon;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={!isAdmin || loading || pending !== null}
              disabled={loading || pending !== null}
              onClick={() => void select(opt.value)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1 rounded-full font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500",
                size === "sm" ? "px-2 py-0.5 text-xs" : "px-4 py-1.5 text-sm",
                selected
                  ? opt.value === "demo"
                    ? "bg-amber-400 text-amber-950 shadow-xs dark:bg-amber-500 dark:text-amber-950"
                    : "bg-white text-gray-900 shadow-xs dark:bg-gray-900 dark:text-gray-100"
                  : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200",
                !isAdmin && !selected && "cursor-not-allowed hover:text-gray-500 dark:hover:text-gray-400",
              )}
            >
              <Icon
                className={cn(
                  size === "sm" ? "h-3 w-3" : "h-4 w-4",
                  pending === opt.value && "animate-spin",
                )}
                aria-hidden="true"
              />
              {t(opt.labelKey)}
              {!isAdmin && selected && (
                <Lock className={size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3"} aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
