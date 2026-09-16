import { DEFAULT_CORS_ORIGINS, handleTmdbProxy, runScheduledRefresh, type KvLike } from "./handler";

/** Parse a comma-separated env string into a Set, merged with localhost defaults. */
function parseCorsOrigins(raw: string | undefined): Set<string> {
  const extra = (raw ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return new Set([...DEFAULT_CORS_ORIGINS, ...extra]);
}

export interface Env {
  TMDB_CACHE: KvLike;
  /** Optional CF secret fallback. New deployments prefer the
   *  `Authorization: Bearer <token>` request header (issue #38 auth passthrough);
   *  this secret exists so older self-hosted deployments keep working without
   *  touching their app-side configuration. */
  TMDB_READ_TOKEN?: string;
  /** Comma-separated list of allowed CORS origins (for a landing site that
   *  browser-fetches the proxy). Localhost:8788 is always allowed for dev.
   *  Empty/undefined = only localhost. */
  CORS_ALLOWED_ORIGINS?: string;
}

/** Resolve the TMDB read token for this request: request header wins, CF secret
 *  falls back, missing both → 401. The app always sends `Bearer <token>`
 *  (`packages/workflow/src/tmdb-provider.ts`); a raw token without the Bearer
 *  prefix is also accepted for hand-crafted curls. A bare `Bearer` with no
 *  token (malformed) is treated as missing and falls through to the secret. */
function resolveToken(request: Request, env: Env): string | null {
  const raw = request.headers.get("Authorization")?.trim();
  if (!raw) return env.TMDB_READ_TOKEN?.trim() || null;
  // "Bearer <token>" (whitespace-separated) → use token. Bare "Bearer"
  // (undici strips trailing OWS, so "Bearer   " arrives as "Bearer") → treat
  // as missing and fall through to the secret. Anything else is a raw token
  // (hand-crafted curl) — we don't strip the word "Bearer" from "Bearerxyz"
  // because that would silently produce a wrong token.
  const m = raw.match(/^Bearer\s+(\S.*)$/i);
  if (m) return m[1]?.trim() || env.TMDB_READ_TOKEN?.trim() || null;
  if (/^Bearer\s*$/i.test(raw)) return env.TMDB_READ_TOKEN?.trim() || null;
  return raw;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const token = resolveToken(request, env);
    if (!token) {
      return new Response("Unauthorized", { status: 401 });
    }
    return handleTmdbProxy({
      request,
      kv: env.TMDB_CACHE,
      token,
      corsOrigins: parseCorsOrigins(env.CORS_ALLOWED_ORIGINS),
    });
  },

  // Daily cron (wrangler triggers.crons): pre-warm the trending feeds into KV so
  // no user open ever triggers a TMDB request. waitUntil keeps the worker alive
  // until the refresh settles. No request context here → only the CF secret
  // path is available; self-hosted deployments without a secret skip the
  // pre-warm (they usually don't need it — one user, low traffic).
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const token = env.TMDB_READ_TOKEN?.trim();
    if (!token) {
      return;
    }
    ctx.waitUntil(runScheduledRefresh({ kv: env.TMDB_CACHE, token }));
  },
};
