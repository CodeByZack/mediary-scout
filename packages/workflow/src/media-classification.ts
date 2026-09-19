import type { MediaType } from "./domain.js";

/** TMDB genre id for "Animation" (shared by tv and movie). */
const ANIMATION_GENRE_ID = 16;
/** TMDB genre id for "Reality" (真人秀). TMDB has no 综艺/Variety genre, so this is the
 *  only reliable variety signal — 8/8 sampled shows (花儿与少年 / 中餐厅 / 地球超新鲜 /
 *  极限挑战 / 奔跑吧 / 密室大逃脱 / 喜人奇妙夜) all carry it. 10767 脱口秀 is
 *  deliberately NOT folded in (欧美夜谈 stay on the 剧集 shelf) — see
 *  docs/variety-type-design.md §7.1. */
const REALITY_GENRE_ID = 10764;

/**
 * Refine a base TMDB type into the library's shelf type.
 *
 * - A **movie is always a movie** — an animated film (你的名字, 哪吒) belongs on the
 *   电影 shelf and routes to the movie agent. Genre never reshelves a film.
 * - A **series** becomes "anime" whenever it's the Animation genre, regardless of
 *   origin — 日漫 / 国漫 / 美漫 (无敌少侠) / anything animated. The 动漫 shelf means
 *   "all animated series", not a region. Anime wins over variety when both genres are
 *   set (an anime-衍生 variety belongs on the 动漫 shelf).
 * - Otherwise a **series** becomes "variety" when the Reality genre is set — the 综艺
 *   shelf (花儿与少年 / 地球超新鲜 / 极限挑战 …).
 * - Everything else is plain tv.
 *
 *  originCountries is kept in the signature for callers but no longer affects the
 *  result.
 */
export function classifyMediaType(input: {
  baseType: Extract<MediaType, "tv" | "movie">;
  genreIds: number[];
  originCountries: string[];
}): MediaType {
  if (input.baseType === "movie") {
    return "movie";
  }
  if (input.genreIds.includes(ANIMATION_GENRE_ID)) {
    return "anime";
  }
  if (input.genreIds.includes(REALITY_GENRE_ID)) {
    return "variety";
  }
  return "tv";
}
