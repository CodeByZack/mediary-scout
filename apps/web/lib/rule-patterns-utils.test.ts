import { describe, expect, it } from "vitest";
import {
  collectRowErrors,
  filterDisabledBuiltins,
  formatRuleBlock,
  parseRuleBlock,
  ruleRowError,
  type RulePatternDraft,
} from "./rule-patterns-utils";

function row(overrides: Partial<RulePatternDraft>): RulePatternDraft {
  return { ruleId: "digits", role: "episode-only", expression: "^([0-9]{1,4})$", label: "纯数字", sortOrder: 5, isDefault: true, ...overrides };
}

describe("ruleRowError", () => {
  it("内置槽位留空 = 停用,不报错(M1)", () => {
    expect(ruleRowError(row({ ruleId: "sxxexx", role: "season-episode", expression: "  " }))).toBeNull();
  });

  it("自定义规则留空仍报错", () => {
    expect(ruleRowError(row({ ruleId: "custom-1", expression: "" }))).toBe("正则不能为空");
  });

  it("捕获组不足报错(仅集号需 1 组、季+集需 2 组)", () => {
    expect(ruleRowError(row({ role: "season-episode", expression: "^([0-9]{1,2})$" }))).toContain("捕获组不足");
  });

  it("合法正则通过", () => {
    expect(ruleRowError(row({}))).toBeNull();
  });
});

describe("filterDisabledBuiltins", () => {
  it("剔除留空的内置行,保留已填内置与自定义行", () => {
    const rows = [
      row({ ruleId: "sxxexx", role: "season-episode", expression: "" }),
      row({ ruleId: "digits", expression: "^([0-9]{1,4})$" }),
      row({ ruleId: "custom-1", expression: "^([0-9]{1,4})$" }),
    ];
    expect(filterDisabledBuiltins(rows).map((r) => r.ruleId)).toEqual(["digits", "custom-1"]);
  });
});


