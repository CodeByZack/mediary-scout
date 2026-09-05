/** issue #44 Phase 2:四个生产仲裁 prompt 的模板(head/body/tail)。纯数据模块,零运行时依赖
 *  —— 客户端(设置页表单)可直接导入展示真实 head/tail,不拉 "ai"。
 *  body(规则指令)是唯一可编辑段;head(角色定位)与 tail(JSON 输出契约)固定。 */
import type { ArbitrationKind } from "./ruleset.js";

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
