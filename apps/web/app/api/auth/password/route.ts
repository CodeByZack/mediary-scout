import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import {
  hasLoginPassword,
  setSingleUserPassword,
  clearSingleUserPassword,
  requireAuthenticatedAccountId,
} from "../../../../lib/workflow-runtime";

/**
 * 设置/更新/清除访问密码。
 *
 * 授权模型：**已设密码后**，改密与清密都必须是已认证请求
 * （`requireAuthenticatedAccountId()` 对远程无 session 会抛错；局域网视为可信）。
 * 尚未设密码时实例本来就全开放，首次设置无从要求凭据。
 */
export async function POST(request: NextRequest) {
  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    password?: unknown;
    clear?: unknown;
  };

  // 已设密码 → 后续变更必须已认证。状态读不出来（"unknown"）时同样要求认证，
  // 宁可让本地用户多登录一次，也不能让远程匿名请求清掉密码。
  if ((await hasLoginPassword()) !== false) {
    await requireAuthenticatedAccountId();
  }

  if (body.clear === true) {
    await clearSingleUserPassword();
    return NextResponse.json({ ok: true, passwordSet: false });
  }

  const password = typeof body.password === "string" ? body.password : "";
  const result = await setSingleUserPassword(password);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, passwordSet: true });
}
