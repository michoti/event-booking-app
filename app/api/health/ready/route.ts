import { getPool } from "@/db";

// Readiness: dependencies reachable.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await getPool().query("select 1");
    return Response.json({ status: "ready" });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
