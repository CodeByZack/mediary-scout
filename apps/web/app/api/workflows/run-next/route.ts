import { connection, NextResponse, type NextRequest } from "next/server";
import { runNextQueuedWorkflow } from "../../../../lib/workflow-runtime";

export async function POST(_request: NextRequest) {
  await connection();

  const result = await runNextQueuedWorkflow();
  return NextResponse.json(result);
}

// Vercel Cron / system cron hit scheduled endpoints with GET; reuse POST.
export async function GET(request: NextRequest) {
  return POST(request);
}
