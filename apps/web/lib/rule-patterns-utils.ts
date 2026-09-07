/** 识别规则表单与 action 的共享纯逻辑（node 环境可测；类型在此定义，actions.ts 再导出）。 */

// 子路径导入(客户端表单也用它):ruleset 零 node 依赖,避免 barrel→sqlite→node:module 进客户端 chunk。
import { validateRuleExpression, type RuleRole } from "@media-track/workflow/ruleset";

/** 识别规则编辑 wire 类型。ruleId = "custom-<序号>"(内置规则完全只读,不进编辑流)。 */
export type RulePatternDraft = {
  ruleId: string;
  role: string;
  expression: string;
  label?: string;
  sortOrder: number;
  isDefault?: boolean;
};

/**
 * 自定义规则单行校验:空表达式 / 非法正则 / 捕获组不足 → 错误文案。
 * 与服务端 saveRulePatternsAction 共用同一 validateRuleExpression。
 */
export function ruleRowError(row: RulePatternDraft): string | null {
  const expression = row.expression.trim();
  if (expression.length === 0) return "正则不能为空";
  return validateRuleExpression(row.role as RuleRole, expression);
}
