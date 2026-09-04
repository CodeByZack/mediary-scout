import { generateText, type LanguageModel } from "ai";
import type { ArbitrationKind, PromptOverrideLookup } from "../ruleset.js";

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
  /** The chosen candidate id, or null to decline (report no coverage). */
  candidateId: string | null;
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
 * 做「文件名 → SxxExx」的逐集对应。这是老 agent 时代 `task-agents.ts` 里
 * "you can read that [NC-Raws] Lycoris Recoil - 01.mkv is S01E01" 的设计意图
 * —— fast path 重构时被代码独家解析吃掉,如今补回来。
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

const EPISODE_MAPPING_HEAD = "你是剧集文件集数识别员。代码转存了一个资源包,但文件名无法用规则解析出集数(纯数字/无S/E标识),请把这些文件逐个对应到正确的集数。";
const EPISODE_MAPPING_BODY = [
  "任务给出目标剧名、目标季、已知集数范围。文件名与集数的对应规则:",
  "- 纯数字 \`07.mp4\` → 第7集(若任务为第1季则 S01E07);数字范围必须在已知集数内。",
  "- \`E12\` / \`EP12\` / \`Ep.12\` → S01E12(单季任务)。",
  "- fansub \`[Sub] Title - 03 [1080p].mkv\` → 集数在文件名数字里,通常是 03。",
  "- \`12话\` / \`12集\` → 对应集数 12。",
  "- 无尽集数争议:范围外的数字(超集数上限)、年份、分辨率、Part 序号、CRC 别当集数。",
  "输出规则:",
  "- 只映射**确定**的;不确定的放进 unmapped,禁止瞎编。",
  "- episodeCode 必须形如 S01E01(两位季号+两位或多位集号);第1季就是 S01。",
  "- 每个文件最多一个映射;严禁两个文件映射到同一个集数。",
].join("\n");
const EPISODE_MAPPING_TAIL = [
  "只输出 JSON,不要任何其他文字:",
  '{"mapping": {"文件名": "SxxExx"}, "unmapped": ["无法确定的文件名"], "reasoning": "一句话理由"}',
].join("\n");

