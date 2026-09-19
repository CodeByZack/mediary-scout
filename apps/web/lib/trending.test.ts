import { describe, expect, it } from "vitest";
import {
  animeFirstAirDateFloor,
  isTrendingKind,
  mapTrendingResults,
  TRENDING_KINDS,
  trendingFeedQuery,
  varietyLastAirDateFloor,
} from "./trending";

describe("trending feed contract (must match workers/tmdb-proxy getTrendingFeeds)", () => {
  // The Worker Cron warms KV under cacheKeyFor(path + sorted query). The frontend
  // reads the SAME feed. cacheKeyFor sorts params, so what must match is the param
  // SET, captured here as the sorted querystring. If you edit one side, this fails.
  const sortedQuery = (query: Record<string, string>) =>
    new URLSearchParams([...Object.entries(query)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).toString();

  it("movie feed = trending/movie/week?language=zh-CN", () => {
    expect(TRENDING_KINDS.movie.path).toBe("trending/movie/week");
    expect(sortedQuery(TRENDING_KINDS.movie.query)).toBe("language=zh-CN");
  });

  it("tv feed = trending/tv/week?language=zh-CN", () => {
    expect(TRENDING_KINDS.tv.path).toBe("trending/tv/week");
    expect(sortedQuery(TRENDING_KINDS.tv.query)).toBe("language=zh-CN");
  });

  it("anime feed = recent (first_air_date rolls to <year-1>-01-01) + mainstream (vote_count.gte=50) + no adult", () => {
    expect(TRENDING_KINDS.anime.path).toBe("discover/tv");
    const now = new Date("2026-07-04T00:00:00Z");
    expect(sortedQuery(trendingFeedQuery("anime", now))).toBe(
      "first_air_date.gte=2025-01-01&include_adult=false&language=zh-CN&sort_by=popularity.desc&vote_count.gte=50&with_genres=16&with_original_language=ja",
    );
  });

  it("variety feed = recent (last_air_date rolls 6 months) + 中文真人秀 10764, matching the proxy", () => {
    expect(TRENDING_KINDS.variety.path).toBe("discover/tv");
    const now = new Date("2026-07-04T00:00:00Z");
    expect(sortedQuery(trendingFeedQuery("variety", now))).toBe(
      "include_adult=false&language=zh-CN&last_air_date.gte=2026-01-04&sort_by=popularity.desc&with_genres=10764&with_original_language=zh",
    );
  });

  it("variety feed has NO vote_count floor (综艺投票数极低,50 would empty it)", () => {
    const query = trendingFeedQuery("variety", new Date("2026-07-04T00:00:00Z"));
    expect(Object.keys(query)).not.toContain("vote_count.gte");
    // And it is the only feed that keys on last_air_date, never first_air_date.
    expect(Object.keys(query)).toContain("last_air_date.gte");
    expect(Object.keys(trendingFeedQuery("anime", new Date("2026-07-04T00:00:00Z")))).toContain(
      "first_air_date.gte",
    );
    expect(Object.keys(query)).not.toContain("first_air_date.gte");
  });

  it("movie/tv feed queries carry no dynamic date (unchanged)", () => {
    const now = new Date("2026-07-04T00:00:00Z");
    expect(sortedQuery(trendingFeedQuery("movie", now))).toBe("language=zh-CN");
    expect(sortedQuery(trendingFeedQuery("tv", now))).toBe("language=zh-CN");
  });

  it("anime first-air-date floor rolls with the year (last calendar year onward)", () => {
    expect(animeFirstAirDateFloor(new Date("2026-07-04T00:00:00Z"))).toBe("2025-01-01");
    expect(animeFirstAirDateFloor(new Date("2027-01-01T00:00:00Z"))).toBe("2026-01-01");
  });

  it("variety last-air-date floor rolls 6 months and crosses the year boundary", () => {
    expect(varietyLastAirDateFloor(new Date("2026-07-04T00:00:00Z"))).toBe("2026-01-04");
    // Crosses the year: 2026-05 → 2025-11 (the floor stays in the past, never wraps forward).
    expect(varietyLastAirDateFloor(new Date("2026-05-12T00:00:00Z"))).toBe("2025-11-12");
  });

  it("isTrendingKind accepts every known feed and rejects unknowns (the ?trending= guard)", () => {
    for (const kind of Object.keys(TRENDING_KINDS)) {
      expect(isTrendingKind(kind)).toBe(true);
    }
    expect(isTrendingKind("anime-2")).toBe(false);
    expect(isTrendingKind("all")).toBe(false);
    expect(isTrendingKind("")).toBe(false);
    // A 5th key added to TRENDING_KINDS becomes reachable automatically (derived, not hardcoded).
    expect(isTrendingKind("variety")).toBe(true);
  });
});

describe("mapTrendingResults", () => {
  it("maps a movie result (title/release_date/poster_path)", () => {
    const cards = mapTrendingResults(
      { results: [{ id: 27205, title: "盗梦空间", release_date: "2010-07-15", poster_path: "/a.jpg" }] },
      "movie",
    );
    expect(cards).toEqual([
      { tmdbId: 27205, title: "盗梦空间", year: 2010, posterPath: "/a.jpg", mediaType: "movie" },
    ]);
  });

  it("maps a variety result (name/last_air_date) to mediaType tv", () => {
    // A real discover/tv payload carries both dates; the card shows the series
    // origin (first_air_date) exactly like the anime feed, while last_air_date is
    // only the feed's recency floor — not a display field.
    const cards = mapTrendingResults(
      {
        results: [
          {
            id: 296202,
            name: "地球超新鲜",
            first_air_date: "2025-06-25",
            last_air_date: "2025-07-01",
            poster_path: "/c.jpg",
          },
        ],
      },
      "variety",
    );
    expect(cards).toEqual([
      { tmdbId: 296202, title: "地球超新鲜", year: 2025, posterPath: "/c.jpg", mediaType: "tv" }, // origin, not last_air_date
    ]);
  });

  it("maps a tv/anime result (name/first_air_date) to mediaType tv", () => {
    const cards = mapTrendingResults(
      { results: [{ id: 240411, name: "葬送的芙莉莲", first_air_date: "2023-09-29", poster_path: "/b.jpg" }] },
      "anime",
    );
    expect(cards).toEqual([
      { tmdbId: 240411, title: "葬送的芙莉莲", year: 2023, posterPath: "/b.jpg", mediaType: "tv" },
    ]);
  });

  it("keeps a missing poster_path as null", () => {
    const cards = mapTrendingResults({ results: [{ id: 1, title: "X", release_date: "2020-01-01" }] }, "movie");
    expect(cards[0]!.posterPath).toBeNull();
  });

  it("drops entries with no id or no title, and yields [] on a missing results array", () => {
    expect(mapTrendingResults({ results: [{ title: "no id" }, { id: 2 }] }, "movie")).toEqual([]);
    expect(mapTrendingResults({}, "movie")).toEqual([]);
    expect(mapTrendingResults(null, "movie")).toEqual([]);
  });

  it("null/empty air date → year null", () => {
    const cards = mapTrendingResults({ results: [{ id: 3, title: "Y" }] }, "movie");
    expect(cards[0]!.year).toBeNull();
  });
});
