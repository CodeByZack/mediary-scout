import { generateText, type LanguageModel } from "ai";
import type { ArbitrationKind, PromptOverrideLookup } from "../ruleset.js";
import { PROMPT_TEMPLATES, EPISODE_MAPPING_BODY_SINGLE, EPISODE_MAPPING_BODY_MULTI } from "../prompt-templates.js";
export { PROMPT_TEMPLATES } from "../prompt-templates.js";

/** Always-on stdout trace marking every LLM round-trip the arbitrator makes —
 *  the user asked for every AI call site to be clearly flagged in the run log
 *  (`[AI] …`). The model id is printed so a run's log shows which model made
 *  each judgment; prompt sizes stay out of the log (only the summary length,
 *  to keep a sense of how much context the call consumed). */
function logAiCall(
  model: LanguageModel,
  kind: string,
  title: string | undefined,
  summaryLength: number,
): void {
  const modelId = (model as { modelId?: string }).modelId ?? "unknown";
  console.log(`[AI] 调用 ${kind} model=${modelId} 目标=${title ?? "-"} 摘要=${summaryLength} 字符`);
}

/**
 * The AI's TWO escalation points in the fast path — both are pure single-call
 * judgments (zero tools), the opposite of the old 60-step tool loop. The fast
 * path runs entirely in code until it hits genuine ambiguity, then hands a
 * compact summary to the model and parses one JSON decision back:
 *
 *   1. arbitrateSelection — no A-grade among search candidates → pick one
 *      (or decline).
 *   2. arbitrateDiagnosis — a landing failed the staging digest (脏包 / wrong
 *      season / 生肉 / out-of-scope) → accept / retry_other / abandon.
 *
 * Both return a typed, safe-fallback decision: an unparseable model reply never
 * crashes the run — it degrades to "decline"/"abandon" (the conservative choice).
 */

export interface SelectionArbitration {
  /** Picked candidate ids, best-first. Empty = decline (report no coverage). */
  candidateIds: string[];
  reasoning: string;
}

export interface DiagnosisArbitration {
  /** accept = 虽有瑕疵但核心集数在，归位标记; retry_other = 换下一个候选;
   *  abandon = 放弃并上报 no coverage. */
  action: "accept" | "retry_other" | "abandon";
  reasoning: string;
  /** 功能4(批量候选 §4): action=retry_other 时,AI 直接给出「下一个该试的候选 id」
   *  (必须是候选行里的 [id] 原样复制)。代码优先用它,其次才回退机械按序 nextCandidate。
   *  把「这个包不对 → 换谁」合并进一次仲裁,避免每个脏包都再烧一轮 LLM。 */
  nextCandidateId?: string | null;
}

/**
 * 集数映射仲裁(§2.2, 2026-08-19 调研): 代码解析不出集数的落盘文件(纯数字
 * `01.mp4` / `E01` / 日漫 fansub `[Sub] Title - 01 [1080p].mkv`),由 AI 一次性
 * 做「文件名 → SxxExx」的逐集对应,即 "you can read that [NC-Raws] Lycoris Recoil -
 * 01.mkv is S01E01" 这个逐集判读意图 —— fast path 重构时被代码解析吃掉,如今补回来。
 *
 * 这个仲裁只负责「给出映射」,不负责决定收不收:映射后代码重建 digest,
 * 覆盖/残缺/冲突全部由 digest 的客观判定决定,AI 猜错映射最多导致
 * 重建后仍不 passes(回落到诊断仲裁),不会脑补"人工归位"。
 */
export interface EpisodeMappingArbitration {
  /** fileName(basename, 与落盘完全一致) → episodeCode(SxxExx)。 */
  mapping: Record<string, string>;
  /** 无法确定集数的文件(如确实无法判断的杂物)。 */
  unmapped: string[];
  reasoning: string;
}

