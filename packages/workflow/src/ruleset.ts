/**
 * 识别规则可配置系统（issue #44）的数据契约与加载器。
 *
 * 两条配置流，各自落一张表：
 *   - 集数解析正则（rule_patterns）—— 覆盖 episode-code.ts 的内置解析规则；
 *   - AI 仲裁 prompt 覆盖（prompt_overrides）—— 覆盖 arbitrator.ts 的 4 个生产 prompt
 *     （SELECTION_SYSTEM / EPISODE_MAPPING_SYSTEM / MOVIE_SELECTION_SYSTEM /
 *     MOVIE_DIAGNOSIS_SYSTEM；TV 诊断 DIAGNOSIS_SYSTEM 已无调用点，不开放配置）。
 *
 * 安全边界（issue #44）：表为空或规则损坏 → 自动回退内置默认值；正则保存时校验
 * 可编译且捕获组数量符合该规则的语义（见 validateRuleExpression）。
 */

import type { EpisodeParseRules } from "./episode-code.js";

/** 规则语义角色：决定解析代码怎么读捕获组。
 *  - season-episode：group1 = 季号，group2 = 集号（规则 0/1/3）
 *  - episode-only：group1 = 集号（规则 2/4/5）
 * 角色与内置 ruleId 绑定；自定义规则（非内置 id）必须在保存时明确选择角色。 */
export type RuleRole = "season-episode" | "episode-only";

/** rule_patterns 行（与表结构一致，camelCase 化）。 */
export interface RulePattern {
  ruleId: string;
  role: RuleRole;
  expression: string;
  label: string;
  sortOrder: number;
  isDefault: boolean;
}

/** prompt_overrides 行。arbitrationKind ∈ ARBITRATION_KINDS。 */
export interface PromptOverride {
  arbitrationKind: string;
  promptText: string;
  isActive: boolean;
}

/** ruleset 只依赖这两个窄接口，不 import 完整 WorkflowRepository（防循环）。 */
export interface RulePatternStore {
  listRulePatterns(): Promise<RulePattern[]>;
}
export interface PromptOverrideStore {
  listPromptOverrides(): Promise<PromptOverride[]>;
}

/**
 * 6 条内置集数解析规则 —— 与 episode-code.ts 的解析正则逐一对应
 * （issue #44 明确「正则以实际代码为准」；issue 标题写 7 条是笔误）。
 */
export const BUILTIN_RULE_PATTERNS: readonly RulePattern[] = [
  {
    ruleId: "sxxexx",
    role: "season-episode",
    label: "SxxExx",
    expression: "[Ss](\\d{1,2})[Ee](\\d{1,4})",
    sortOrder: 0,
    isDefault: true,
  },
  {
    ruleId: "variant",
    role: "season-episode",
    label: "SxxExx 变体（空格/点分隔）",
    expression: "[Ss](\\d{1,2})\\s*[. ]\\s*[Ee](\\d{1,4})(?!\\d)",
    sortOrder: 1,
    isDefault: true,
  },
  {
    ruleId: "ep-only",
    role: "episode-only",
    label: "E01 / EP01",
    expression: "(?:^|[^A-Za-z0-9])[Ee][Pp]?\\.?\\s*(\\d{1,4})(?:$|[^0-9])",
    sortOrder: 2,
    isDefault: true,
  },
  {
    ruleId: "cross",
    role: "season-episode",
    label: "1×01 / 1x01",
    expression: "(?:^|[^A-Za-z0-9])(\\d{1,2})\\s*[x×]\\s*(\\d{1,4})(?:$|[^0-9])",
    sortOrder: 3,
    isDefault: true,
  },
  {
    ruleId: "chinese",
    role: "episode-only",
    label: "第N集/话/期",
    expression: "第\\s*(\\d{1,4})\\s*(?:集|话|話|期)",
    sortOrder: 4,
    isDefault: true,
  },
  {
    ruleId: "digits",
    role: "episode-only",
    label: "纯数字（整名）",
    expression: "^(\\d{1,3})$",
    sortOrder: 5,
    isDefault: true,
  },
];

const BUILTIN_BY_ID = new Map(BUILTIN_RULE_PATTERNS.map((p) => [p.ruleId, p]));
export const BUILTIN_RULE_IDS: ReadonlySet<string> = new Set(
  BUILTIN_RULE_PATTERNS.map((p) => p.ruleId),
);

/** 4 个生产仲裁 prompt 的 kind（issue #44）。 */
export const ARBITRATION_KINDS = [
  "selection",
  "episode-mapping",
  "movie-selection",
  "movie-diagnosis",
] as const;
export type ArbitrationKind = (typeof ARBITRATION_KINDS)[number];

export function isArbitrationKind(value: string): value is ArbitrationKind {
  return (ARBITRATION_KINDS as readonly string[]).includes(value);
}

/** 安全编译：非法正则返回 null（绝不 throw）。 */
export function compileRulePattern(expression: string): RegExp | null {
  try {
    return new RegExp(expression);
  } catch {
    return null;
  }
}

/** 每种角色必需的捕获组数量。 */
export const REQUIRED_CAPTURE_GROUPS: Record<RuleRole, number> = {
  "season-episode": 2,
  "episode-only": 1,
};

/**
 * 统计表达式里的捕获组数量（跳过转义字符、字符类与非捕获/前瞻组），
 * 用于保存时校验捕获组契约。
 */
