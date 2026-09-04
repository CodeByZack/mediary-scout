import { describe, expect, it } from "vitest";
import {
  collectRowErrors,
  filterDisabledBuiltins,
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

describe("collectRowErrors", () => {
  it("只汇总未通过的行", () => {
    const rows = [
      row({ ruleId: "sxxexx", role: "season-episode", expression: "" }), // 停用,不报错
      row({ ruleId: "custom-1", expression: "" }), // 报错
    ];
    expect(collectRowErrors(rows)).toEqual({ "custom-1": "正则不能为空" });
  });
});
