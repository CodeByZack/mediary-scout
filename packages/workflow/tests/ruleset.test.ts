import { describe, expect, it } from "vitest";
import {
  ARBITRATION_KINDS,
  BUILTIN_RULE_PATTERNS,
  compileRulePattern,
  countCaptureGroups,
  isArbitrationKind,
  loadPromptOverrides,
  loadRulePatterns,
  validateRuleExpression,
  type PromptOverride,
  type RulePattern,
  type RuleRole,
} from "../src/ruleset.js";

/** 内存版 RulePatternStore：模拟表内容。 */
function storeOf(rows: RulePattern[]) {
  return { listRulePatterns: async () => rows };
}
const promptStoreOf = (rows: PromptOverride[]) => ({ listPromptOverrides: async () => rows });

describe("countCaptureGroups", () => {
  it("counts exactly the capturing groups, skipping non-capturing/lookahead/escaped/class parens", () => {
    expect(countCaptureGroups("[Ss](\\d{1,2})[Ee](\\d{1,4})")).toBe(2);
    expect(countCaptureGroups("(?:^|[^A-Za-z0-9])[Ee][Pp]?\\.?\\s*(\\d{1,4})(?:$|[^0-9])")).toBe(1);
    expect(countCaptureGroups("第\\s*(\\d{1,4})\\s*(?:集|话|話|期)")).toBe(1);
    expect(countCaptureGroups("^\\d{1,3}$")).toBe(0);
    expect(countCaptureGroups("\\(literal\\, [x×]\\s*(\\d)")) .toBe(1);
    expect(countCaptureGroups("(?<year>\\d{4})-(\\d{2})")).toBe(2);
  });
});

describe("validateRuleExpression", () => {
  it("accepts every builtin pattern (they mirror episode-code.ts)", () => {
    for (const p of BUILTIN_RULE_PATTERNS) {
      expect(validateRuleExpression(p.role, p.expression), p.ruleId).toBeNull();
    }
  });

  it("rejects invalid regex source", () => {
    expect(validateRuleExpression("episode-only", "([unclosed")).toMatch(/不是合法的正则/);
  });

  it("rejects empty expression", () => {
    expect(validateRuleExpression("episode-only", "   ")).toMatch(/不能为空/);
  });

  it("rejects season-episode expressions missing the episode capture group", () => {
    expect(validateRuleExpression("season-episode", "[Ss](\\d{1,2})[Ee]\\d{1,4}")).toMatch(/捕获组不足/);
  });

  it("accepts extra capture groups (lenient on more), episode-only needs >= 1", () => {
    expect(validateRuleExpression("episode-only", "(\\d{1,4})")).toBeNull();
    expect(validateRuleExpression("episode-only", "^(\\d{1,3})(x)$")).toBeNull(); // 2 组 > 1，仍可用
  });

  it("rejects unknown role values", () => {
    expect(validateRuleExpression("bogus" as RuleRole, "(\\d{1,4})")).toMatch(/未知规则角色/);
  });

  it("rejects season-episode with zero capture groups", () => {
    expect(validateRuleExpression("season-episode", "S\\d+E\\d+")).toMatch(/捕获组不足/);
  });
});

describe("compileRulePattern", () => {
  it("compiles builtin digit pattern and consumes a plain number file name", () => {
    const re = compileRulePattern("^(\\d{1,3})$");
    expect(re).not.toBeNull();
    expect(re!.test("07")).toBe(true);
    expect(re!.test("07.mp4")).toBe(false); // 整名才认（代码侧先剥扩展名）
  });
  it("returns null for garbage", () => {
    expect(compileRulePattern("([unclosed")).toBeNull();
    expect(compileRulePattern("[a-")).toBeNull();
  });
});

describe("ARBITRATION_KINDS", () => {
  it("has exactly the four live production prompts (issue #44)", () => {
    expect(ARBITRATION_KINDS).toEqual(["selection", "episode-mapping", "movie-selection", "movie-diagnosis"]);
    expect(isArbitrationKind("selection")).toBe(true);
    expect(isArbitrationKind("diagnosis")).toBe(false); // TV DIAGNOSIS_SYSTEM 已死，不开放
  });
});

