/**
 * The episode-identity contract between storage listings and workflow state:
 * a file is "visible" as an episode exactly when its FILE NAME alone exposes
 * an episode code. Path context (season folders) does not survive moves, so
 * anything the workflow lands in a canonical season directory must carry its
 * code in the name — see the rename step in staging normalization.
 */

/**
 * Reasonable-episode guard for the name-only heuristics (§3.3 误判防护):
 * episode numbers must not collide with 分辨率 / 年份 / 超大垃圾数字.
 */
function isPlausibleEpisodeNumber(n: number): boolean {
  if (n < 1 || n > 999) return false;
  if ([4320, 2160, 1080, 720].includes(n)) return false; // 分辨率
  return true;
}

/**
 * 解析文件名里的集数编码。
 *
 * 2026-08-19 调研 §3: 原生实现只认 `SxxExx` / `第N集` 两种,纯数字 `01.mp4`、
 * `E01`、`1×01`、`第N话` 等常见命名(动漫 fansub / 国内整季包)全不识别,
 * 狂飙 01-39 整季包因此全判「无法解析」→ 脏包。本次补齐常见命名规则。
 *
 * `seasons` 是调用方知道的**任务目标季**(可选):
 *   - 不传(如 storage 枚举、renameVideo guard)= 宽松单季模式,可解析全部规则;
 *   - 传且为单季 → 无季规则可用(SxxExx 自带季始终可解析);
 *   - 传且为多季(seasons.length>1) → 无季规则(E01/第N话/1×01/纯数字)全部禁用,
 *     季不明 → 交仲裁,绝不瞎猜。
 *
 * 无季规则的解析结果一律记 S01(与老 `第N集` 行为一致),调用方(digest 的
 * outOfSeasonCodes / finalize 的 seasonSet)负责把季不匹配的过滤掉。
 */
export function episodeCodeFromFileName(name: string, seasons?: number[]): string | null {
  // 0. 标准 SxxExx — 自带季信息,始终可解析(与 seasons 上下文无关)。
  //    Episode allows up to 4 digits for 1000+ episode anime (One Piece/柯南/蜡笔小新);
  //    \d{1,3} truncated "E1050" → "E105".
  const seasonEpisodeMatch = /[Ss](\d{1,2})[Ee](\d{1,4})/.exec(name);
  if (seasonEpisodeMatch?.[1] && seasonEpisodeMatch[2]) {
    return `S${seasonEpisodeMatch[1].padStart(2, "0")}E${seasonEpisodeMatch[2].padStart(2, "0")}`;
  }

  // 1. SxxExx 变体:空格 / 点分隔 (`S01 E01`、`s01.e01`),多集包取起始集
  //    (`S01E01-E03` → S01E01;上一正则已先吃掉 `S01E01-E03` 的 S01E01 部分,
  //    这里补「数字之间无紧贴」的变体)。
  const looseMatch = /[Ss](\d{1,2})\s*[. ]\s*[Ee](\d{1,4})(?!\d)/.exec(name);
  if (looseMatch?.[1] && looseMatch[2]) {
    return `S${looseMatch[1].padStart(2, "0")}E${looseMatch[2].padStart(2, "0")}`;
  }

  const singleSeason = seasons === undefined || seasons.length === 1;
  if (singleSeason) {
    // 2. `E01` / `EP01` / `Ep.01` — 无季信息 → S01E01(单季任务可信)。
    const epOnlyMatch = /(?:^|[^A-Za-z0-9])[Ee][Pp]?\.?\s*(\d{1,4})(?:$|[^0-9])/.exec(name);
    if (epOnlyMatch?.[1] && isPlausibleEpisodeNumber(Number(epOnlyMatch[1]))) {
      return `S01E${epOnlyMatch[1].padStart(2, "0")}`;
    }

    // 3. `1×01` / `1x01`(Plex 兼容:季×集)。
    const crossMatch = /(?:^|[^A-Za-z0-9])(\d{1,2})\s*[x×]\s*(\d{1,4})(?:$|[^0-9])/.exec(name);
    if (crossMatch?.[1] && crossMatch[2] && isPlausibleEpisodeNumber(Number(crossMatch[2]))) {
      return `S${crossMatch[1].padStart(2, "0")}E${crossMatch[2].padStart(2, "0")}`;
    }

    // 4. `第N集` / `第N话`(动漫,容忍空格;日文汉字「話」一并支持)。
    //    单季上下文才启用;数字上限放开到 4 位(1000+ 集长篇动漫,与第N集一致)。
    const chineseMatch = /第\s*(\d{1,4})\s*(?:集|话|話)/.exec(name);
    if (chineseMatch?.[1] && Number(chineseMatch[1]) <= 9999) {
      return `S01E${chineseMatch[1].padStart(2, "0")}`;
    }
  }

  // 5. 纯数字 `01.mp4`(动漫 fansub / 国内整季包最常见)— 只在整个文件名就是
  //    一个数字(去掉扩展名)时启用,且只在单季为 S01 的任务里(seasons 不传
  //    或恰为 [1])。多季不猜季;夹着标题的数字("Show 01")歧义大,交仲裁。
  const seasonOneOnly =
    seasons === undefined || (seasons.length === 1 && seasons[0] === 1);
  if (seasonOneOnly) {
    const base = name.replace(/\.[A-Za-z0-9]+$/, "");
    const digits = base.match(/^(\d{1,3})$/);
    if (digits?.[1]) {
      const n = Number(digits[1]);
      // 排除年份(1900–2099)、分辨率、超大 CRC/体积数字。
      if (isPlausibleEpisodeNumber(n) && !(n >= 1900 && n <= 2099)) {
        return `S01E${digits[1].padStart(2, "0")}`;
      }
    }
  }

  return null;
}

