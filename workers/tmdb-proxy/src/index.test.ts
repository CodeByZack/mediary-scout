import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  handleTmdbProxy: vi.fn(),
  runScheduledRefresh: vi.fn(),
  DEFAULT_CORS_ORIGINS: new Set(["http://localhost:8788", "http://127.0.0.1:8788"]),
}));

vi.mock("./handler", () => mocks);

import defaultExport, { type Env } from "./index";

const fakeKv = { async get() { return null; }, async put() {} };
const env = (secret?: string): Env => (secret === undefined ? { TMDB_CACHE: fakeKv } : { TMDB_CACHE: fakeKv, TMDB_READ_TOKEN: secret });

beforeEach(() => {
  mocks.handleTmdbProxy.mockReset();
  mocks.runScheduledRefresh.mockReset();
});

describe("fetch — auth passthrough priority", () => {
  it("uses Authorization header token, ignores secret", async () => {
    mocks.handleTmdbProxy.mockResolvedValue(new Response("ok"));
    const req = new Request("https://w.example/movie/278", {
      headers: { Authorization: "Bearer userkey" },
    });
    await defaultExport.fetch(req, env("secrettoken"));
    expect(mocks.handleTmdbProxy).toHaveBeenCalledTimes(1);
    expect(mocks.handleTmdbProxy.mock.calls[0]?.[0]?.token).toBe("userkey");
  });

  it("falls back to secret when no Authorization header", async () => {
    mocks.handleTmdbProxy.mockResolvedValue(new Response("ok"));
    await defaultExport.fetch(new Request("https://w.example/movie/278"), env("secrettoken"));
    expect(mocks.handleTmdbProxy.mock.calls[0]?.[0]?.token).toBe("secrettoken");
  });

  it("accepts a raw token without the Bearer prefix", async () => {
    mocks.handleTmdbProxy.mockResolvedValue(new Response("ok"));
    const req = new Request("https://w.example/movie/278", {
      headers: { Authorization: "rawkey" },
    });
    await defaultExport.fetch(req, env(undefined));
    expect(mocks.handleTmdbProxy.mock.calls[0]?.[0]?.token).toBe("rawkey");
  });

  it("trims whitespace around the header token", async () => {
    mocks.handleTmdbProxy.mockResolvedValue(new Response("ok"));
    const req = new Request("https://w.example/movie/278", {
      headers: { Authorization: "Bearer   spacedkey   " },
    });
    await defaultExport.fetch(req, env(undefined));
    expect(mocks.handleTmdbProxy.mock.calls[0]?.[0]?.token).toBe("spacedkey");
  });

  it("empty Bearer falls through to the secret", async () => {
    mocks.handleTmdbProxy.mockResolvedValue(new Response("ok"));
    const req = new Request("https://w.example/movie/278", {
      headers: { Authorization: "Bearer   " },
    });
    await defaultExport.fetch(req, env("secrettoken"));
    expect(mocks.handleTmdbProxy.mock.calls[0]?.[0]?.token).toBe("secrettoken");
  });

  it("bare 'Bearer' (undici strips trailing OWS) falls through to the secret", async () => {
    mocks.handleTmdbProxy.mockResolvedValue(new Response("ok"));
    const req = new Request("https://w.example/movie/278", {
      headers: { Authorization: "Bearer" },
    });
    await defaultExport.fetch(req, env("secrettoken"));
    expect(mocks.handleTmdbProxy.mock.calls[0]?.[0]?.token).toBe("secrettoken");
  });

  it("'Bearerxyz' (no whitespace) is treated as a raw token, not the Bearer scheme", async () => {
    mocks.handleTmdbProxy.mockResolvedValue(new Response("ok"));
    const req = new Request("https://w.example/movie/278", {
      headers: { Authorization: "Bearerxyz" },
    });
    await defaultExport.fetch(req, env(undefined));
    expect(mocks.handleTmdbProxy.mock.calls[0]?.[0]?.token).toBe("Bearerxyz");
  });

  it("returns 401 when neither header nor secret is present", async () => {
    const res = await defaultExport.fetch(new Request("https://w.example/movie/278"), env(undefined));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Unauthorized");
    expect(mocks.handleTmdbProxy).not.toHaveBeenCalled();
  });

  it("401 response does not leak that a secret is expected", async () => {
    // Regression: the old 500 body said "Proxy misconfigured: missing
    // TMDB_READ_TOKEN secret", which told an anonymous caller exactly how the
    // deployment is configured. 401 with a generic body is the honest shape.
    const res = await defaultExport.fetch(new Request("https://w.example/movie/278"), env(undefined));
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain("secret");
    expect(body).not.toContain("misconfigured");
  });
});

describe("scheduled — cron pre-warm", () => {
  it("pre-warms when a secret is configured", async () => {
    const ctx = { waitUntil: vi.fn() };
    await defaultExport.scheduled({}, env("secrettoken"), ctx);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.runScheduledRefresh.mock.calls[0]?.[0]?.token).toBe("secrettoken");
  });

  it("no-ops when no secret is configured (no request context → no passthrough)", async () => {
    const ctx = { waitUntil: vi.fn() };
    await defaultExport.scheduled({}, env(undefined), ctx);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(mocks.runScheduledRefresh).not.toHaveBeenCalled();
  });
});
