import { getDataModeSync } from "@/lib/demo/data-mode";
import { demoDb, liveDb } from "./clients";
import type { Database } from "./clients";

export { demoDb, liveDb } from "./clients";
export type { Database } from "./clients";

/** Report queries follow the cached mode; operational code must use liveDb. */
export const db: Database = new Proxy({} as Database, {
  get(_target, prop) {
    const target = getDataModeSync() === "demo" ? demoDb : liveDb;
    const value = Reflect.get(target, prop, target);
    // postgres-js is callable but its attached reserve/end methods must survive.
    return typeof value === "function" && prop !== "$client" ? value.bind(target) : value;
  },
});
