import { describe, expect, it } from "vitest";
import {
  BUILTIN_ID_SET,
  filterDisabledBuiltins,
  formatRuleBlocks,
  parseRuleBlock,
  parseRuleBlocks,
  ruleRowError,
  type RulePatternDraft,
} from "./rule-patterns-utils";

const SX = "[Ss](\\d{1,2})[Ee](\\d{1,4})";
const VAR = "[Ss](\\d{1,2})\\s*[. ]\\s*[Ee](\\d{1,4})(?!\\d)";
const EPO = "(?:^|[^A-Za-z0-9])[Ee][Pp]?\\.?\\s*(\\d{1,4})(?:$|[^0-9])";
const CROSS = "(?:^|[^A-Za-z0-9])(\\d{1,2})\\s*[x×]\\s*(\\d{1,4})(?:$|[^0-9])";
const CHN = "第\\s*(\\d{1,4})\\s*(?:集|话|話|期)";
const DIG = "^(\\d{1,3})$";

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

describe("两区块 ↔ 规则行(issue #44 UI 分组)", () => {
  it("formatRuleBlocks:内置按 role 归堆到各自区块,自定义追加在区块末尾", () => {
    const rows: RulePatternDraft[] = [
      { ruleId: "sxxexx", role: "season-episode", expression: SX, sortOrder: 0, isDefault: true },
      { ruleId: "ep-only", role: "episode-only", expression: EPO, sortOrder: 2, isDefault: true },
      { ruleId: "custom-1", role: "season-episode", expression: "Q(\\d{1,2})P(\\d{1,3})", sortOrder: 7, isDefault: false },
      { ruleId: "custom-2", role: "episode-only", expression: "第(\\d+)回", sortOrder: 8, isDefault: false },
    ];
    const blocks = formatRuleBlocks(rows);
    expect(blocks.season.split("\n")).toEqual([
      "S: " + SX,
      "S: ",
      "S: ",
      "S: Q(\\d{1,2})P(\\d{1,3})",
    ]);
    expect(blocks.episode.split("\n")).toEqual([
      "E: " + EPO,
      "E: ",
      "E: ",
      "E: 第(\\d+)回",
    ]);
  });

  it("parseRuleBlocks:两块各 3 内置 + 自定义 → 全部映射、无错误", () => {
    const season = ["# 注释行(忽略)", "", "S: " + SX, "S: " + VAR, "S: " + CROSS, "S: Q(\\d{1,2})P(\\d{1,3})"].join("\n");
    const episode = ["E: " + EPO, "E: " + CHN, "E: " + DIG, "E: 第(\\d+)回"].join("\n");
    const { rows, errors } = parseRuleBlocks(season, episode);
    expect(errors).toEqual({ season: {}, episode: {} });
    expect(rows.map((r) => r.ruleId)).toEqual([
      "sxxexx", "variant", "cross", "custom-1", "ep-only", "chinese", "digits", "custom-2",
    ]);
    expect(rows[0]?.expression).toBe(SX);
    expect(rows[3]?.role).toBe("season-episode");
    expect(rows[3]?.expression).toBe("Q(\\d{1,2})P(\\d{1,3})");
    expect(rows[3]?.sortOrder).toBe(7);
    // E 区块自定义接在 S 区块自定义之后(customBase 传导)
    expect(rows[7]?.ruleId).toBe("custom-2");
    expect(rows[7]?.sortOrder).toBe(8);
  });

  it("parseRuleBlock:角色前缀放错区块 → 报本区块只接受该前缀", () => {
    const { rows, errors } = parseRuleBlock("E: " + SX, "season-episode");
    expect(rows[0]?.ruleId).toBe("sxxexx"); // 补位占位
    expect(rows[0]?.expression).toBe("");
    expect(Object.values(errors)).toEqual(["本区块只接受 S: 正则(季+集;或以 # 开头的注释)"]);
  });

  it("parseRuleBlock:前缀一致但捕获组不足 → 报捕获组契约错误", () => {
    const { rows, errors } = parseRuleBlock("S: " + CHN, "season-episode");
    expect(rows[0]?.ruleId).toBe("sxxexx");
    expect(rows[0]?.expression).toBe(CHN);
    expect(Object.values(errors).some((m) => m.includes("捕获组"))).toBe(true);
  });

  it("parseRuleBlock:删中间内置行(variant)→ 错位探测提示,不再静默左移", () => {
    // 删掉 variant 行:SXXEXX 正常占第 1 槽,CROSS 左移撞进第 2 槽(variant),
    // 第 3 行的自定义正则再左移撞进 cross 槽位。
    const block = ["S: " + SX, "S: " + CROSS, "S: ^EP(\\d+)$"].join("\n");
    const { rows, errors } = parseRuleBlock(block, "season-episode");
    // 第 2 行 → 错位提示(内容字面等于另一条内置默认);第 3 行 → 捕获组不足。
    expect(Object.values(errors).some((m) => m.includes("1×01 / 1x01") && m.includes("槽位左移错位"))).toBe(true);
    expect(Object.values(errors).some((m) => m.includes("捕获组不足"))).toBe(true);
    expect(rows.map((r) => r.ruleId)).toEqual(["sxxexx", "variant", "cross"]);
    expect(rows.every((r) => BUILTIN_ID_SET.has(r.ruleId))).toBe(true);
  });

  it("parseRuleBlock:自定义行(内置之后)内容等于其它内置默认 → 不误报错位", () => {
    // 错位探测必须只在「内置槽位」上生效:第 4 行是自定义,内容再字面等于某条内置默认
    // (这里是 SxxExx 默认)也不该拦保存——否则用户想复用一段内置正则写自定义会被误伤。
    // 放在 E 区块是因为 season-episode 的两组内置默认都在同一区块、无法自造「另一条内置」。
    const block = ["E: " + EPO, "E: " + CHN, "E: " + DIG, "E: " + SX].join("\n");
    const { rows, errors } = parseRuleBlock(block, "episode-only");
    expect(errors).toEqual({});
    expect(rows[3]?.ruleId).toBe("custom-1");
    expect(rows[3]?.sortOrder).toBe(7);
    expect(rows[3]?.expression).toBe(SX);
  });
  it("parseRuleBlock:用户删除全部内置行 → 补空行(恢复内置)", () => {
    const { rows, errors } = parseRuleBlock("", "episode-only");
    expect(errors).toEqual({});
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.ruleId)).toEqual(["ep-only", "chinese", "digits"]);
    expect(rows.every((r) => r.expression.length === 0)).toBe(true);
  });

  it("parseRuleBlocks:round-trip(格式化再解析)行集合稳定", () => {
    const blocks = { season: "S: " + SX + "\nS: " + VAR + "\nS: " + CROSS, episode: "E: \nE: \nE: " + DIG };
    const { rows } = parseRuleBlocks(blocks.season, blocks.episode);
    expect(formatRuleBlocks(rows)).toEqual(blocks);
  });

  it("parseRuleBlock:留空的内置槽位不计行号错误(补位跳过校验)", () => {
    const { rows, errors } = parseRuleBlock("S: " + SX, "season-episode");
    expect(errors).toEqual({});
    expect(rows.length).toBe(3);
    expect(rows[1]?.expression).toBe("");
  });
});