describe("loadRulePatterns", () => {
  it("falls back to builtins when the table is empty", async () => {
    const rules = await loadRulePatterns(storeOf([]));
    expect(rules).toEqual([...BUILTIN_RULE_PATTERNS]);
  });

  it("does NOT share references with the builtin constants (S2)", async () => {
    const rules = await loadRulePatterns(storeOf([]));
    rules[0]!.expression = "mutated";
    const again = await loadRulePatterns(storeOf([]));
    expect(again[0]!.expression).toBe(BUILTIN_RULE_PATTERNS[0]!.expression);
  });

  it("trims expressions on load, matching the validation contract (S4)", async () => {
    const rules = await loadRulePatterns(
      storeOf([{ ruleId: "digits", role: "episode-only", expression: "  ^(\\d{1,3})$  ", label: "纯数字", sortOrder: 5, isDefault: false }]),
    );
    expect(rules[0]?.expression).toBe("^(\\d{1,3})$");
  });

  it("overrides a builtin expression when present and valid", async () => {
    const rules = await loadRulePatterns(
      storeOf([
        { ruleId: "digits", role: "episode-only", expression: "^(\\d{1,4})$", label: "纯数字(4位)", sortOrder: 5, isDefault: true },
      ]),
    );
    const digits = rules.find((r) => r.ruleId === "digits");
    expect(digits?.expression).toBe("^(\\d{1,4})$");
    expect(digits?.label).toBe("纯数字(4位)");
    // 非空表：其余内置未写入 = 被停用，不出现
    expect(rules).toHaveLength(1);
  });

  it("falls back a corrupt builtin row to the builtin value", async () => {
    const rules = await loadRulePatterns(
      storeOf([{ ruleId: "sxxexx", role: "season-episode", expression: "([unclosed", label: "坏的正则", sortOrder: 0, isDefault: false }]),
    );
    const s = rules.find((r) => r.ruleId === "sxxexx");
    expect(s?.expression).toBe(BUILTIN_RULE_PATTERNS[0]!.expression);
  });

  it("appends valid custom rules after builtins by sortOrder and drops corrupt customs", async () => {
    const rows: RulePattern[] = [
      { ruleId: "sxxexx", role: "season-episode", expression: "[Ss](\\d{1,2})[Ee](\\d{1,4})", label: "SxxExx", sortOrder: 0, isDefault: true },
      { ruleId: "custom-underscore", role: "season-episode", expression: "[Ss](\\d{1,2})_(\\d{1,4})", label: "Sxx_Exx", sortOrder: 6, isDefault: false },
      { ruleId: "custom-broken", role: "episode-only", expression: "([broken", label: "坏自定义", sortOrder: 7, isDefault: false },
      { ruleId: "custom-unknown-role", role: "bogus" as RuleRole, expression: "(\\d+)", label: "角色未知", sortOrder: 8, isDefault: false },
    ];
    const rules = await loadRulePatterns(storeOf(rows));
    expect(rules.map((r) => r.ruleId)).toEqual(["sxxexx", "custom-underscore"]);
    expect(rules[1]?.expression).toBe("[Ss](\\d{1,2})_(\\d{1,4})");
  });
});

describe("loadPromptOverrides", () => {
  it("passes through override rows verbatim", async () => {
    const rows: PromptOverride[] = [
      { arbitrationKind: "selection", promptText: "自定义选片规则…", isActive: true },
    ];
    const out = await loadPromptOverrides(promptStoreOf(rows));
    expect(out).toEqual(rows);
  });
});

describe("compileEpisodeRules / loadEpisodeRules", () => {
  const example = async () => await loadRulePatterns({ listRulePatterns: async () => [] });

  it("maps builtin ruleIds to slots and non-builtin ids to custom", async () => {
    const { compileEpisodeRules } = await import("../src/ruleset.js");
    const rules = compileEpisodeRules([
      { ruleId: "sxxexx", role: "season-episode", expression: "[Ss](\\d{1,2})[Ee](\\d{1,4})", label: "", sortOrder: 0, isDefault: true },
      { ruleId: "ep-only", role: "episode-only", expression: "[Ee]P?(\\d{1,4})", label: "", sortOrder: 2, isDefault: true },
      { ruleId: "custom-underscore", role: "season-episode", expression: "[Ss](\\d{1,2})_(\\d{1,4})", label: "", sortOrder: 6, isDefault: false },
    ]);
    expect(rules.sxxexx?.source).toBe("[Ss](\\d{1,2})[Ee](\\d{1,4})");
    expect(rules.sxxexx?.test("Show.S01E03.1080p")).toBe(true);
    expect(rules.epOnly).toBeInstanceOf(RegExp);
    expect(rules.custom).toHaveLength(1);
    expect(rules.custom![0]!.role).toBe("season-episode");
  });

  it("loadEpisodeRules 端到端:空表 → 内置编译结果;编辑 digits → 覆盖生效", async () => {
    const { loadEpisodeRules } = await import("../src/ruleset.js");
    const { createSqliteWorkflowRepository } = await import("../src/sqlite.js");
    const repo = createSqliteWorkflowRepository({ path: ":memory:" });
    const empty = await loadEpisodeRules(repo);
    expect(empty.digits?.test("07")).toBe(true);
    expect(empty.digits?.test("0700")).toBe(false);
    await repo.replaceRulePatterns([
      { ruleId: "digits", role: "episode-only", expression: "^(\\d{1,4})$", label: "纯数字4位", sortOrder: 5, isDefault: false },
    ]);
    const edited = await loadEpisodeRules(repo);
    expect(edited.digits?.test("0700")).toBe(true);
    expect(edited.custom ?? []).toHaveLength(0);
  });
});

describe("repo + loader 端到端 (S7)", () => {
  it("replace([]) 清空后 loadRulePatterns 回退内置", async () => {
    const { createSqliteWorkflowRepository } = await import("../src/sqlite.js");
    const repo = createSqliteWorkflowRepository({ path: ":memory:" });
    await repo.replaceRulePatterns([
      { ruleId: "digits", role: "episode-only", expression: "^(\\d{1,4})$", label: "自定义纯数字", sortOrder: 5, isDefault: false },
    ]);
    const loaded = await loadRulePatterns(repo);
    expect(loaded.map((r) => r.ruleId)).toEqual(["digits"]);
    expect(loaded[0]?.expression).toBe("^(\\d{1,4})$");
    await repo.replaceRulePatterns([]); // 恢复默认 = 清空表
    const restored = await loadRulePatterns(repo);
    expect(restored.map((r) => r.ruleId)).toEqual(BUILTIN_RULE_PATTERNS.map((p) => p.ruleId));
    expect(restored[0]).not.toBe(BUILTIN_RULE_PATTERNS[0]); // 独立引用
  });
});
