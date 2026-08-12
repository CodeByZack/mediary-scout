import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proxy } from "./proxy";
import type { NextRequest } from "next/server";

/**
 * proxy 门禁判定的全组合覆盖。
 *
 * 这是「远程要登录、局域网免登录」的 Edge 侧实现，也是 Emby/Jellyfin 出事故的
 * 同一类判定。它只做 UX 层的重定向（权威判定在服务端 getCurrentAccountId()），
 * 但判错方向仍有代价：
 *  - 远程 + 无 session 却放行 → 用户看到空数据页而不是登录页（体验坏）
 *  - 局域网被误判成需登录 → 本地用户凭空多一道门（回归）
 *
 * 现行规则只有两个输入：是否 (多用户 || 远程)，以及有没有 session。
 * proxy 不再读 `mt_auth_required`，「有没有设过密码」不参与任何门禁判定。
 */

// 本套件断言的是单用户行为。必须显式关掉多用户开关：若被 runner 设置或从
// 别的测试文件泄漏进来，proxy 会走「处处门禁」分支，断言就在悄悄测另一件事。
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;
beforeAll(() => {
  delete process.env.MEDIA_TRACK_MULTI_USER;
});
afterAll(() => {
  if (prevMultiUser !== undefined) {
    process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  } else {
    delete process.env.MEDIA_TRACK_MULTI_USER;
  }
});

const makeRequest = (opts: {
  path?: string;
  cf?: boolean;
  staleAuthCookie?: boolean;
  session?: boolean;
  nextAction?: boolean;
  origin?: string;
  forwardedHost?: string;
}): NextRequest => {
  const headers = new Headers();
  if (opts.cf) headers.set("cf-ray", "8f3abc-LAX");
  // Server Action 请求特征：浏览器对 action POST 一定带 Next-Action header。
  if (opts.nextAction) headers.set("next-action", "action-id-123");
  if (opts.origin) headers.set("origin", opts.origin);
  if (opts.forwardedHost) headers.set("x-forwarded-host", opts.forwardedHost);
  const cookies = new Map<string, { name: string; value: string }>();
  // `mt_auth_required` is no longer written by anything and no longer read by
  // proxy — the gate is (multi-user || remote) + session, full stop. It is kept
  // here ONLY as a representative stale cookie, to pin that a leftover cookie on
  // a long-lived browser cannot change a gate decision in either direction.
  // Setting it does NOT mean "a password is set"; proxy has no notion of that.
  if (opts.staleAuthCookie)
    cookies.set("mt_auth_required", { name: "mt_auth_required", value: "1" });
  if (opts.session) cookies.set("mt_session", { name: "mt_session", value: "sess.sig" });
  const url = new URL(`http://localhost:3000${opts.path ?? "/"}`);
  return {
    headers,
    cookies: { get: (name: string) => cookies.get(name) },
    nextUrl: {
      pathname: url.pathname,
      clone: () => new URL(url.toString()),
      search: "",
    },
  } as unknown as NextRequest;
};

/** 判定结果：是否被重定向到 /login。 */
const redirectsToLogin = (req: NextRequest): boolean => {
  const res = proxy(req);
  return res.status >= 300 && res.status < 400 && (res.headers.get("location") ?? "").includes("/login");
};

describe("proxy gate — single-user mode (multi-user off)", () => {
  it("局域网（无 CF 头）→ 直通，零摩擦（任何 cookie 状态下都一样）", () => {
    expect(redirectsToLogin(makeRequest({}))).toBe(false);
    // 局域网直通与 cookie 无关：带一个残留 cookie 也不得凭空多出一道门。
    expect(redirectsToLogin(makeRequest({ staleAuthCookie: true }))).toBe(false);
  });

  it("未设密码 + 远程 → 仍要重定向到 /login（那里给的是设置密码表单）", () => {
    // 旧规则是 passwordSet && isRemote，未设密码的实例对公网匿名访客直接放行。
    // 服务端修复后会返回 acct_unauthenticated，若 proxy 还放行，远程站主只会
    // 看到一个没有出口的空页面。两侧同规则：远程一律要 session。
    expect(redirectsToLogin(makeRequest({ cf: true }))).toBe(true);
  });

  it("远程 + 无 session → 重定向到登录（残留 cookie 不得放行）", () => {
    expect(redirectsToLogin(makeRequest({ staleAuthCookie: true, cf: true }))).toBe(true);
  });

  it("远程 + 有 session → 直通（残留 cookie 不影响）", () => {
    expect(redirectsToLogin(makeRequest({ staleAuthCookie: true, cf: true, session: true }))).toBe(
      false,
    );
  });

  it("远程 + 有 session → 直通（session 才是唯一判据）", () => {
    expect(redirectsToLogin(makeRequest({ cf: true, session: true }))).toBe(false);
  });

  it("三个 CF 头任一存在都算远程", () => {
    for (const header of ["cf-ray", "cdn-loop", "cf-connecting-ip"]) {
      const req = makeRequest({});
      req.headers.set(header, "x");
      expect(redirectsToLogin(req)).toBe(true);
    }
  });

  it("handler 自守的 API 前缀不被重定向（否则会把 JSON 端点变成 HTML 跳转）", () => {
    for (const path of ["/api/health", "/api/workflows/run", "/api/agent/step"]) {
      expect(redirectsToLogin(makeRequest({ cf: true, path }))).toBe(false);
    }
  });
});

