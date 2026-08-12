import { NextResponse, type NextRequest } from "next/server";

/**
 * §7 P1 auth gate (Next 16 "proxy" convention, formerly middleware).
 *
 * 两种门禁形态：
 *  - 多用户（`MEDIA_TRACK_MULTI_USER=1`）：处处需要 session（现状不变）。
 *  - 单用户：**凡是经隧道来的远程请求都门禁**，与是否设过密码无关；局域网直通，零摩擦。
 *
 * 远程门禁不再看 `mt_auth_required`。旧规则是 `passwordSet && isRemote`，于是一台
 * 尚未设密码的实例对公网匿名访客完全放行——这与服务端 getCurrentAccountId() 修复后的
 * 判定相矛盾：服务端会返回 acct_unauthenticated 哨兵，而 proxy 却不把人送去 /login，
 * 结果远程站主看到的是一个没有任何出口的空页面。两侧必须同规则：**远程一律要 session**。
 *
 * 未设密码的远程访客因此落到 /login，那里提供「设置访问密码」表单（app/login/page.tsx）,
 * 站主可以就地设密码并登录，不会被锁死。
 *
 * This does cheap PRESENCE gating for the redirect UX (runs on the Edge runtime,
 * no DB access). The authoritative check — signature + session row + expiry — is
 * server-side in getCurrentAccountId(), which returns a no-data sentinel for an
 * invalid/expired cookie, so reads fail closed even if a stale cookie slips past.
 */
const SESSION_COOKIE_NAME = "mt_session";
const HANDLER_GUARDED_API_PREFIXES = ["/api/health", "/api/workflows/", "/api/agent/"];

/**
 * Server Actions CSRF fix (Next 16 behind a reverse proxy).
 *
 * Next 16 的 action-handler.js 对转发的 Server Action 请求做 CSRF 校验：把
 * `x-forwarded-host`（反代写入的“真实”host）与浏览器发来的 `Origin` 比对，不一致就
 * abort（E80，「点了没反应」）。反代把 x-forwarded-host 写成内网地址/飞牛子域名
 * （如 `192.168.6.194:3333`），而浏览器 Origin 是动态端口的公网反代域名
 * （如 `office.app.5ddd.com:60565`）时必然不匹配；`serverActions.allowedOrigins`
 * 匹配不了动态端口，`allowedForwardedHosts` 在 Next 16 已移除。
 *
 * 这里把 server action 请求的 `x-forwarded-host` 改写为 `Origin` 的 host，让 Next
 * 内部的 originHost === host.value 成立。只对带 `Next-Action` header 的请求生效，
 * 其它流量原样通过；不改 `host` header，也不影响下方的 auth gate。
 *
 * 注意：这是 Edge runtime，只用 Web 标准 API（Headers / URL），不能引 node 模块。
 */
function serverActionForwardedHeaders(request: NextRequest): Headers | null {
  // 只碰 Server Action 请求（浏览器对 action POST 一定带 Next-Action header）。
  if (!request.headers.has("next-action")) {
    return null;
  }
  const origin = request.headers.get("origin");
  // 无 Origin（手搓请求/非浏览器）或 "null"（sandboxed iframe）不重写——Next 对
  // 这两种有自己的处理路径（放行+警告 / originHost='null'），保持原行为。
  if (!origin || origin === "null") {
    return null;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // 畸形 Origin：Next 自己也会在这里 throw，但 proxy 不该替它提前崩。
    return null;
  }
  const forwardedHost = request.headers.get("x-forwarded-host");
  // 反代没设 x-forwarded-host（直连/局域网，Next 会回退用 host header）或已一致 →
  // 无需改写。只处理真正不匹配的情况，尽量少改请求。
  if (!forwardedHost || forwardedHost === originHost) {
    return null;
  }
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", originHost);
  return headers;
}

/** 直通响应：需要改写 header 时把新 headers 交给 NextResponse.next() 透传下去，
 *  否则原样 NextResponse.next()（与旧行为完全一致）。 */
function passThrough(headers: Headers | null): NextResponse {
  return headers ? NextResponse.next({ request: { headers } }) : NextResponse.next();
}

/** 经隧道的远程请求判定。与 workflow-runtime.isRemoteRequest() 保持一致：
 *  用 cf-ray/cdn-loop 而非仅 cf-connecting-ip（后者可被 zone 规则删除 → fail-open）。 */
function isRemoteRequest(request: NextRequest): boolean {
  return (
    request.headers.has("cf-ray") ||
    request.headers.has("cdn-loop") ||
    request.headers.has("cf-connecting-ip")
  );
}

export function proxy(request: NextRequest): NextResponse {
  const forwardedHeaders = serverActionForwardedHeaders(request);

  const multiUser = process.env.MEDIA_TRACK_MULTI_USER === "1";
  const gated = multiUser || isRemoteRequest(request);
  if (!gated) {
    return passThrough(forwardedHeaders);
  }
  if (HANDLER_GUARDED_API_PREFIXES.some((prefix) => request.nextUrl.pathname.startsWith(prefix))) {
    return passThrough(forwardedHeaders);
  }
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (hasSession) {
    return passThrough(forwardedHeaders);
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Gate pages; exclude the auth API, the login page, Next internals and assets.
  matcher: ["/((?!api/auth|login|_next/static|_next/image|favicon.ico).*)"],
};
