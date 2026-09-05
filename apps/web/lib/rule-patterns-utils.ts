/** 识别规则表单与 action 的共享纯逻辑（node 环境可测；类型在此定义，actions.ts 再导出）。 */

// 子路径导入(客户端表单也用它):ruleset 零 node 依赖,避免 barrel→sqlite→node:module 进客户端 chunk。
import { BUILTIN_RULE_PATTERNS, validateRuleExpression, type RuleRole } from "@media-track/workflow/ruleset";

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
 * 单行校验。内置规则留空 = 恢复内置默认（允许，内置分支仍生效）；其余空表达式 / 捕获组不足 / 非法正则 → 错误文案。
 * 与服务端 saveRulePatternsAction 共用同一 validateRuleExpression。
 */
export function ruleRowError(row: RulePatternDraft): string | null {
  const expression = row.expression.trim();
  if (expression.length === 0 && BUILTIN_ID_SET.has(row.ruleId)) return null;
  if (expression.length === 0) return "正则不能为空";
  return validateRuleExpression(row.role as RuleRole, expression);
}

/** 保存时剔除留空的内置行（= 恢复内置默认）。注：缺失行在采集时经 ?? 回退内置正则仍生效，
 *  当前版本不支持真正禁用内置分支（Phase 3 复核 S1）。 */
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

/**
 * issue #44 UI 重构:解析规则「一个输入框多行」的文本块 ↔ 规则行转换。
 * 行格式:S:/E: 前缀 + 正则(S=季+集两捕获组,E=仅集号一捕获组);# 开头为注释、空行忽略。
 * 布局约定:内置槽位恒为前 N 行(BUILTIN_RULE_PATTERNS 顺序,留空 = 恢复内置默认),
 * 其后为自定义规则(按行序 = 匹配优先级)。
 */



/** 行 → 前缀角色。非法前缀返回 null。 */
export function ruleBlockPrefix(line: string): { role: RuleRole; expression: string } | null {
  const m = /^(\s*)([SE]):\s*(.*)$/.exec(line);
  if (!m) return null;
  const role = m[2] === "S" ? "season-episode" : "episode-only";
  return { role, expression: (m[3] ?? "").trim() };
}

/** 规则行 → 文本行(S:/E: 前缀)。 */
export function rowToBlockLine(row: RulePatternDraft): string {
  const prefix = row.role === "season-episode" ? "S" : "E";
  return prefix + ": " + row.expression.trim();
}

/** 文本块 → 规则行。前 N 个非注释行 = 内置槽位(BUILTIN_RULE_PATTERNS 顺序,留空 = 恢复内置),
 *  其后 = 自定义行(前缀定角色,行序 = 优先级)。返回行级错误(行号 → 文案)。 */
export function parseRuleBlock(text: string): {
  rows: RulePatternDraft[];
  errors: Record<string, string>;
} {
  const lines = text.split(/\r?\n/);
  const errors: Record<string, string> = {};
  const rows: RulePatternDraft[] = [];
  const N = BUILTIN_RULE_PATTERNS.length;
  let customIndex = 0;
  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) return;
    const parsed = ruleBlockPrefix(line);
    if (!parsed) {
      errors[String(lineNo)] = "行格式应为 S: 正则 或 E: 正则(或以 # 开头的注释)";
      return;
    }
    const { role, expression } = parsed;
    const builtinIndex = rows.length;
    if (builtinIndex < N) {
      const slot = BUILTIN_RULE_PATTERNS[builtinIndex]!;
      if (slot.role !== role) {
        errors[String(lineNo)] = "内置槽位 " + slot.ruleId + " 的前缀固定为 " + (slot.role === "season-episode" ? "S" : "E") + "(角色不可改)";
        return;
      }
      rows.push({
        ruleId: slot.ruleId,
        role: slot.role,
        expression,
        label: slot.label ?? "",
        sortOrder: slot.sortOrder,
        isDefault: true,
      });
    } else {
      customIndex += 1;
      rows.push({
        ruleId: "custom-" + customIndex,
        role,
        expression,
        label: "自定义规则",
        sortOrder: N + customIndex,
        isDefault: false,
      });
    }
  });
  // 缺失内置补空行(用户删了内置行 → 留空 = 恢复内置)。
  while (rows.length < N) {
    const slot = BUILTIN_RULE_PATTERNS[rows.length]!;
    rows.push({
      ruleId: slot.ruleId,
      role: slot.role,
      expression: "",
      label: slot.label ?? "",
      sortOrder: slot.sortOrder,
      isDefault: true,
    });
  }
  // 行级校验(正则合法性 / 捕获组契约),与保存 action 同源。
  rows.forEach((row) => {
    const error = ruleRowError(row);
    if (error !== null) {
      // 内置行错误挂到其所在行(前 N 个非注释行之一);自定义行按行序。
      const idx = BUILTIN_ID_SET.has(row.ruleId) ? rows.indexOf(row) : rows.indexOf(row);
      let lineOfRow = -1;
      let seen = 0;
      for (let i = 0; i < lines.length; i++) {
        const t = (lines[i] ?? "").trim();
        if (t.length === 0 || t.startsWith("#")) continue;
        if (seen === idx) { lineOfRow = i + 1; break; }
        seen += 1;
      }
      errors[String(lineOfRow > 0 ? lineOfRow : idx + 1)] = error;
    }
  });
  return { rows, errors };
}
/** 规则行 → 文本块(仅规则行;说明文字由 UI 层展示,不占输入框)。 */
export function formatRuleBlock(rows: RulePatternDraft[]): string {
  const builtinRows = BUILTIN_RULE_PATTERNS.map((p) =>
    rows.find((r) => r.ruleId === p.ruleId) ?? {
      ruleId: p.ruleId,
      role: p.role,
      expression: "",
      label: p.label ?? "",
      sortOrder: p.sortOrder,
      isDefault: true,
    },
  );
  const customRows = rows.filter((r) => !BUILTIN_ID_SET.has(r.ruleId));
  const lines = [
    ...builtinRows.map(rowToBlockLine),
    ...customRows.map(rowToBlockLine),
  ];
  return lines.join("\n");
}
