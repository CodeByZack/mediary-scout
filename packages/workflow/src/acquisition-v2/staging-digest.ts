import { episodeCodeFromFileName, episodeDateConflict } from "../episode-code.js";
import type { SimTreeFile } from "./storage-115-simulator.js";

/**
 * Staging digest for the fast path (zero-LLM). After a candidate transfer lands,
 * the agent used to read the whole staging tree back into context and judge "is
 * this the pack I need, or a dirty pack with samples/ads/花絮". This module does
 * that judgment in CODE: parse every video's episode code from its filename
 * (reusing episodeCodeFromFileName), classify subtitles, and flag dirty-pack
 * signals — so the fast path can go straight from landing to rename/归位/标记
 * without an LLM round-trip, and only escalates to the diagnostic arbitrator
 * when the landing is not cleanly the needed pack.
 */

/** Junk signals the landing may carry. A video whose filename cannot yield an
 *  episode code (sample / 广告 / 花絮 / 预告 / stray file) is the classic 脏包. */
const JUNK_FILE_MARKER =
  /(^|[.\s\-_])sample([.\s\-_]|$)|样本|广告|花絮|预告|采访|访谈|making|behind\s*the\s*scenes|trailer|mv\b|ost\b/i;

export interface StagingDigest {
  /** Video files (isVideo), in landing order. */
  videos: SimTreeFile[];
  /** Subtitle files (isSubtitle) — ride along with their video, never junk. */
  subtitles: SimTreeFile[];
  /** Episode codes parsed from the videos' filenames (deduped, e.g. S01E01). */
  episodeCodes: string[];
  /** Videos whose filename carried no episode code (movie main file, or TV junk). */
  unparsedVideos: string[];
  /** 年守卫剔除的文件(解析/映射出了集数,但文件自带日期与该集播出日矛盾)。
   *  同时计入 unparsedVideos —— 不采信就是"解析不出"。 */
  dateRejectedVideos: string[];
  /** Episode codes parsed but OUTSIDE the task's season scope. */
  outOfSeasonCodes: string[];
  /** Human-readable junk signals found (sample/广告/花絮/预告/…). */
  junkSignals: string[];
  /** The task's need codes that the landing actually covers. */
  coveredCodes: string[];
  /** The task's need codes still missing after this landing. */
  missingCodes: string[];
  /** Whether the landing cleanly covers ≥1 needed item with no junk — the fast
   *  path can rename/归位/标记 straight away. */
  passes: boolean;
  /** Whether the landing is a dirty pack (junk present, or TV videos that do not
   *  parse to episode codes). Escalates to the diagnostic arbitrator. */
  isDirtyPack: boolean;
  /** Compact LLM-ready summary (the diagnostic arbitrator's input). */
  summary: string;
}

export interface StagingDigestInput {
  files: SimTreeFile[];
  /** Target season numbers. Empty = movie (no episode codes, one film). */
  seasons: number[];
  /** The task's missing episode codes (e.g. ["S01E13"]), or ["MOVIE"]. */
  needCodes: string[];
  /** AI 集数映射覆盖(§2.2): fileName → episodeCode。代码解析不出的文件由
   *  集数映射仲裁给出对应关系后,这里手工喂回 digest,让纯数字/E01/日漫
   *  fansub 文件名也能正常参与覆盖判定与归位。文件名必须与落盘 basename
   *  完全一致;校验在调用方(仲裁返回后)完成,这里只做查表。 */
  overrides?: Record<string, string>;
  /** TMDB 各集播出日(SxxExx → "YYYY-MM-DD")。给了就启用**年守卫**:文件名带
   *  显式日期、与该集播出日相差 > 45 天的,解析/映射出的集数一律不采信(计入
   *  无法解析)。2026-08-30 中餐厅:「1-10季」合集包实际落的是第九季(2025
   *  日期)文件,在 S10 单季任务下被整包解释成 S10Exx —— 号码对、季份错。 */
  episodeAirDates?: Record<string, string>;
  /** TMDB 各集原始 name(SxxExx→"Episode 10 (Part 1)")。综艺「第N期上/下 ↔
   *  Episode N (Part 1/2)」锚定用(2026-08-31 地球超新鲜案);缺省 = 无锚定。 */
  episodeNames?: Record<string, string>;
}

