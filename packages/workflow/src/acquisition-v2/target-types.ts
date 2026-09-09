/**
 * 任务目标形状 + need 计算 —— 供 fast path / orchestrator 消费。
 */

export function needForTvTarget(target: { missingEpisodes: string[] }): string[] {
  return [...target.missingEpisodes];
}

/** Coverage token for a movie task — the single synthetic MOVIE token. */
export function needForMovie(): string[] {
  return ["MOVIE"];
}

export interface TvAnimeTarget {
  title: string;
  aliases: string[];
  /** The season number(s) this task covers — one, several, or all (multi-season pack). */
  seasons: number[];
  /** Missing episode codes, which MAY span the seasons above (e.g. ["S01E07","S02E13"]). */
  missingEpisodes: string[];
  /** TMDB 各集播出日(SxxExx → "YYYY-MM-DD")。巡检/首采接线方从 episode_states
   * 带过来;fast path 用它做年守卫(digest/finalize 拒收日期与播出日矛盾的集)。 */
  episodeAirDates?: Record<string, string>;
  /** TMDB 各集原始 name(SxxExx → "Episode 10 (Part 1)")。综艺 Part 锚定数据。 */
  episodeNames?: Record<string, string>;
  qualityPreference: string;
}

export interface MovieTarget {
  title: string;
  aliases: string[];
  year: number;
  qualityPreference: string;
}