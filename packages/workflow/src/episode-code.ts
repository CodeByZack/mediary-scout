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
 * 无季规则的解析结果记为目标季(单季任务取 seasons[0],与老 `第N集` 行为
 * 一致时是 S01;seasons 不传时也记 S01)。2026-08-21 放开:单季任务(如 S03
 * 整季包 `01.mkv`~`08.mkv`)直接按目标季解析,不再死守 S01 —— 整个流程从
 * 搜索/选候选已锁定目标季,文件名解析沿用同一上下文。多季仍禁用,交仲裁。
 * 调用方(digest 的 outOfSeasonCodes / finalize 的 seasonSet)负责把季不匹配
 * 的过滤掉。
 */

/**
 * 综艺衍生内容 token —— 只给「第N期」规则当黑名单用(见规则 4 注释)。
 * 中文 token 直接子串匹配;英文 token 带词边界(避免 Episode 里的 "ed"、top 里的 "op" 误伤)。
 */
const VARIETY_DERIVATIVE_MARKER =
  /加更|加长|直拍|手记|纯享|花絮|彩蛋|抢先|超前|幕后|访谈|坦白局|速看|特别企划|衍生|独家|高光|精选|会员|陪看|点评|repo|recap|vlog|bonus|\bpv\b|\bop\b|\bed\b|\bcut\b|\bplus\b/i;

/**
 * 从文件名里抽取显式播出日期:`2025.08.29` / `2025-08-29` / `2025-08-29` / `20250829` /
 * `2025年8月29日` → ISO "YYYY-MM-DD";没有(或形态不完整,如裸 `2026.06`)返回 null。
 * 年份限 2000–2099,月日做值域校验;`(?<!\d)` 边界保证分辨率/CRC 数字不被当日期。
 */