describe("proxy gate — multi-user mode", () => {
  it("多用户：无 session 一律重定向，与来源和任何残留 cookie 无关", () => {
    process.env.MEDIA_TRACK_MULTI_USER = "1";
    try {
      expect(redirectsToLogin(makeRequest({}))).toBe(true); // LAN 也要登录
      expect(redirectsToLogin(makeRequest({ cf: true }))).toBe(true);
      expect(redirectsToLogin(makeRequest({ staleAuthCookie: true }))).toBe(true);
      expect(redirectsToLogin(makeRequest({ session: true }))).toBe(false);
    } finally {
      delete process.env.MEDIA_TRACK_MULTI_USER;
    }
  });
});

/**
 * Next 16 Server Actions CSRF 修复：反代把 x-forwarded-host 写成内网地址，与浏览器
 * Origin（动态端口公网反代域名）不匹配 → action-handler.js abort (E80)，前端「点了
 * 没反应」。proxy 把 server action 请求的 x-forwarded-host 改写为 Origin 的 host。
 *
 * 断言方式：NextResponse.next({ request: { headers } }) 会把新的请求头序列化成
 * x-middleware-request-* 响应头，并在 x-middleware-override-headers 里列出被覆盖的
 * 键——这正是 Next 服务器实际用来重建下游请求的机制。
 */
describe("proxy — Server Actions CSRF fix（x-forwarded-host 改写）", () => {
  const ORIGIN = "https://office.app.5ddd.com:60565";
  const INTERNAL_HOST = "192.168.6.194:3333";
  const ORIGIN_HOST = "office.app.5ddd.com:60565";

  it("server action + origin/x-forwarded-host 不匹配 → x-forwarded-host 改写为 origin host", () => {
    const req = makeRequest({ session: true, nextAction: true, origin: ORIGIN, forwardedHost: INTERNAL_HOST });
    const res = proxy(req);
    expect(redirectsToLogin(req)).toBe(false); // auth gate 照常放行
    expect(res.headers.get("x-middleware-request-x-forwarded-host")).toBe(ORIGIN_HOST);
    expect(res.headers.get("x-middleware-override-headers")?.split(",")).toContain("x-forwarded-host");
  });

  it("server action + 局域网（无 CF 头）→ 同样改写（修复与来源无关）", () => {
    const req = makeRequest({ nextAction: true, origin: ORIGIN, forwardedHost: INTERNAL_HOST });
    const res = proxy(req);
    expect(res.headers.get("x-middleware-request-x-forwarded-host")).toBe(ORIGIN_HOST);
  });

  it("server action + 远程 + 无 session → 仍然重定向 /login（auth gate 不被绕过）", () => {
    const req = makeRequest({ cf: true, nextAction: true, origin: ORIGIN, forwardedHost: INTERNAL_HOST });
    expect(redirectsToLogin(req)).toBe(true);
  });

  it("非 server action（无 Next-Action）→ 不改写，即使 origin/x-forwarded-host 不匹配", () => {
    const req = makeRequest({ session: true, origin: ORIGIN, forwardedHost: INTERNAL_HOST });
    const res = proxy(req);
    expect(res.headers.get("x-middleware-override-headers")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-forwarded-host")).toBeNull();
  });

  it("server action + 无 Origin → 不改写", () => {
    const req = makeRequest({ session: true, nextAction: true, forwardedHost: INTERNAL_HOST });
    const res = proxy(req);
    expect(res.headers.get("x-middleware-override-headers")).toBeNull();
  });

  it("server action + Origin 'null' → 不改写（sandboxed iframe，Next 有自己的处理）", () => {
    const req = makeRequest({ session: true, nextAction: true, origin: "null", forwardedHost: INTERNAL_HOST });
    const res = proxy(req);
    expect(res.headers.get("x-middleware-override-headers")).toBeNull();
  });

  it("server action + origin 与 x-forwarded-host 已一致 → 不改写", () => {
    const req = makeRequest({ session: true, nextAction: true, origin: ORIGIN, forwardedHost: ORIGIN_HOST });
    const res = proxy(req);
    expect(res.headers.get("x-middleware-override-headers")).toBeNull();
  });

  it("server action + 畸形 Origin → 不改写、不抛错", () => {
    const req = makeRequest({ session: true, nextAction: true, origin: "not a url", forwardedHost: INTERNAL_HOST });
    expect(() => proxy(req)).not.toThrow();
    expect(proxy(req).headers.get("x-middleware-override-headers")).toBeNull();
  });
});
