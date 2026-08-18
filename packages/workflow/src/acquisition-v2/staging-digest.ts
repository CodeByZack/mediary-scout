import { episodeCodeFromFileName } from "../episode-code.js";
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

  for (const video of videos) {
    const base = fileBaseName(video);
    const code = episodeCodeFromFileName(base);
    if (code) {
      if (!episodeCodes.includes(code)) {
        episodeCodes.push(code);
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
  const missingCodes = input.needCodes.filter((code) => !needSet.has(code) || !episodeCodes.includes(code));

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
  const lines: string[] = [];
  lines.push(`视频 ${d.videos.length} 个 / 字幕 ${d.subtitles.length} 个`);
  if (d.episodeCodes.length > 0) {
    lines.push(`解析出集数: ${d.episodeCodes.join(", ")}`);
  }
  if (d.unparsedVideos.length > 0) {
    lines.push(`无法解析集数的视频: ${d.unparsedVideos.join(" / ")}`);
  }
  if (d.outOfSeasonCodes.length > 0) {
    lines.push(`季外集数: ${d.outOfSeasonCodes.join(", ")}`);
  }
  if (d.junkSignals.length > 0) {
    lines.push(`脏包信号: ${d.junkSignals.join(" / ")}`);
  }
  lines.push(`覆盖目标: ${d.coveredCodes.length > 0 ? d.coveredCodes.join(", ") : "无"}`);
  lines.push(`仍缺: ${d.missingCodes.length > 0 ? d.missingCodes.join(", ") : "无"}`);
  lines.push(`判定: ${d.passes ? "符合，可归位标记" : d.isDirtyPack ? "脏包，需诊断" : "未覆盖目标，需诊断"}`);
  return lines.join("\n");
}
