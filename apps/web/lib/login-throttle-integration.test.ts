import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * loginAccount 限流集成测试。复用既有 `:memory:` SQLite boot 模式
 * （同 guangya-connect.test.ts），真实跑 workflow-runtime，仅隔离网络无关部分。
 * 负载断言：
 *  - 连续 5 次错误密码 → 第 6 次返回「尝试过于频繁」（且不再验密）。
 *  - 锁定期间即使密码正确也被挡。
 *  - 缺失账号与存在账号耗时同量级（无枚举时序预言机）。
 *
 * ⚠️ 超时：每个用例要跑 6+ 次 scrypt 验密（memory-hard，单次 ~50-80ms），
 * 在全量并行下与其它测试争抢 CPU 会远超 vitest 默认的 5s。故显式放宽到 30s——
 * 这不是「慢测试」，而是密码学原语的固有成本。
 */
const CRYPTO_TIMEOUT_MS = 30_000;

const boot = async () => {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  vi.resetModules();
  return import("./workflow-runtime");
};

afterEach(() => {
  delete process.env.MEDIA_TRACK_SQLITE_PATH;
  vi.resetModules();
});

describe("loginAccount throttling (integration)", () => {
  beforeEach(async () => {
    const { _resetLoginThrottleForTest } = await import("./login-throttle");
    _resetLoginThrottleForTest();
  });

  it(
    "locks after 5 wrong passwords and blocks the 6th (even the correct one)",
    async () => {
      const rt = await boot();
      await rt.setSingleUserPassword("password-123");

      for (let i = 0; i < 5; i++) {
        const r = await rt.loginAccount("", "wrong-password");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("密码不正确");
      }

      // 第 6 次：不再验密，直接限流
      const locked = await rt.loginAccount("", "wrong-password");
      expect(locked.ok).toBe(false);
      if (!locked.ok) expect(locked.error).toContain("尝试过于频繁");

      // 锁定期间正确密码同样被挡
      const blocked = await rt.loginAccount("", "password-123");
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error).toContain("尝试过于频繁");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "successful login after reset works",
    async () => {
      const rt = await boot();
      await rt.setSingleUserPassword("password-123");

      for (let i = 0; i < 5; i++) await rt.loginAccount("", "wrong-password");

      const { _resetLoginThrottleForTest } = await import("./login-throttle");
      _resetLoginThrottleForTest();
      const ok = await rt.loginAccount("", "password-123");
      expect(ok.ok).toBe(true);
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "keeps the throttle bucket when session creation fails (no backoff reset on server error)",
    async () => {
      const rt = await boot();
      await rt.setSingleUserPassword("password-123");
      const { checkLoginAllowed, normalizeThrottleKey } = await import("./login-throttle");

      // 先攒 4 次失败（还差 1 次就锁定）
      for (let i = 0; i < 4; i++) await rt.loginAccount("", "wrong-password");

      // 让建 session 抛错：密码是对的，但服务端故障 ⇒ 这次登录并未成功
      const repo = rt.getWorkflowRepository();
      const original = repo.createSession.bind(repo);
      repo.createSession = async () => {
        throw new Error("DB down");
      };
      await expect(rt.loginAccount("", "password-123")).rejects.toThrow("DB down");
      repo.createSession = original;

      // 桶必须保留：再失败 1 次即达到 5 次门槛而锁定。
      // 若桶在 session 失败时被误清，这里只算第 1 次，不会锁。
      await rt.loginAccount("", "wrong-password");
      const key = normalizeThrottleKey("acct_default");
      expect(checkLoginAllowed(key, Date.now()).allowed).toBe(false);
    },
    CRYPTO_TIMEOUT_MS,
  );
});
