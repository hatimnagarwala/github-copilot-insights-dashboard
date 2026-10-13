import { NextRequest } from "next/server";
import { loadDemoData } from "@/lib/demo/loader";
import { logAudit, getClientIp } from "@/lib/audit";
import { requireAdminAuth, safeErrorMessage } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Only one reload may run per process — concurrent reloads would race on the demo schema. */
const globals = globalThis as typeof globalThis & { demoReloadInFlight?: boolean };

/**
 * POST /api/settings/demo-data/reload
 * Reload the synthetic demo dataset into the `demo` schema, streaming progress
 * as server-sent events (`{ type: "log" | "done" | "error", message }`). Admin only.
 */
export async function POST(request: NextRequest) {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  if (globals.demoReloadInFlight) {
    return new Response(
      JSON.stringify({ error: "A demo data reload is already running." }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  }
  globals.demoReloadInFlight = true;

  const encoder = new TextEncoder();
  const ipAddress = getClientIp(request);
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (type: string, data: string) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type, message: data })}\n\n`),
          );
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };

      // A client disconnect only stops streaming; the load itself runs to
      // completion so the demo schema is never left half-populated.
      request.signal.addEventListener("abort", close);

      const startedAt = Date.now();
      send("log", `[${new Date().toISOString()}] Demo data reload started`);

      try {
        const result = await loadDemoData({
          force: true,
          onLog: (msg) => send("log", `[${new Date().toISOString()}] ${msg}`),
        });

        const durationMs = Date.now() - startedAt;
        console.info(`Demo data reloaded in ${durationMs}ms (version ${result.version})`);
        logAudit({
          action: "demo_data_reloaded",
          category: "admin",
          details: { ...result, durationMs },
          ipAddress,
        });

        send("done", JSON.stringify({ ...result, durationMs }));
      } catch (err) {
        console.error("Demo data reload failed:", err);
        logAudit({
          action: "demo_data_reload_failed",
          category: "admin",
          ipAddress,
        });
        send("error", safeErrorMessage(err, "Demo data reload failed"));
      } finally {
        globals.demoReloadInFlight = false;
        request.signal.removeEventListener("abort", close);
        close();
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
