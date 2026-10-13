import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Database = ReturnType<typeof drizzle>;

type ClientState = { live?: Database; demo?: Database };
const globals = globalThis as typeof globalThis & {
  copilotDatabaseClients?: ClientState;
};
const clients = (globals.copilotDatabaseClients ??= {});

function getClient(mode: "live" | "demo"): Database {
  if (!clients[mode]) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    const client = postgres(connectionString, {
      max: mode === "demo" ? 5 : 10,
      idle_timeout: 20,
      connect_timeout: 10,
      ...(mode === "demo" ? { connection: { search_path: "demo,public" } } : {}),
    });
    clients[mode] = drizzle({ client, logger: process.env.NODE_ENV === "development" });
  }
  return clients[mode];
}

function lazyClient(mode: "live" | "demo"): Database {
  return new Proxy({} as Database, {
    get(_target, prop) {
      const target = getClient(mode);
      const value = Reflect.get(target, prop, target);
      // postgres-js is callable but its attached reserve/end methods must survive.
      return typeof value === "function" && prop !== "$client" ? value.bind(target) : value;
    },
  });
}

// Kept separate from routing so settings and mode reads cannot import a cycle.
export const liveDb: Database = lazyClient("live");
export const demoDb: Database = lazyClient("demo");