function fileBaseName(file: SimTreeFile): string {
  return file.path.split("/").pop() ?? file.path;
}

function seasonOfCode(code: string): number | null {
  const match = /^S(\d{1,2})E/.exec(code);
  return match ? Number(match[1]) : null;
}

/** Digest the landing: classify files, parse episode codes, flag junk, and decide
 *  whether the fast path can proceed without the LLM. Pure function. */
export function digestStaging(input: StagingDigestInput): StagingDigest {
  const videos = input.files.filter((file) => file.isVideo);
  const subtitles = input.files.filter((file) => file.isSubtitle);

  const episodeCodes: string[] = [];
  const unparsedVideos: string[] = [];
  const junkSignals: string[] = [];
  const dateRejectedVideos: string[] = [];
  // AI 集数映射覆盖(§2.2):代码解析不出的文件由仲裁给映射,digest 里优先查表。
  // 文件名的匹配对不上 overrides 里给的 key 时按 unparsed 处理(宁可少认不乱认)。
  const overrides = input.overrides ?? {};

  for (const video of videos) {
    const base = fileBaseName(video);
    const parsedCode =
      overrides[base] ?? episodeCodeFromFileName(base, input.seasons, input.episodeNames);
    if (parsedCode) {
      // 年守卫(issue #21 同族):文件自带日期与该集播出日明显矛盾 → 不采信,
      // 按解析失败处理(宁可少认不乱认;映射表给出的 code 同样过守卫)。
      if (episodeDateConflict(parsedCode, base, input.episodeAirDates)) {
        dateRejectedVideos.push(base);
        unparsedVideos.push(base);
      } else if (!episodeCodes.includes(parsedCode)) {
        episodeCodes.push(parsedCode);
      }
    } else {
      unparsedVideos.push(base);
    }
    // Junk signal on a video is independent of whether it also parses to a code —
    // a "Show.S01E01.sample.mkv" parses AND is a sample.
    const junk = JUNK_FILE_MARKER.exec(base);
    if (junk) {
      junkSignals.push(base);
    }
  }

  // Non-video, non-subtitle strays (nfo/jpg/cover) are residue, not junk-per-se —
  // they ride the wrapper removal. But a stray that LOOKS like media junk counts.
  const seasonSet = new Set(input.seasons);
  const outOfSeasonCodes = episodeCodes.filter((code) => {
    const season = seasonOfCode(code);
    return season !== null && seasonSet.size > 0 && !seasonSet.has(season);
  });

  const needSet = new Set(input.needCodes);
  const coveredCodes = episodeCodes.filter((code) => needSet.has(code));
  const missingCodes = input.needCodes.filter((need) => !needSet.has(need) || !episodeCodes.includes(need));

  const hasJunk = junkSignals.length > 0;
  // TV: a video that does not parse to an episode code is junk (sample/花絮/预告
  //  hide in the pack). Movie: the main film legitimately has no episode code, so
  //  unparsed videos are NOT junk there.
  const tvHasUnparsedVideoJunk = seasonSet.size > 0 && unparsedVideos.length > 0;

  const isDirtyPack = hasJunk || tvHasUnparsedVideoJunk;
  // Coverage: ≥1 needed item landed (TV), or a video landed (movie).
  const coveragePasses = seasonSet.size > 0 ? coveredCodes.length > 0 : videos.length > 0;
  const passes = coveragePasses && !isDirtyPack;

  return {
    videos,
    subtitles,
    episodeCodes,
    unparsedVideos,
    dateRejectedVideos,
    outOfSeasonCodes,
    junkSignals,
    coveredCodes,
    missingCodes,
    passes,
    isDirtyPack,
    summary: summarizeDigest({
      videos,
      subtitles,
      episodeCodes,
      unparsedVideos,
      dateRejectedVideos,
      outOfSeasonCodes,
      junkSignals,
      coveredCodes,
      missingCodes,
      passes,
      isDirtyPack,
    }),
  };
}