/**
 * Canonical episode name `Title.SxxExx.ext` — the TV/anime staging-normalization
 * target (renameVideo). CONTRACT: `episodeCode` must be the FINAL code for the
 * file's target season — i.e. season-corrected (a `第N集` file landing in
 * `Season 03` must pass `S03E03`, NOT the `S01E03` that
 * `episodeCodeFromFileName` would read from the bare filename). The season
 * context lives only in the agent's judgment (inspectTargetDir), never in the
 * source filename, so the caller supplies the corrected code.
 */
export function canonicalEpisodeFileName(input: {
  title: string;
  episodeCode: string;
  sourceName: string;
}): string {
  const extensionMatch = /\.[A-Za-z0-9]+$/.exec(input.sourceName);
  const extension = extensionMatch?.[0] ?? "";
  return `${input.title}.${input.episodeCode}${extension}`;
}

/**
 * Canonical movie name `Title (Year).ext` — the movie staging-normalization
 * target (flattenMovie auto-rename + the renameVideo movie-shape contract).
 * `year` may be a number or a pre-formatted string; the extension is carried
 * over from the source file so the film stays a playable video.
 */
export function canonicalMovieFileName(input: {
  title: string;
  year: number | string;
  sourceName: string;
}): string {
  const extensionMatch = /\.[A-Za-z0-9]+$/.exec(input.sourceName);
  const extension = extensionMatch?.[0] ?? "";
  return `${input.title} (${input.year})${extension}`;
}

/**
 * Strip a title clean enough to embed in a canonical filename:
 *  - episode-code-shaped substrings (`SxxExx`, `第N集`) — they would otherwise
 *    be mis-read by `episodeCodeFromFileName` when the canonical name is later
 *    parsed (a title containing `S01E01`-shaped noise makes the episode
 *    identity ambiguous);
 *  - filename-hostile characters `[\\/:*?"<>|]`;
 *  - leftover whitespace (folded to a single space + trimmed).
 * Pure function: provided for the skill examples and the future system-generated
 * naming mode; the renameVideo guard itself only rejects illegal characters
 * (§1.3 #7) — it does not require the newName prefix to equal the cleaned title.
 */
export function cleanTitleForCanonicalName(title: string): string {
  return title
    .replace(/[Ss]\d{1,2}[Ee]\d{1,4}/g, "")
    .replace(/第\s*\d{1,4}\s*(?:集|话|話)/g, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}