export function explicitFileDate(name: string): string | null {
  const separated = /(?:^|[^0-9])(20\d{2})\s*[.\-\/年]\s*(\d{1,2})\s*[.\-\/月]\s*(\d{1,2})\s*日?(?![0-9])/.exec(name);
  if (separated?.[1] && separated[2] && separated[3]) {
    const month = Number(separated[2]);
    const day = Number(separated[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${separated[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return null;
  }
  const compact = /(?:^|[^0-9])(20\d{2})(0[1-9]|1[0-2])([0-2]\d|3[01])(?![0-9])/.exec(name);
  if (compact?.[1] && compact[2] && compact[3]) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }
  return null;
}

/** 年守卫容差:文件日期与目标集 TMDB 播出日最多相差 45 天(周更综艺的更新滞后余量)。 */
export const EPISODE_DATE_TOLERANCE_DAYS = 45;

/**
 * 年守卫(issue #21 同族,2026-08-30 中餐厅案):文件名带显式日期、该集 TMDB 播出日已知,
 * 两者相差 > 容差 → 判冲突(不采信这个集数)。典型:「1-10季」合集包实际落的是第九季
 * (2025 日期)的文件,在 S10 单季任务下被解析/映射成 S10E11 —— 号码对、季份错。
 * 文件名无日期、或该集播出日未知 → false(守卫惰性,保持旧语义)。
 */
export function episodeDateConflict(
  code: string,
  fileName: string,
  airDates?: Record<string, string>,
): boolean {
  if (!airDates) return false;
  const air = airDates[code];
  if (!air) return false;
  const fileDate = explicitFileDate(fileName);
  if (!fileDate) return false;
  const t1 = Date.parse(`${fileDate}T00:00:00Z`);
  const t2 = Date.parse(`${air.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return false;
  return Math.abs(t1 - t2) / 86400000 > EPISODE_DATE_TOLERANCE_DAYS;
}

/**
 * 综艺「第N期」Part 锚定:期号 N + 上/下标记 → TMDB 集号。
 * TMDB name 形如 "Episode 10 (Part 1)/Episode 10 (Part 2)"(地球超新鲜一季 20 集,
 * 每期拆两集),与文件名「第10期上/下」一一对应。无 episodeNames 或期号/part 不在表内
 * → null(调用方回退机械 E(N))。
 */
function anchorVarietyPeriod(
  name: string,
  periodStr: string,
  seasonLabel: string,
  episodeNames?: Record<string, string>,
): string | null {
  if (!episodeNames) return null;
  const n = Number(periodStr);
  if (!Number.isFinite(n) || n < 1) return null;
  // 文件名里的上/下标记(紧贴期号,容忍空格:第10期上 / 第10期 上)。
  const partOfFile = /第\s*\d{1,4}\s*期\s*([上下])/.exec(name)?.[1] ?? null;
  // 收集该季里期号 == N 的所有集(TMDB name 匹配 "Episode N ...")。
  const hits: Array<{ code: string; part: number | null }> = [];
  for (const [code, tmdbName] of Object.entries(episodeNames)) {
    const em = /Episode\s*(\d{1,4})\b/i.exec(tmdbName);
    if (!em || Number(em[1]) !== n) continue;
    const pm = /\(Part\s*(\d{1,2})\)/i.exec(tmdbName);
    hits.push({ code, part: pm ? Number(pm[1]) : null });
  }
  if (hits.length === 0) return null;
  if (partOfFile === "上") {
    const hit = hits.find((h) => h.part === 1) ?? hits[0];
    return hit ? hit.code : null;
  }
  if (partOfFile === "下") {
    const hit = hits.find((h) => h.part === 2) ?? hits[hits.length - 1];
    return hit ? hit.code : null;
  }
  // 无上/下标记:该期唯一集直接用;多 part 取 Part 1(正片主体)。
  if (hits.length === 1) return hits[0]!.code;
  const first = hits.find((h) => h.part === 1);
  return (first ?? hits[0])!.code;
}

/**
 * 可配置集数解析规则（issue #44 Phase 1)：6 个内置槽位各有一个可选 RegExp 覆盖，
 * 外加自定义规则（ruleId 非内置）。这是「裸正则 + 代码守卫」两层模型（FORK-CHANGES
 * §34）：裸正则只决定匹配文本；剥扩展名/合理集数守卫/年份排除/衍生黑名单/Part 锚定/
 * 多季禁用等语义不进配置，由本函数按内置分支固定保留。缺省（不传或全部缺省槽位）
 * = 模块内置正则，行为与旧版逐字节一致 —— storage 执行器等 15 处旧调用点零改动。
 */
export interface EpisodeParseRules {
  /** 规则 0: SxxExx（group1=季 group2=集）。 */
  sxxexx?: RegExp;
  /** 规则 1: SxxExx 变体（空格/点分隔）。 */
  variant?: RegExp;
  /** 规则 2: E01 / EP01（group1=集号，单季）。 */
  epOnly?: RegExp;
  /** 规则 3: 1x01（Plex 兼容）。 */
  cross?: RegExp;
  /** 规则 4: 第N集/话/期（group1=集号，单季；期附带衍生黑名单）。 */
  chinese?: RegExp;
  /** 规则 5: 纯数字整名（group1=集号，单季 + 剥扩展名 + 年份排除）。 */
  digits?: RegExp;
  /** 自定义规则（sortOrder 升序），在所有内置分支之后 apply；season-episode 恒可用，
   *  episode-only 仅单季上下文。集号一律过 isPlausibleEpisodeNumber。 */
  custom?: Array<{ role: "season-episode" | "episode-only"; regex: RegExp }>;
}

/** 捕获组 → 规范集号文本:数字化去除空白/前导零,按两位补零;非法/越界 → null(跳过)。
 *  S1 防「用户正则捕获组带空白/非数字」产出畸形集码(如 "S03E 02"),畸形码与 needCodes
 *  恒对不上造成幻影/漏认。内置正则捕获纯数字,Number 规范化后行为逐字节一致。 */
function numPart(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  const text = String(n);
  if (text.length > 4) return null;
  return text.padStart(2, "0");
}

export function episodeCodeFromFileName(
  name: string,
  seasons?: number[],
  /** TMDB 各集原始 name(SxxExx→"Episode 10 (Part 1)")。综艺「第N期上/下」锚定:
   * 期号 N + Part 一一定位集号,免疫「一期拆多集」的 E(N) 机械错位(地球超新鲜案)。
   * 缺省 = 无锚定,「第N期」仍按旧机械 E(N) 解析(兼容无 TMDB 数据的部署)。 */
  episodeNames?: Record<string, string>,
  /** issue #44: 可配置规则（UI 编辑后经 ruleset.loadEpisodeRules 编译注入）。缺省 = 内置正则。 */
  rules?: EpisodeParseRules | null,
): string | null {
  // 0. 标准 SxxExx — 自带季信息,始终可解析(与 seasons 上下文无关)。
  //    Episode allows up to 4 digits for 1000+ episode anime (One Piece/柯南/蜡笔小新);
  //    \d{1,3} truncated "E1050" → "E105".
  const seasonEpisodeMatch = (rules?.sxxexx ?? /[Ss](\d{1,2})[Ee](\d{1,4})/).exec(name);
  if (seasonEpisodeMatch?.[1] && seasonEpisodeMatch[2]) {
    const s = numPart(seasonEpisodeMatch[1]);
    const e = numPart(seasonEpisodeMatch[2]);
    if (s !== null && e !== null) {
      return `S${s}E${e}`;
    }
  }

  // 1. SxxExx 变体:空格 / 点分隔 (`S01 E01`、`s01.e01`),多集包取起始集
  //    (`S01E01-E03` → S01E01;上一正则已先吃掉 `S01E01-E03` 的 S01E01 部分,
  //    这里补「数字之间无紧贴」的变体)。
  const looseMatch = (rules?.variant ?? /[Ss](\d{1,2})\s*[. ]\s*[Ee](\d{1,4})(?!\d)/).exec(name);
  if (looseMatch?.[1] && looseMatch[2]) {
    const s = numPart(looseMatch[1]);
    const e = numPart(looseMatch[2]);
    if (s !== null && e !== null) {
      return `S${s}E${e}`;
    }
  }

  // 单季上下文(seasons 不传或恰为单季):无季规则可用,目标季 = seasons[0](默认为 1)。
  // 2026-08-21 放开:此前 E01/第N集/纯数字一律记 S01,纯数字更是只在目标季为 S01
  // 时才启用;现在单季任务直接用目标季解析(S03 任务里 `01.mkv` → S03E01),因为整个
  // 流程(搜索/选候选)已锁定目标季,文件名解析沿用同一上下文。多季(seasons.length>1)
  // 仍禁用无季规则 —— 季不明 → 交仲裁,绝不瞎猜。
  const singleSeason = seasons === undefined || seasons.length === 1;
  const seasonLabel = seasons !== undefined && seasons.length === 1 ? String(seasons[0]).padStart(2, "0") : "01";
  if (singleSeason) {
    // 2. `E01` / `EP01` / `Ep.01` — 无季信息 → 目标季(如 S03E01,单季任务可信)。
    const epOnlyMatch = (rules?.epOnly ?? /(?:^|[^A-Za-z0-9])[Ee][Pp]?\.?\s*(\d{1,4})(?:$|[^0-9])/).exec(name);
    if (epOnlyMatch?.[1] && isPlausibleEpisodeNumber(Number(epOnlyMatch[1]))) {
      const e = numPart(epOnlyMatch[1]);
      if (e !== null) return `S${seasonLabel}E${e}`;
    }

    // 3. `1×01` / `1x01`(Plex 兼容:季×集)。
    const crossMatch = (rules?.cross ?? /(?:^|[^A-Za-z0-9])(\d{1,2})\s*[x×]\s*(\d{1,4})(?:$|[^0-9])/).exec(name);
    if (crossMatch?.[1] && crossMatch[2] && isPlausibleEpisodeNumber(Number(crossMatch[2]))) {
      const s = numPart(crossMatch[1]);
      const e = numPart(crossMatch[2]);
      if (s !== null && e !== null) return `S${s}E${e}`;
    }

    // 4. `第N集` / `第N话` / `第N期`(动漫「集/话」,国产综艺「期」;容忍空格;日文汉字「話」一并支持)。
    //    单季上下文才启用;数字上限放开到 4 位(1000+ 集长篇动漫,与第N集一致)。
    //    `第N期`(2026-08-30 中餐厅案):国内综艺把正片写作「第N期」,原契约不识别 →
    //    整季文件全部"解析失败",巡检白烧一轮仲裁。「期」规则带衍生内容黑名单:
    //    文件名含加更/直拍/手记等衍生 token 时「第N期」不是正片证据(正片「第8期」
    //    旁边的「合伙人手记第8期」是衍生内容,计入覆盖会造出假集数)。「集/话」维持
    //    原样、黑名单不外溢,避免改动既有动漫语义。
    const chineseMatch = (rules?.chinese ?? /第\s*(\d{1,4})\s*(?:集|话|話|期)/).exec(name);
    if (chineseMatch?.[1] && Number(chineseMatch[1]) <= 9999) {
      const derivativeBlocked = chineseMatch[0].endsWith("期") && VARIETY_DERIVATIVE_MARKER.test(name);
      if (!derivativeBlocked) {
        // 「第N期」Part 锚定(2026-08-31 地球超新鲜案):综艺一期在 TMDB 可能拆多集
        // (Episode 10 (Part 1/2) = 第10期上/下),机械 E(N) 会系统性错位。有 episodeNames
        // 时按「期号 + 上/下标记 → Episode N (Part 1/2)」精确锚定;锚不到(该期不在表
        // 内/无 part 对应)回退机械 E(N)(表缺失场景仍是旧语义,宁可过解析也不退化为
        // 全包 unparsed 的旧中餐厅问题)。
        const anchored = anchorVarietyPeriod(
          name,
          chineseMatch[1],
          seasonLabel,
          episodeNames,
        );
        if (anchored !== null) {
          return anchored;
        }
        const ce = numPart(chineseMatch[1]);
        if (ce !== null) return `S${seasonLabel}E${ce}`;
      }
      // 「第N期」被衍生黑名单挡掉后,再看是否另有 `第N集/话` 证据(不放过混名)。
      const fallbackMatch = /第\s*(\d{1,4})\s*(?:集|话|話)/.exec(name);
      if (fallbackMatch?.[1] && Number(fallbackMatch[1]) <= 9999) {
        const fe = numPart(fallbackMatch[1]);
        if (fe !== null) return `S${seasonLabel}E${fe}`;
      }
    }
  }

  // 5. 纯数字 `01.mp4`(动漫 fansub / 国内整季包最常见)— 只在整个文件名就是
  //    一个数字(去掉扩展名)时启用,且只在**单季**任务里(seasons 不传或为单季,
  //    不限于 S01——2026-08-21 放开,单季任务直接用目标季)。多季不猜季;夹着
  //    标题的数字("Show 01")歧义大,交仲裁。
  if (singleSeason) {
    const base = name.replace(/\.[A-Za-z0-9]+$/, "");
    const digits = (rules?.digits ?? /^(\d{1,3})$/).exec(base);
    if (digits?.[1]) {
      const n = Number(digits[1]);
      // 排除年份(1900–2099)、分辨率、超大 CRC/体积数字。
      if (isPlausibleEpisodeNumber(n) && !(n >= 1900 && n <= 2099)) {
        const de = numPart(digits[1]);
        if (de !== null) return `S${seasonLabel}E${de}`;
      }
    }
  }

  // 6. 自定义规则(issue #44 Phase 1):ruleId 非内置的规则由 ruleset.compileEpisodeRules
  //    注入到这里,在全部内置分支之后按 sortOrder apply。season-episode 自带季信息,
  //    任意上下文可用;episode-only 只在单季上下文(与内置 E01/第N集 同规则)。集号一律
  //    过 isPlausibleEpisodeNumber(排除分辨率/超大垃圾数字);group 缺失或空匹配天然跳过。
  if (rules?.custom) {
    for (const custom of rules.custom) {
      if (custom.role === "season-episode") {
        const m = custom.regex.exec(name);
        const s = numPart(m?.[1]);
        const e = numPart(m?.[2]);
        if (s !== null && e !== null && isPlausibleEpisodeNumber(Number(e))) {
          return `S${s}E${e}`;
        }
      }
    }
    if (singleSeason) {
      for (const custom of rules.custom) {
        if (custom.role === "episode-only") {
          const m = custom.regex.exec(name);
          const ce = numPart(m?.[1]);
          if (ce !== null && isPlausibleEpisodeNumber(Number(ce))) {
            return `S${seasonLabel}E${ce}`;
          }
        }
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
    .replace(/第\s*\d{1,4}\s*(?:集|话|話|期)/g, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}