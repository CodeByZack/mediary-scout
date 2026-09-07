import { describe, expect, it } from "vitest";
import { ruleRowError, type RulePatternDraft } from "./rule-patterns-utils";

function row(overrides: Partial<RulePatternDraft>): RulePatternDraft {
  return { ruleId: "custom-1", role: "episode-only", expression: "^([0-9]{1,4})$", label: "纯数字", sortOrder: 7, isDefault: false, ...overrides };
}

describe("ruleRowError (自定义规则;内置只读后无「留空=恢复」语义)", () => {
  it("空表达式报错", () => {
    expect(ruleRowError(row({ expression: "  " }))).toBe("正则不能为空");
  });

  it("非法正则报错", () => {
    expect(ruleRowError(row({ expression: "([unclosed" }))).toContain("不是合法的正则");
  });

  it("捕获组不足报错(仅集号需 1 组、季+集需 2 组)", () => {
    expect(ruleRowError(row({ role: "season-episode", expression: "^([0-9]{1,2})$" }))).toContain("捕获组不足");
  });

  it("合法正则通过(季+集 2 组 / 仅集号 1 组)", () => {
    expect(ruleRowError(row({ role: "season-episode", expression: "[Ss]([0-9]{1,2})_([0-9]{1,4})" }))).toBeNull();
    expect(ruleRowError(row({ expression: "^([0-9]{1,4})$" }))).toBeNull();
  });
});
