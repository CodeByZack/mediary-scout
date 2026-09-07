/** 识别规则表单与 action 的共享纯逻辑（node 环境可测；类型在此定义，actions.ts 再导出）。 */

// 子路径导入(客户端表单也用它):ruleset 零 node 依赖,避免 barrel→sqlite→node:module 进客户端 chunk。
import {
  BUILTIN_RULE_IDS,
  BUILTIN_RULE_PATTERNS,
  validateRuleExpression,
  type RulePattern,
  type RuleRole,
} from "@media-track/workflow/ruleset";

/** 识别规则编辑 wire 类型。ruleId 六大内置槽位固定；其余 ruleId = 自定义规则。 */
export type RulePatternDraft = {
  ruleId: string;
  role: string;
  expression: string;
  label?: string;
  sortOrder: number;
  isDefault?: boolean;
};


/**
 * 单行校验。内置规则留空 = 恢复内置默认（允许，内置分支仍生效）；其余空表达式 / 捕获组不足 / 非法正则 → 错误文案。
 * 与服务端 saveRulePatternsAction 共用同一 validateRuleExpression。
 */
export function ruleRowError(row: RulePatternDraft): string | null {
  const expression = row.expression.trim();
  if (expression.length === 0 && BUILTIN_RULE_IDS.has(row.ruleId)) return null;
  if (expression.length === 0) return "正则不能为空";
  return validateRuleExpression(row.role as RuleRole, expression);
}

/** 保存时剔除留空的内置行（= 恢复内置默认）。注：缺失行在采集时经 ?? 回退内置正则仍生效，
 *  当前版本不支持真正禁用内置分支（Phase 3 复核 S1）。 */
export function filterDisabledBuiltins(rows: RulePatternDraft[]): RulePatternDraft[] {
  return rows.filter((row) => !(BUILTIN_RULE_IDS.has(row.ruleId) && row.expression.trim().length === 0));
}


/**
 * issue #44 UI 重构:解析规则按 role 拆成两个区块(2026-09-07 用户拍板「(a) UI 分组」)。
 * - 季集区块(S:)—— 文件名里带季号的写法;内置槽位 sxxexx / variant / cross;
 * - 纯集号区块(E:)—— 文件名里只有集号的写法;内置槽位 ep-only / chinese / digits。
 * 区块内行格式:S:/E: 前缀 + 正则(`#` 开头为注释、空行忽略);前 N 个内容行 = 该角色的内置槽位
 * (BUILTIN_RULE_PATTERNS 顺序,留空 = 恢复内置),其后 = 该角色的自定义规则(行序 = 优先级)。
 * 跨区块自定义优先级:S 区块在前、E 区块在后,与两个区块的视觉顺序一致。
 */

/** 区块角色(S 在前)。 */
type BlockRole = RuleRole;

/** 两个区块的角色顺序(S 在前,自定义序号也随之)。 */
export const BLOCK_ORDER: readonly BlockRole[] = ["season-episode", "episode-only"];

/** 内置槽位总数(自定义 sortOrder 从它之后开始)。 */
export const BUILTIN_RULE_TOTAL = BUILTIN_RULE_PATTERNS.length;

/** 某角色的内置槽位(BUILTIN_RULE_PATTERNS 顺序 = 区块内行序)。 */
export function builtinSlotsFor(role: BlockRole): readonly RulePattern[] {
  return BUILTIN_RULE_PATTERNS.filter((p) => p.role === role);
}

/** 区块内行号错误 + 该行的规则草稿(补位的空内置槽位无行号)。 */
interface PositionedRow {
  row: RulePatternDraft;
  lineNo: number;
}

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

/**
 * 解析单个区块。customBase = 该区块自定义规则在「全表自定义序号」中的起点偏移
 * (S 区块 0;E 区块 = S 区块自定义条数),保证跨区块优先级可复现。
 * 返回行级错误(行号 → 文案)。
 */