/** Arbitrate how to map landed files to episode codes (escalation #2a). */
export async function arbitrateEpisodeMapping(options: {
  model: LanguageModel;
  /** 全部落盘视频文件名(减衍生内容/杂物)——含代码已解析出的,不限于解析失败的那些。 */
  allFiles: string[];
  title: string;
  seasons: number[];
  /** 已知集数范围(如 1..39),供模型排除越界数字。 */
  knownEpisodeRange: { min: number; max: number } | null;

  /** issue #44: prompt 覆盖表(kind → body)。缺省 = 内置模板。 */
  promptOverrides?: PromptOverrideLookup;}): Promise<EpisodeMappingArbitration> {
  const prompt = [
    `目标剧集:${options.title}(${options.seasons.length > 0 ? `季:${options.seasons.join("/")}` : "未知季"})`,
    `已知集数范围:${options.knownEpisodeRange ? `${options.knownEpisodeRange.min} ~ ${options.knownEpisodeRange.max}` : "未知"}`,
    "",
    options.seasons.length > 1 ? "需要识别集数的文件路径(含文件夹):" : "需要识别集数的文件:",
    ...options.allFiles.map((name, i) => `${i + 1}. ${name}`),
  ].join("\n");

  logAiCall(options.model, "集数映射仲裁", options.title, options.allFiles.join(",").length);
  // ★ 2026-09-12:按「该 kind 是否有实际覆盖」选 body,而不是 overrides 对象真值。
  // 旧写法 options.promptOverrides(编译后恒为对象,哪怕 {} 是空表) 走 truthy 分支 →
  // resolvePromptText 回落到单季 body → 多季任务拿到「单季任务」正文,文件夹归季规则
  // 从未生效(run 19ca7e1d S1 内容被 AI 标 S2 的诱因之一)。现在:无覆盖按季数选
  // MULTI/SINGLE;有覆盖(用户自定义)单季/多季共用同一正文——与整体 override 语义一致。
  const template = PROMPT_TEMPLATES["episode-mapping"];
  const episodeMappingBody =
    options.promptOverrides?.["episode-mapping"] ??
    (options.seasons.length > 1 ? EPISODE_MAPPING_BODY_MULTI : EPISODE_MAPPING_BODY_SINGLE);
  const result = await generateText({
    model: options.model,
    // issue #53:多季用"文件路径"body(提示文件夹含季信息),单季保持"文件名"body(零回归)。
    system: template.head + "\n" + episodeMappingBody + "\n" + template.tail,
    prompt,
  });

  try {
    const parsed = extractJson(result.text) as Partial<EpisodeMappingArbitration>;
    if (typeof parsed?.mapping !== "object" || parsed.mapping === null) {
      throw new Error("ARBITRATOR_BAD_MAPPING: mapping missing");
    }
    // 只保留合法 code 形状的条目;文件名必须是输入清单里的(防幻觉文件名)。
    const allowed = new Set(options.allFiles);
    const cleanMapping: Record<string, string> = {};
    const unmappedList: string[] = [];
    for (const [fileName, code] of Object.entries(parsed.mapping)) {
      if (!allowed.has(fileName)) continue; // 幻觉文件名忽略
      if (typeof code !== "string" || !/^S\d{2}E\d{2,4}$/.test(code)) continue;
      cleanMapping[fileName] = code;
    }
    const unmapped = Array.isArray(parsed.unmapped)
      ? parsed.unmapped.filter((name) => typeof name === "string" && allowed.has(name))
      : [];
    return {
      mapping: cleanMapping,
      unmapped,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch {
    // Safe fallback: no mapping at all — the caller's digest will stay unparsed
    // and escalate to the diagnostic arbitrator.
    return { mapping: {}, unmapped: [], reasoning: "仲裁返回无法解析，安全放弃映射" };
  }
}

/** Extract the first JSON object/array from a model reply, tolerating markdown
 *  code fences and surrounding prose. Throws when no JSON is present. */
export function extractJson(text: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const first = stripped.search(/[{\[]/);
  if (first < 0) {
    throw new Error("ARBITRATOR_NO_JSON: model output has no JSON");
  }
  const last = Math.max(stripped.lastIndexOf("}"), stripped.lastIndexOf("]"));
  return JSON.parse(stripped.slice(first, last + 1));
}

/** Arbitrate which candidate(s) to transfer when the grader has no A-grade. */
export async function arbitrateSelection(options: {
  model: LanguageModel;
  /** summarizeGrading output — the compact ranked candidate list. */
  summary: string;
  title: string;
  seasons: number[];

  /** Maximum number of candidates to pick (best-first order). */
  maxPicks: number;

  /** issue #44: prompt 覆盖表(kind → body)。缺省 = 内置模板。 */
  promptOverrides?: PromptOverrideLookup;}): Promise<SelectionArbitration> {
  const prompt = [
    `目标剧集：${options.title}${options.seasons.length > 0 ? `（季：${options.seasons.join("/")}）` : ""}`,
    `最多挑选 ${options.maxPicks} 个候选（按推荐顺序排列，最佳在前）`,
    "",
    "候选（按分级排序，A>B>C>D）：",
    options.summary,
  ].join("\n");

  logAiCall(options.model, "选片仲裁(剧集)", options.title, options.summary.length);
  const result = await generateText({
    model: options.model,
    system: resolvePromptText("selection", options.promptOverrides),
    prompt,
  });

  try {
    const parsed = extractJson(result.text) as Record<string, unknown>;
    let ids: string[];
    if (Array.isArray(parsed.candidateIds)) {
      ids = parsed.candidateIds.filter((id): id is string => typeof id === "string");
    } else if (typeof parsed.candidateId === "string") {
      ids = [parsed.candidateId]; // backward compat: old single-id format
    } else {
      ids = [];
    }
    return {
      candidateIds: ids.slice(0, options.maxPicks),
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch {
    // Safe fallback: decline rather than transfer a random candidate.
    return { candidateIds: [], reasoning: "仲裁返回无法解析，安全放弃" };
  }
}

/**
 * The movie fast path's TWO escalation points — same single-call shape as the TV
 * arbitrator, but film-specific: identity is title + release year (the year is
 * the remake/同名异作 discriminator), and a landing is judged on "is the one
 * film there, or a collection/trailer bundle". Both return the same typed,
 * safe-fallback decisions as their TV twins.
 */

/** 按模板组装最终 system prompt:head + (覆盖 body ?? 内置 body) + tail。 */
export function resolvePromptText(
  kind: ArbitrationKind,
  overrides: PromptOverrideLookup | undefined,
): string {
  const template = PROMPT_TEMPLATES[kind];
  const body = overrides?.[kind] ?? template.body;
  return template.head + "\n" + body + "\n" + template.tail;
}


/** Arbitrate which movie candidate to transfer when the grader has no unique
 *  A-grade. Reuses SelectionArbitration (candidateIds + reasoning). */
export async function arbitrateMovieSelection(options: {
  model: LanguageModel;
  summary: string;
  title: string;
  year: number;

  /** Maximum number of candidates to pick. Movie defaults to 1. */
  maxPicks?: number;

  /** issue #44: prompt 覆盖表(kind → body)。缺省 = 内置模板。 */
  promptOverrides?: PromptOverrideLookup;}): Promise<SelectionArbitration> {
  const maxPicks = options.maxPicks ?? 1;
  const prompt = [
    `目标电影：${options.title}${options.year > 0 ? `（发行年：${options.year}）` : ""}`,
    `最多挑选 ${maxPicks} 个候选（按推荐顺序排列，最佳在前）`,
    "",
    "候选（按分级排序，A>B>C>D）：",
    options.summary,
  ].join("\n");

  logAiCall(options.model, "选片仲裁(电影)", options.title, options.summary.length);
  const result = await generateText({
    model: options.model,
    system: resolvePromptText("movie-selection", options.promptOverrides),
    prompt,
  });

  try {
    const parsed = extractJson(result.text) as Record<string, unknown>;
    let ids: string[];
    if (Array.isArray(parsed.candidateIds)) {
      ids = parsed.candidateIds.filter((id): id is string => typeof id === "string");
    } else if (typeof parsed.candidateId === "string") {
      ids = [parsed.candidateId]; // backward compat: old single-id format
    } else {
      ids = [];
    }
    return {
      candidateIds: ids.slice(0, maxPicks),
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch {
    return { candidateIds: [], reasoning: "仲裁返回无法解析，安全放弃" };
  }
}

/** Arbitrate how to handle a movie landing the digest rejected. Reuses
 *  DiagnosisArbitration (accept / retry_other / abandon). */
export async function arbitrateMovieDiagnosis(options: {
  model: LanguageModel;
  summary: string;
  title: string;
  year: number;

  /** issue #44: prompt 覆盖表(kind → body)。缺省 = 内置模板。 */
  promptOverrides?: PromptOverrideLookup;}): Promise<DiagnosisArbitration> {
  const prompt = [
    `目标电影：${options.title}${options.year > 0 ? `（发行年：${options.year}）` : ""}`,
    "",
    "落盘摘要：",
    options.summary,
  ].join("\n");

  logAiCall(options.model, "落盘诊断仲裁(电影)", options.title, options.summary.length);
  const result = await generateText({
    model: options.model,
    system: resolvePromptText("movie-diagnosis", options.promptOverrides),
    prompt,
  });

  try {
    const parsed = extractJson(result.text) as Partial<DiagnosisArbitration>;
    if (parsed?.action !== "accept" && parsed?.action !== "retry_other" && parsed?.action !== "abandon") {
      throw new Error("ARBITRATOR_BAD_DIAGNOSIS: action invalid");
    }
    return {
      action: parsed.action,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch {
    return { action: "abandon", reasoning: "仲裁返回无法解析，安全放弃" };
  }
}

