import { connection, NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { runNextQueuedWorkflow } from "../../../../lib/workflow-runtime";

export async function POST(_request: NextRequest) {
  await connection();
  // demo 模式只读：公开演示站不允许任何人触发后台 worker。
  if (isDemoMode()) {
    return NextResponse.json({ error: "demo mode is read-only" }, { status: 403 });
  }

  const result = await runNextQueuedWorkflow();
  return NextResponse.json(result);
}

// Vercel Cron / system cron hit scheduled endpoints with GET; reuse POST.
export async function GET(request: NextRequest) {
  return POST(request);
}
