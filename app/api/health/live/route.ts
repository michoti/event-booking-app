// Liveness: process is up. Never touches dependencies.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
