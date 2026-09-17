import { NextResponse } from "next/server";
import { hasLoginPassword } from "../../../lib/workflow-runtime";

/**
 * Returns whether the single-user password has been set.
 * Used by the login page to decide between showing login vs password setup.
 */
export async function GET() {
  const passwordSet = (await hasLoginPassword()) !== false;
  return NextResponse.json({ passwordSet });
}
