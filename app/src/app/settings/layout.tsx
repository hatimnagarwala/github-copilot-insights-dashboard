"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Database, ScrollText, LogOut, Info, DatabaseZap, Sparkles, KeyRound, PlugZap, LayoutDashboard, FlaskConical } from "lucide-react";
import { AdminGate } from "@/components/auth/admin-gate";
import { useTranslation } from "@/lib/i18n/locale-provider";

const tabs = [
  { labelKey: "settings.overview", href: "/settings", icon: LayoutDashboard },
  { labelKey: "settings.tokenSetup", href: "/settings/token", icon: KeyRound },
  { labelKey: "settings.apiAccess", href: "/settings/api-access", icon: PlugZap },
  { labelKey: "settings.dataSync", href: "/settings/data-sync", icon: Database },
  { labelKey: "settings.demoData", href: "/settings/demo-data", icon: FlaskConical },
  { labelKey: "settings.aiAnalyst", href: "/settings/ai-analyst", icon: Sparkles },
  { labelKey: "settings.migrations", href: "/settings/migrations", icon: DatabaseZap },
  { labelKey: "settings.auditLog", href: "/settings/audit-log", icon: ScrollText },
  { labelKey: "settings.appInfo", href: "/settings/app-info", icon: Info },
];

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { t } = useTranslation();

  return (
    <AdminGate>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{t("settings.title")}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("settings.subtitle")}
          </p>
        </div>

        {/* Tabs */}
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700">
          <div className="flex">
            {tabs.map((tab) => {
              const isActive =
                tab.href === "/settings"
                  ? pathname === "/settings"
                  : pathname.startsWith(tab.href);
              const Icon = tab.icon;
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={cn(
                    "flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
                    isActive
                      ? "border-blue-600 text-blue-600"
                      : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {t(tab.labelKey)}
                </Link>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              sessionStorage.removeItem("admin_authenticated");
              window.location.reload();
            }}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <LogOut className="h-4 w-4" />
            {t("settings.adminSignOut")}
          </button>
        </div>

        {children}
      </div>
    </AdminGate>
  );
}