describe("文本块 ↔ 规则行(issue #44 UI 重构)", () => {
  it("formatRuleBlock:内置槽位按顺序输出 S:/E: 前缀,自定义追加在后", () => {
    const rows: RulePatternDraft[] = [
      { ruleId: "sxxexx", role: "season-episode", expression: "[Ss](\\d{1,2})[Ee](\\d{1,4})", sortOrder: 0, isDefault: true },
      { ruleId: "ep-only", role: "episode-only", expression: "(?:^|[^A-Za-z0-9])[Ee][Pp]?\\.?\\s*(\\d{1,4})(?:$|[^0-9])", sortOrder: 2, isDefault: true },
      { ruleId: "custom-1", role: "episode-only", expression: "^EP(\\d+)$", sortOrder: 7, isDefault: false },
    ];
    const block = formatRuleBlock(rows);
    expect(block).toContain("S: [Ss](\\d{1,2})[Ee](\\d{1,4})");
    expect(block).toContain("E: (?:^|[^A-Za-z0-9])[Ee][Pp]?\\.?\\s*(\\d{1,4})(?:$|[^0-9])");
    expect(block).toContain("E: ^EP(\\d+)$");
    expect(block.startsWith("S: ")).toBe(true); // 不再带注释头,直接以规则行开头
  });

  it("parseRuleBlock:完整 6 内置(正确前缀)+ 自定义行 → 全部映射、无错误", () => {
    const block = [
      "# 注释行(忽略)",
      "",
      "S: [Ss](\\d{1,2})[Ee](\\d{1,4})",
      "S: [Ss](\\d{1,2})\\s*[. ]\\s*[Ee](\\d{1,4})(?!\\d)",
      "E: (?:^|[^A-Za-z0-9])[Ee][Pp]?\\.?\\s*(\\d{1,4})(?:$|[^0-9])",
      "S: (?:^|[^A-Za-z0-9])(\\d{1,2})\\s*[x×]\\s*(\\d{1,4})(?:$|[^0-9])",
      "E: 第\\s*(\\d{1,4})\\s*(?:集|话|話|期)",
      "E: ^(\\d{1,3})$",
      "E: ^EP(\\d+)$",
    ].join("\n");
    const { rows, errors } = parseRuleBlock(block);
    expect(errors).toEqual({});
    expect(rows.map((r) => r.ruleId)).toEqual([
      "sxxexx", "variant", "ep-only", "cross", "chinese", "digits", "custom-1",
    ]);
    expect(rows[0]?.expression).toBe("[Ss](\\d{1,2})[Ee](\\d{1,4})");
    expect(rows[6]?.role).toBe("episode-only");
    expect(rows[6]?.expression).toBe("^EP(\\d+)$");
    expect(rows[6]?.sortOrder).toBe(7);
  });
  it("parseRuleBlock:E 前缀打在 S 槽位(sxxexx) → 报前缀-角色不符", () => {
    const block = "E: [Ss](\\d{1,2})[Ee](\\d{1,4})";
    const { rows, errors } = parseRuleBlock(block);
    expect(rows[0]?.ruleId).toBe("sxxexx"); // 补位占位
    expect(rows[0]?.expression).toBe("");
    expect(errors["1"]).toContain("内置槽位 sxxexx 的前缀固定为 S");
  });

  it("parseRuleBlock:前缀与槽位角色一致但捕获组不足 → 报捕获组契约错误", () => {
    const block = "S: 第\\s*(\\d{1,4})\\s*(?:集|话|話|期)"; // S 前缀对 sxxexx,但仅 1 组
    const { rows, errors } = parseRuleBlock(block);
    expect(rows[0]?.ruleId).toBe("sxxexx");
    expect(rows[0]?.expression).toBe("第\\s*(\\d{1,4})\\s*(?:集|话|話|期)");
    expect(Object.values(errors).some((m) => m.includes("捕获组"))).toBe(true);
  });

  it("parseRuleBlock:删中间内置行(留 5 行 + 自定义) → 后续行错位被前缀-角色校验拦住", () => {
    // 模拟删了 cross 行:第 4 行(原 chinese,E 前缀)撞 cross(S 槽) → 报错,不再静默。
    const block = [
      "S: [Ss](\\d{1,2})[Ee](\\d{1,4})",
      "S: [Ss](\\d{1,2})\\s*[. ]\\s*[Ee](\\d{1,4})(?!\\d)",
      "E: (?:^|[^A-Za-z0-9])[Ee][Pp]?\\.?\\s*(\\d{1,4})(?:$|[^0-9])",
      "E: 第\\s*(\\d{1,4})\\s*(?:集|话|話|期)",
      "E: ^(\\d{1,3})$",
      "E: ^EP(\\d+)$",
    ].join("\n");
    const { rows, errors } = parseRuleBlock(block);
    // 第 4 个内容行(E 前缀)映射到 cross(S 槽) → 前缀-角色不符报错;digits 槽补位空。
    expect(Object.values(errors).some((m) => m.includes("内置槽位 cross 的前缀固定为 S"))).toBe(true);
    expect(rows.filter((r) => r.ruleId === "digits")[0]?.expression).toBe("");
  });
  it("parseRuleBlock:用户删除全部内置行 → 补空行(恢复内置)", () => {
    const { rows, errors } = parseRuleBlock("");
    expect(errors).toEqual({});
    expect(rows.length).toBe(6);
    expect(rows[0]?.ruleId).toBe("sxxexx");
    expect(rows[0]?.expression).toBe("");
    expect(rows.every((r) => r.expression.length === 0)).toBe(true);
  });
});
describe("collectRowErrors", () => {
  it("只汇总未通过的行", () => {
    const rows = [
      row({ ruleId: "sxxexx", role: "season-episode", expression: "" }), // 停用,不报错
      row({ ruleId: "custom-1", expression: "" }), // 报错
    ];
    expect(collectRowErrors(rows)).toEqual({ "custom-1": "正则不能为空" });
  });
});
