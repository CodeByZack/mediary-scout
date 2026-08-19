import { generateText, type LanguageModel } from "ai";

/**
 * The AI's TWO escalation points in the fast path — both are pure single-call
 * judgments (zero tools), the opposite of the old 60-step tool loop. The fast
 * path runs entirely in code until it hits genuine ambiguity, then hands a
 * compact summary to the model and parses one JSON decision back:
 *
 *   1. arbitrateSelection — no unique A-grade among search candidates → pick one
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
}

const SELECTION_SYSTEM = [
  "你是剧集资源选片仲裁员。代码已把搜索候选按规则分级（A>B>C>D），但没有唯一高分，需要你从候选中选出最可能是目标剧集的那个资源。",
  "规则：",
  "- 优先选 A 级；A 级相当时，选标题最干净、最像正确季全集的那个。",
  "- 中文字幕优先（中文 release 名默认带中字；纯英文 scene release 大概率生肉）。",
  "- 排除同名异作（电影版/剧场版/真人版/OVA/SP）。",
  "- 若没有可用的候选，返回 candidateId 为 null。",
  "只输出 JSON，不要任何其他文字：",
  '{"candidateId": "候选的id" | null, "reasoning": "一句话理由"}',
].join("\n");

const DIAGNOSIS_SYSTEM = [
  "你是剧集落盘诊断员。代码转存了一个候选并解析了落盘内容，但判定为「不符合」或「脏包」，需要你决定怎么处理。",
  "决定（action）三选一：",
  '- "accept"：虽有瑕疵但核心集数在、可用（如全集包里夹了个 sample，但需要的集都完整）——接受并归位标记。',
  '- "retry_other"：这个包不对（季错/同名异作/纯生肉/大量杂项），换下一个候选。',
  '- "abandon"：没有可用的了，放弃并上报 no coverage。',
  "只输出 JSON，不要任何其他文字：",
  '{"action": "accept" | "retry_other" | "abandon", "reasoning": "一句话理由"}',
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

/** Arbitrate which candidate to transfer when the grader has no unique A-grade. */
export async function arbitrateSelection(options: {
  model: LanguageModel;
  /** summarizeGrading output — the compact ranked candidate list. */
  summary: string;
  title: string;
  seasons: number[];
}): Promise<SelectionArbitration> {
  const prompt = [
    `目标剧集：${options.title}${options.seasons.length > 0 ? `（季：${options.seasons.join("/")}）` : ""}`,
    "",
    "候选（按分级排序，A>B>C>D）：",
    options.summary,
  ].join("\n");

  const result = await generateText({
    model: options.model,
    system: SELECTION_SYSTEM,
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
}): Promise<DiagnosisArbitration> {
  const prompt = [
    `目标剧集：${options.title}`,
    "",
    "落盘摘要：",
    options.summary,
  ].join("\n");

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
    };
  } catch {
    return { action: "abandon", reasoning: "仲裁返回无法解析，安全放弃" };
  }
}

/**
 * The movie fast path's TWO escalation points — same single-call shape as the TV
 * arbitrator, but film-specific: identity is title + release year (the year is
 * the remake/同名异作 discriminator), and a landing is judged on "is the one
 * film there, or a collection/trailer bundle". Both return the same typed,
 * safe-fallback decisions as their TV twins.
 */

const MOVIE_SELECTION_SYSTEM = [
  "你是电影资源选片仲裁员。代码已把搜索候选按规则分级（A>B>C>D），但没有唯一高分，需要你从候选中选出最可能是目标电影的那个资源。",
  "规则：",
  "- 优先选 A 级（片名 + 发行年份都一致）。",
  "- A 级相当时，选标题最干净、最像正确影片（发行名带目标年份）的那个。",
  "- 排除同名异作 / remake（发行年份对不上）与其他作品（OVA/特别篇/番外）。",
  "- 发行名没带年份的候选可用但不可靠，优先带年份的。",
  "- 若没有可用的候选，返回 candidateId 为 null。",
  "只输出 JSON，不要任何其他文字：",
  '{"candidateId": "候选的id" | null, "reasoning": "一句话理由"}',
].join("\n");

const MOVIE_DIAGNOSIS_SYSTEM = [
  "你是电影落盘诊断员。代码转存了一个候选并解析了落盘内容，但判定为「不是单部正片」或「脏包」，需要你决定怎么处理。",
  "决定（action）三选一：",
  '- "accept"：虽有瑕疵但目标正片在、可用（如正片旁夹了个 trailer/花絮/sample，正片完整）——接受并归位标记（系统会保留最大视频、丢弃其余）。',
  '- "retry_other"：这个包不对（同名异作/remake/合集/大量杂项），换下一个候选。',
  '- "abandon"：没有可用的了，放弃并上报 no coverage。',
  "只输出 JSON，不要任何其他文字：",
  '{"action": "accept" | "retry_other" | "abandon", "reasoning": "一句话理由"}',
].join("\n");

/** Arbitrate which movie candidate to transfer when the grader has no unique
 *  A-grade. Reuses SelectionArbitration (candidateId + reasoning). */
export async function arbitrateMovieSelection(options: {
  model: LanguageModel;
  summary: string;
  title: string;
  year: number;
}): Promise<SelectionArbitration> {
  const prompt = [
    `目标电影：${options.title}${options.year > 0 ? `（发行年：${options.year}）` : ""}`,
    "",
    "候选（按分级排序，A>B>C>D）：",
    options.summary,
  ].join("\n");

  const result = await generateText({
    model: options.model,
    system: MOVIE_SELECTION_SYSTEM,
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
}): Promise<DiagnosisArbitration> {
  const prompt = [
    `目标电影：${options.title}${options.year > 0 ? `（发行年：${options.year}）` : ""}`,
    "",
    "落盘摘要：",
    options.summary,
  ].join("\n");

  const result = await generateText({
    model: options.model,
    system: MOVIE_DIAGNOSIS_SYSTEM,
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