/** Arbitrate how to map unparsed landed files to episode codes (escalation #2a). */
export async function arbitrateEpisodeMapping(options: {
  model: LanguageModel;
  /** 落盘文件名列表(代码解析不出的那些)。 */
  unparsedFiles: string[];
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
    "需要识别集数的文件:",
    ...options.unparsedFiles.map((name, i) => `${i + 1}. ${name}`),
  ].join("\n");

  logAiCall(options.model, "集数映射仲裁", options.title, options.unparsedFiles.join(",").length);
  const result = await generateText({
    model: options.model,
    system: resolvePromptText("episode-mapping", options.promptOverrides),
    prompt,
  });

  try {
    const parsed = extractJson(result.text) as Partial<EpisodeMappingArbitration>;
    if (typeof parsed?.mapping !== "object" || parsed.mapping === null) {
      throw new Error("ARBITRATOR_BAD_MAPPING: mapping missing");
    }
    // 只保留合法 code 形状的条目;文件名必须是输入清单里的(防幻觉文件名)。
    const allowed = new Set(options.unparsedFiles);
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

const SELECTION_HEAD = "你是剧集资源选片仲裁员。代码已把搜索候选按规则分级（A>B>C>D），但没有唯一高分，需要你从候选中选出最可能是目标剧集的那个资源。";
const SELECTION_BODY = [
  "规则：",
  "- 优先选 A 级；A 级相当时，选标题最干净、最像正确季全集的那个。",
  "- 中文字幕优先（中文 release 名默认带中字；纯英文 scene release 大概率生肉）。",
  "- 排除同名异作（电影版/剧场版/真人版/OVA/SP）。",
  "- 若没有可用的候选，返回 candidateId 为 null。",
  "- 候选行里方括号 [id] 是候选的唯一真实 id：candidateId 必须从某个候选行的 [id] 里原样复制，禁止填标题、禁止自己编造。",
].join("\n");
const SELECTION_TAIL = [
  "只输出 JSON，不要任何其他文字：",
  '{"candidateId": "候选的id" | null, "reasoning": "一句话理由"}',
].join("\n");

const DIAGNOSIS_SYSTEM = [
  "你是剧集落盘诊断员。代码转存了一个候选并解析了落盘内容，但判定为「不符合」或「脏包」，需要你决定怎么处理。",
  "决定（action）三选一：",
  '- "accept"：虽有瑕疵但核心集数在、可用（如全集包里夹了个 sample，但需要的集都完整）——接受并归位标记。',
  '- "retry_other"：这个包不对（季错/同名异作/纯生肉/大量杂项），换下一个候选：同时在 nextCandidateId 里给出「下一个最该试的候选 id」。',
  '- "abandon"：没有可用的了，放弃并上报 no coverage。',
  "若选了 retry_other，会附带「剩余候选」列表（按代码分级 A>B>C>D 排好序）。",
  "规则：",
  "- nextCandidateId 必须从某个候选行的 [id] 里原样复制，禁止填标题、禁止编造；没有合适的就填 null。",
  "- 优先挑 A 级、次 B 级；排除已经列在「已尝试」里的。",
  "- 候选列表可能很长，只看前几个即可；不要为了选候选而重读全部。",
  "只输出 JSON，不要任何其他文字：",
  '{"action": "accept" | "retry_other" | "abandon", "reasoning": "一句话理由", "nextCandidateId": "候选的id" | null}',
].join("\n");

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

/** Arbitrate which candidate to transfer when the grader has no A-grade. */
export async function arbitrateSelection(options: {
  model: LanguageModel;
  /** summarizeGrading output — the compact ranked candidate list. */
  summary: string;
  title: string;
  seasons: number[];

  /** issue #44: prompt 覆盖表(kind → body)。缺省 = 内置模板。 */
  promptOverrides?: PromptOverrideLookup;}): Promise<SelectionArbitration> {
  const prompt = [
    `目标剧集：${options.title}${options.seasons.length > 0 ? `（季：${options.seasons.join("/")}）` : ""}`,
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
    const parsed = extractJson(result.text) as Partial<SelectionArbitration>;
    if (typeof parsed?.candidateId !== "string" && parsed?.candidateId !== null) {
      throw new Error("ARBITRATOR_BAD_SELECTION: candidateId missing");
    }
    return {
      candidateId: parsed.candidateId,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch {
    // Safe fallback: decline rather than transfer a random candidate.
    return { candidateId: null, reasoning: "仲裁返回无法解析，安全放弃" };
  }
}

/** Arbitrate how to handle a landing the digest rejected. */
export async function arbitrateDiagnosis(options: {
  model: LanguageModel;
  /** digest.summary output — the landing's parsed picture. */
  summary: string;
  title: string;
  /** 功能4: 剩余候选(按分级 A>B>C>D 排好序,带 id)。action=retry_other
   *  时供 AI 直接挑下一个,避免每轮脏包都重新仲裁。可选。 */
  remainingCandidates?: Array<{ id: string; title: string; grade: string }>;
  /** 已尝试过的候选(避免 AI 重复挑同一个)。可选。 */
  triedIds?: string[];
}): Promise<DiagnosisArbitration> {
  const remainingLines = (options.remainingCandidates ?? [])
    .filter((c) => !(options.triedIds ?? []).includes(c.id))
    .slice(0, 15)
    .map((c) => `[${c.grade}] [${c.id}] ${c.title}`)
    .join("\n");
  const prompt = [
    `目标剧集：${options.title}`,
    "",
    "落盘摘要：",
    options.summary,
    options.remainingCandidates && options.remainingCandidates.length > 0
      ? `\n剩余候选（按分级排序，A>B>C>D，前 15 个）：\n${remainingLines}`
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  logAiCall(options.model, "落盘诊断仲裁(剧集)", options.title, options.summary.length);
  const result = await generateText({
    model: options.model,
    system: DIAGNOSIS_SYSTEM,
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
      nextCandidateId:
        typeof parsed.nextCandidateId === "string" && parsed.nextCandidateId.length > 0
          ? parsed.nextCandidateId
          : null,
    };
  } catch {
    return { action: "abandon", reasoning: "仲裁返回无法解析，安全放弃", nextCandidateId: null };
  }
}

/**
 * The movie fast path's TWO escalation points — same single-call shape as the TV
 * arbitrator, but film-specific: identity is title + release year (the year is
 * the remake/同名异作 discriminator), and a landing is judged on "is the one
 * film there, or a collection/trailer bundle". Both return the same typed,
 * safe-fallback decisions as their TV twins.
 */

const MOVIE_SELECTION_HEAD = "你是电影资源选片仲裁员。代码已把搜索候选按规则分级（A>B>C>D），但没有唯一高分，需要你从候选中选出最可能是目标电影的那个资源。";
const MOVIE_SELECTION_BODY = [
  "规则：",
  "- 优先选 A 级（片名 + 发行年份都一致）。",
  "- A 级相当时，选标题最干净、最像正确影片（发行名带目标年份）的那个。",
  "- 排除同名异作 / remake（发行年份对不上）与其他作品（OVA/特别篇/番外）。",
  "- 发行名没带年份的候选可用但不可靠，优先带年份的。",
  "- 若没有可用的候选，返回 candidateId 为 null。",
  "- 候选行里方括号 [id] 是候选的唯一真实 id：candidateId 必须从某个候选行的 [id] 里原样复制，禁止填标题、禁止自己编造。",
].join("\n");
const MOVIE_SELECTION_TAIL = [
  "只输出 JSON，不要任何其他文字：",
  '{"candidateId": "候选的id" | null, "reasoning": "一句话理由"}',
].join("\n");

const MOVIE_DIAGNOSIS_HEAD = "你是电影落盘诊断员。代码转存了一个候选并解析了落盘内容，但判定为「不是单部正片」或「脏包」，需要你决定怎么处理。";
const MOVIE_DIAGNOSIS_BODY = [
  "决定（action）三选一：",
  '- "accept"：虽有瑕疵但目标正片在、可用（如正片旁夹了个 trailer/花絮/sample，正片完整）——接受并归位标记（系统会保留最大视频、丢弃其余）。',
  '- "retry_other"：这个包不对（同名异作/remake/合集/大量杂项），换下一个候选。',
  '- "abandon"：没有可用的了，放弃并上报 no coverage。',
].join("\n");
const MOVIE_DIAGNOSIS_TAIL = [
  "只输出 JSON，不要任何其他文字：",
  '{"action": "accept" | "retry_other" | "abandon", "reasoning": "一句话理由"}',
].join("\n");
/**
 * issue #44 Phase 2:四个 prompt 的模板化——head(角色定位)与 tail(JSON 输出契约)固定,
 * body(规则指令)是唯一可编辑段。覆盖时 head + override body + tail 重组,缺省 = 内置 body,
 * 输出与旧版逐字节一致。
 */
export const PROMPT_TEMPLATES: Record<ArbitrationKind, { head: string; body: string; tail: string }> = {
  selection: { head: SELECTION_HEAD, body: SELECTION_BODY, tail: SELECTION_TAIL },
  "episode-mapping": { head: EPISODE_MAPPING_HEAD, body: EPISODE_MAPPING_BODY, tail: EPISODE_MAPPING_TAIL },
  "movie-selection": { head: MOVIE_SELECTION_HEAD, body: MOVIE_SELECTION_BODY, tail: MOVIE_SELECTION_TAIL },
  "movie-diagnosis": { head: MOVIE_DIAGNOSIS_HEAD, body: MOVIE_DIAGNOSIS_BODY, tail: MOVIE_DIAGNOSIS_TAIL },
};

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
 *  A-grade. Reuses SelectionArbitration (candidateId + reasoning). */
export async function arbitrateMovieSelection(options: {
  model: LanguageModel;
  summary: string;
  title: string;
  year: number;

  /** issue #44: prompt 覆盖表(kind → body)。缺省 = 内置模板。 */
  promptOverrides?: PromptOverrideLookup;}): Promise<SelectionArbitration> {
  const prompt = [
    `目标电影：${options.title}${options.year > 0 ? `（发行年：${options.year}）` : ""}`,
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
    const parsed = extractJson(result.text) as Partial<SelectionArbitration>;
    if (typeof parsed?.candidateId !== "string" && parsed?.candidateId !== null) {
      throw new Error("ARBITRATOR_BAD_SELECTION: candidateId missing");
    }
    return {
      candidateId: parsed.candidateId,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch {
    return { candidateId: null, reasoning: "仲裁返回无法解析，安全放弃" };
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

