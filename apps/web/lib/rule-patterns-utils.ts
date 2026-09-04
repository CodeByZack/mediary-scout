/** 识别规则表单与 action 的共享纯逻辑（node 环境可测；类型在此定义，actions.ts 再导出）。 */

import { BUILTIN_RULE_PATTERNS, validateRuleExpression, type RuleRole } from "@media-track/workflow";

/** 识别规则编辑 wire 类型。ruleId 六大内置槽位固定；其余 ruleId = 自定义规则。 */
export type RulePatternDraft = {
  ruleId: string;
  role: string;
  expression: string;
  label?: string;
  sortOrder: number;
  isDefault?: boolean;
};

/** 六大内置槽位 id（与 ruleset.ts BUILTIN_RULE_PATTERNS 同源）。 */
export const BUILTIN_ID_SET = new Set<string>(BUILTIN_RULE_PATTERNS.map((p) => p.ruleId));

/**
 * 单行校验。内置规则留空 = 停用（允许）；其余空表达式 / 捕获组不足 / 非法正则 → 错误文案。
 * 与服务端 saveRulePatternsAction 共用同一 validateRuleExpression。
 */
export function ruleRowError(row: RulePatternDraft): string | null {
  const expression = row.expression.trim();
  if (expression.length === 0 && BUILTIN_ID_SET.has(row.ruleId)) return null;
  if (expression.length === 0) return "正则不能为空";
  return validateRuleExpression(row.role as RuleRole, expression);
}

/** 保存时剔除「留空 = 停用」的内置行：表缺失该内置 = Phase 0 loader 的「缺失内置=停用」语义。 */
export function filterDisabledBuiltins(rows: RulePatternDraft[]): RulePatternDraft[] {
  return rows.filter((row) => !(BUILTIN_ID_SET.has(row.ruleId) && row.expression.trim().length === 0));
}

/** 收集全部未通过校验的行错误（ruleId → 文案）。 */
export function collectRowErrors(rows: RulePatternDraft[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const row of rows) {
    const error = ruleRowError(row);
    if (error !== null) errors[row.ruleId] = error;
  }
  return errors;
}