export function parseRuleBlock(text: string, role: BlockRole, customBase = 0): {
  rows: RulePatternDraft[];
  errors: Record<string, string>;
} {
  const slots = builtinSlotsFor(role);
  const prefix = role === "season-episode" ? "S" : "E";
  const slotName = role === "season-episode" ? "季+集" : "仅集号";
  const lines = text.split(/\r?\n/);
  const errors: Record<string, string> = {};
  const positioned: PositionedRow[] = [];
  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) return;
    const parsed = ruleBlockPrefix(line);
    if (!parsed || parsed.role !== role) {
      errors[String(lineNo)] = "本区块只接受 " + prefix + ": 正则(" + slotName + ";或以 # 开头的注释)";
      return;
    }
    const { expression } = parsed;
    const slotIndex = positioned.length;
    if (slotIndex < slots.length) {
      const slot = slots[slotIndex]!;
      positioned.push({
        row: {
          ruleId: slot.ruleId,
          role: slot.role,
          expression,
          label: slot.label ?? "",
          sortOrder: slot.sortOrder,
          isDefault: true,
        },
        lineNo,
      });
    } else {
      const seq = customBase + (slotIndex - slots.length) + 1;
      positioned.push({
        row: {
          ruleId: "custom-" + seq,
          role,
          expression,
          label: "自定义规则",
          sortOrder: BUILTIN_RULE_TOTAL + seq,
          isDefault: false,
        },
        lineNo,
      });
    }
  });
  // 缺失内置补空行(用户删了内置行 → 留空 = 恢复内置)。
  while (positioned.length < slots.length) {
    const slot = slots[positioned.length]!;
    positioned.push({
      row: {
        ruleId: slot.ruleId,
        role: slot.role,
        expression: "",
        label: slot.label ?? "",
        sortOrder: slot.sortOrder,
        isDefault: true,
      },
      lineNo: -1,
    });
  }
  // 行级校验(正则合法性 / 捕获组契约),与保存 action 同源;再叠一个槽位错位探测。
  for (const { row, lineNo } of positioned) {
    if (lineNo < 0) continue; // 补位的空内置槽位无需校验(留空 = 恢复内置)
    const error = ruleRowError(row);
    if (error !== null) {
      errors[String(lineNo)] = error;
      continue;
    }
    const shift = builtinShiftHint(row);
    if (shift !== null) errors[String(lineNo)] = shift;
  }
  return { rows: positioned.map((p) => p.row), errors };
}

/**
 * 内置槽位错位探测:槽位被填成了「另一条内置规则的默认正则」→ 用户多半删掉了中间某行,
 * 后续行整体左移撞进错误槽位。拆区块后同区块内前缀一致,前缀-角色校验拦不住这种情况。
 * 非内置槽位 / 空表达式 / 与自身默认一致 → 不提示。
 */
function builtinShiftHint(row: RulePatternDraft): string | null {
  if (!BUILTIN_RULE_IDS.has(row.ruleId) || row.expression.trim().length === 0) return null;
  const own = BUILTIN_RULE_PATTERNS.find((p) => p.ruleId === row.ruleId);
  if (own?.expression.trim() === row.expression.trim()) return null;
  const other = BUILTIN_RULE_PATTERNS.find(
    (p) => p.ruleId !== row.ruleId && p.expression.trim() === row.expression.trim(),
  );
  if (!other) return null;
  return "这一行看起来是内置「" + (other.label ?? other.ruleId) + "」的正则——中间是否有内置行被删掉,导致槽位左移错位?";
}

/**
 * 规则行 → 两个区块 { season, episode }。每个区块内:内置槽位(BUILTIN_RULE_PATTERNS 顺序)
 * 在前,其后是该角色的自定义规则(按 sortOrder 升序 = 用户优先级)。
 */
export function formatRuleBlocks(rows: RulePatternDraft[]): { season: string; episode: string } {
  const out: { season: string; episode: string } = { season: "", episode: "" };
  for (const role of BLOCK_ORDER) {
    const slots = builtinSlotsFor(role);
    const builtinRows = slots.map(
      (slot) =>
        rows.find((r) => r.ruleId === slot.ruleId) ??
        {
          ruleId: slot.ruleId,
          role: slot.role,
          expression: "",
          label: slot.label ?? "",
          sortOrder: slot.sortOrder,
          isDefault: true,
        },
    );
    const customRows = rows
      .filter((r) => r.role === role && !BUILTIN_RULE_IDS.has(r.ruleId))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const lines = [...builtinRows.map(rowToBlockLine), ...customRows.map(rowToBlockLine)];
    out[role === "season-episode" ? "season" : "episode"] = lines.join("\n");
  }
  return out;
}

/** 两个区块文本 → 全部规则行 + 分区块错误(S 区块自定义序号从 0 起,E 区块接在其后)。 */
export function parseRuleBlocks(seasonText: string, episodeText: string): {
  rows: RulePatternDraft[];
  errors: { season: Record<string, string>; episode: Record<string, string> };
} {
  const season = parseRuleBlock(seasonText, "season-episode", 0);
  const seasonCustoms = season.rows.filter((r) => !BUILTIN_RULE_IDS.has(r.ruleId)).length;
  const episode = parseRuleBlock(episodeText, "episode-only", seasonCustoms);
  return {
    rows: [...season.rows, ...episode.rows],
    errors: { season: season.errors, episode: episode.errors },
  };
}
