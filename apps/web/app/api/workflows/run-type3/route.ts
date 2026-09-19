import { connection, NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { runScheduledType3 } from "../../../../lib/workflow-runtime";

export async function POST(request: NextRequest) {
  await connection();
  // demo 模式只读：公开演示站不允许任何人触发巡检。
  if (isDemoMode()) {
    return NextResponse.json({ error: "demo mode is read-only" }, { status: 403 });
  }

  // `?force=1` bypasses the daily-time gate for an on-demand "sweep now"; without
  // it the sweep runs at most once per Beijing day, only after the configured
  // time — so the Settings time is authoritative however often cron pings here.
  const force = new URL(request.url).searchParams.get("force") === "1";
  const result = await runScheduledType3({ force });
  return NextResponse.json(result);
}

// Vercel Cron / system cron hit scheduled endpoints with GET; reuse POST.
export async function GET(request: NextRequest) {
  return POST(request);
}
