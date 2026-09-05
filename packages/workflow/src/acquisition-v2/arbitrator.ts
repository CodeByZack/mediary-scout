import { generateText, type LanguageModel } from "ai";
import type { ArbitrationKind, PromptOverrideLookup } from "../ruleset.js";
import { PROMPT_TEMPLATES } from "../prompt-templates.js";
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