function summarizeDigest(d: Omit<StagingDigest, "summary">): string {
  // issue #29 用户反馈:不要内部术语(脏包/判定/覆盖目标),写一句人话结论:
  // 转存后检查 → 认出哪几集 / 有几个文件看不出 / 暂时缺哪几集 / 日期拒收说明。
  const parts: string[] = [];
  const known = d.episodeCodes.length > 0 ? d.episodeCodes.join(",") : "无";
  // 日期拒收的文件不算「看不出集数」(原因不同:文件名有日期但与播出日矛盾)。
  const unparsedCount = d.unparsedVideos.filter((v) => !d.dateRejectedVideos.includes(v)).length;
  if (d.passes) {
    // 部分覆盖(passes 但还有缺集):不写「完整」,如实说认出哪些 + 还缺哪些(避免与 args「还缺 N 集」自相矛盾)。
    const stillMissing = d.missingCodes.length > 0 ? `,还缺 ${d.missingCodes.join(",")}` : "";
    parts.push(`转存内容已识别:识别出 ${known}${stillMissing}${d.subtitles.length > 0 ? `,含字幕 ${d.subtitles.length} 个` : ""}`);
  } else {
    const unparsedNote = unparsedCount > 0 ? `${unparsedCount} 个文件看不出集数` : "";
    const missingNote = d.missingCodes.length > 0 ? `,还缺 ${d.missingCodes.join(",")}` : "";
    parts.push(`识别出 ${known}${unparsedNote ? ",另有 " + unparsedNote + missingNote : missingNote}`);
    if (d.dateRejectedVideos.length > 0) {
      // 年守卫:文件自带日期与该集播出日矛盾 → 不采信。保留可见(PR #24 契约,测试断言)。
      parts.push(`季份日期不符剔除 ${d.dateRejectedVideos.join("、")}`);
    }
    if (d.junkSignals.length > 0) {
      parts.push(`含多余文件(${d.junkSignals.join("、")})`);
    }
  }
  return parts.join("；");
}

/**
 * Movie staging digest — the fast path's movie-specific judgment (simpler than TV:
 * no episode mapping). After a candidate transfer lands, this verifies in CODE that
 * the landing is ONE film:
 *
 *   - exactly one video → the film, clean → `passes`.
 *   - zero videos → nothing useful landed (a subtitle-only / stray pack) → neither
 *     passes nor dirty; the caller advances to the next candidate like a dead link.
 *   - ≥2 videos → a collection / multi-part / film+trailer bundle → dirty → escalates
 *     to the diagnostic arbitrator (which names which single film to keep).
 *   - a junk signal (sample/广告/花絮/预告/…) on any video → dirty.
 *
 * Subtitles are never junk (they ride the film, per §1.14).
 */
export interface MovieStagingDigest {
  videos: SimTreeFile[];
  subtitles: SimTreeFile[];
  /** Human-readable junk signals (sample/广告/花絮/预告/…). */
  junkSignals: string[];
  /** The clean one-film landing → flattenMovie + markObtained in code, zero LLM. */
  passes: boolean;
  /** Needs the diagnostic arbitrator (junk, or more than one video). */
  isDirtyPack: boolean;
  /** Compact LLM-ready summary (the diagnostic arbitrator's input). */
  summary: string;
}

export function digestMovieStaging(files: SimTreeFile[]): MovieStagingDigest {
  const videos = files.filter((file) => file.isVideo);
  const subtitles = files.filter((file) => file.isSubtitle);
  const junkSignals: string[] = [];

  for (const video of videos) {
    const base = fileBaseName(video);
    const junk = JUNK_FILE_MARKER.exec(base);
    if (junk) {
      junkSignals.push(base);
    }
  }

  const hasJunk = junkSignals.length > 0;
  const isDirtyPack = hasJunk || videos.length > 1;
  const passes = videos.length === 1 && !hasJunk;

  const summary = [
    `视频 ${videos.length} 个 / 字幕 ${subtitles.length} 个`,
    videos.length === 0
      ? "未落盘任何视频（空转/仅字幕/杂项）"
      : `视频: ${videos.map((v) => fileBaseName(v)).join(" / ")}`,
    junkSignals.length > 0 ? `脏包信号: ${junkSignals.join(" / ")}` : null,
    `判定: ${passes ? "一部正片，可归位标记" : isDirtyPack ? "非单部正片/脏包，需诊断" : "无视频，需换候选"}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return { videos, subtitles, junkSignals, passes, isDirtyPack, summary };
}

