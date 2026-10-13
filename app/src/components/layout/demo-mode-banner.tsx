"use client";

import { FlaskConical } from "lucide-react";
import { useTranslation } from "@/lib/i18n/locale-provider";
import { useDataMode } from "@/lib/demo/use-data-mode";

/** Sticky amber notice shown above every page while the app serves demo data. */
export function DemoModeBanner() {
  const { t } = useTranslation();
  const { mode, demo } = useDataMode();

  if (mode !== "demo") return null;

  return (
    <div
      role="status"
      className="sticky top-0 z-30 flex items-center gap-2 border-b border-amber-300 bg-amber-100 px-6 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/40 dark:text-amber-200"
    >
      <FlaskConical className="h-4 w-4 shrink-0" aria-hidden="true" />
      <p>{t("demoMode.bannerText", demo?.users ?? 50)}</p>
    </div>
  );
}
