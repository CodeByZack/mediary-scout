import {
  createTmdbSearchProvider,
  getSearchPageView,
  InMemoryMediaSearchCache,
  type MediaSearchProvider,
  type SearchPageView,
} from "@media-track/workflow";
import { demoMediaSearchProvider } from "./demo-candidates";
import {
  ensureDemoSeeded,
  getAccountScopedSettings,
  getActiveWorkspaceScope,
  getCurrentAccountId,
  getTmdbAccesses,
  getWorkflowRepository,
} from "./workflow-runtime";

let demoSearchCache: InMemoryMediaSearchCache | null = null;
// SQLite-only build: no Postgres, so the search cache is in-memory (a lost cache
// on restart is fine — a 2nd SQLite schema isn't worth it).
let sqliteSearchCache: InMemoryMediaSearchCache | null = null;

export async function getSearchView(query: string, storageId?: string): Promise<SearchPageView> {
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  // Tree model: scope a movie's 已获取/获取 state to the active drive — obtained on
  // one drive must stay acquirable on another's workspace.
  const scope = await getActiveWorkspaceScope(storageId);
  return getSearchPageView({
    query,
    provider: await getMediaSearchProvider(),
    cache: getSearchCache(),
    repository,
    scope,
  });
}

function getSearchCache() {
  // Live TMDB searches are cached in-memory (6h TTL) so casual browsing never
  // becomes an API storm; the demo provider stays in-memory too. (The durable
  // Postgres cache was removed when the project went SQLite-only.)
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb") {
    return (sqliteSearchCache ??= new InMemoryMediaSearchCache());
  }
  demoSearchCache ??= new InMemoryMediaSearchCache();
  return demoSearchCache;
}

async function getMediaSearchProvider(): Promise<MediaSearchProvider> {
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER !== "tmdb") {
    return demoMediaSearchProvider;
  }
  // Built per-call scoped to the current account (its TMDB key → global → proxy),
  // not module-cached — a singleton would lock to the first account's key.
  return createTmdbSearchProvider(await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId())));
}