export function countCaptureGroups(expression: string): number {
  let count = 0;
  let inClass = false;
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i];
    if (ch === "\\") {
      i++; // 跳过转义的下一字符（\\( 不算组）
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "]") {
      inClass = false;
      continue;
    }
    if (!inClass && ch === "(") {
      const nextThree = expression.slice(i + 1, i + 4);
      // 前瞻/后顾与非捕获组不产生捕获；命名捕获组 (?<name>…) 要计入。
      if (nextThree === "?<=" || nextThree === "?<!") continue; // lookbehind
      const nextTwo = expression.slice(i + 1, i + 3);
      if (nextTwo === "?:" || nextTwo === "?=" || nextTwo === "?!") continue; // 非捕获/前瞻
      count++;
    }
  }
  return count;
}

/**
 * 保存时校验：返回错误文案；null = 可用。
 * 捕获组契约（S5）：season-episode 要求 group1=季号、group2=集号，episode-only
 * 要求 group1=集号。这里只静态校验「可编译 + 组数 ≥ 必需」——顺序/空匹配
 * （如 "()"、"a|"）无法静态识别，由 Phase 1 的 apply 侧在运行时拒绝空匹配；
 * 组数大于必需是宽容策略（多余组不影响前两组语义）。
 */
export function validateRuleExpression(role: RuleRole, expression: string): string | null {
  if (role !== "season-episode" && role !== "episode-only") {
    return `未知规则角色：${String(role)}`;
  }
  const trimmed = expression.trim();
  if (trimmed.length === 0) return "正则不能为空";
  if (trimmed.length > 300) return "正则过长（最多 300 字符）";
  if (compileRulePattern(trimmed) === null) return "不是合法的正则表达式";
  const groups = countCaptureGroups(trimmed);
  const required = REQUIRED_CAPTURE_GROUPS[role];
  if (groups < required) {
    return `捕获组不足：${role === "season-episode" ? "季+集需要 2 个捕获组" : "集号需要 1 个捕获组"}（当前 ${groups} 个）`;
  }
  return null;
}

/**
 * 加载生效规则集。语义（issue #44 安全边界 3「表为空或规则损坏 → 自动回退内置」）：
 * - 表为空（全新部署 / 恢复默认清空）→ 全部内置规则；
 * - 表非空 → 行是权威来源：内置规则行覆盖其表达式；
 *   某内置规则的行缺失 = 用户停用它（不出现在结果里）；
 *   某内置规则行正则损坏（非法 / 捕获组不符）→ 回退该条内置值；
 * - 自定义规则（ruleId 非内置）行有效则按 sortOrder 追加，损坏的丢弃。
 * 结果按 sortOrder 升序。
 */
export async function loadRulePatterns(store: RulePatternStore): Promise<RulePattern[]> {
  const rows = await store.listRulePatterns();
  if (rows.length === 0) return BUILTIN_RULE_PATTERNS.map((p) => ({ ...p })); // S2: 深拷贝，防消费端污染常量
  const effective: RulePattern[] = [];
  for (const row of rows) {
    const builtin = BUILTIN_BY_ID.get(row.ruleId);
    const role = builtin ? builtin.role : row.role;
    const error = validateRuleExpression(role, row.expression);
    if (error !== null) {
      if (builtin) effective.push({ ...builtin }); // 内置规则损坏 → 回退内置值（深拷贝）
      // 自定义规则损坏（含未知 role）→ 丢弃（不生效）
      continue;
    }
    effective.push({
      ruleId: row.ruleId,
      role,
      expression: row.expression.trim(), // S4: 与校验一致（存库原始值可能带装饰空格）
      label: row.label || (builtin?.label ?? ""),
      sortOrder: row.sortOrder,
      isDefault: builtin ? builtin.isDefault : row.isDefault,
    });
  }
  return effective.sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Prompt 覆盖直接透传（与内置 prompt 模板的合并发生在 arbitrator.ts，Phase 2）。 */
export async function loadPromptOverrides(store: PromptOverrideStore): Promise<PromptOverride[]> {
  return store.listPromptOverrides();
}

/**
 * 把生效规则集编译成 episode-code.ts 可直接消费的 EpisodeParseRules：
 * 6 个内置 ruleId 落到对应槽位（ep-only → epOnly 键），非内置 ruleId 进 custom
 * （按 patterns 顺序 = sortOrder 升序）。loadRulePatterns 已保证每条可编译，
 * 这里 compileRulePattern 只是双保险（null 则跳过）。
 */
export function compileEpisodeRules(patterns: readonly RulePattern[]): EpisodeParseRules {
  const rules: EpisodeParseRules = {};
  const custom: EpisodeParseRules["custom"] = [];
  for (const pattern of patterns) {
    const regex = compileRulePattern(pattern.expression);
    if (regex === null) continue;
    switch (pattern.ruleId) {
      case "sxxexx":
        rules.sxxexx = regex;
        break;
      case "variant":
        rules.variant = regex;
        break;
      case "ep-only":
        rules.epOnly = regex;
        break;
      case "cross":
        rules.cross = regex;
        break;
      case "chinese":
        rules.chinese = regex;
        break;
      case "digits":
        rules.digits = regex;
        break;
      default:
        custom.push({ role: pattern.role, regex });
    }
  }
  if (custom.length > 0) rules.custom = custom;
  return rules;
}

/** 一站式：读表（空表/损坏自动回退内置）→ 编译成 EpisodeParseRules。 */
export async function loadEpisodeRules(store: RulePatternStore): Promise<EpisodeParseRules> {
  return compileEpisodeRules(await loadRulePatterns(store));
}
