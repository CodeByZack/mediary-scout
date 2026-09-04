import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import { DemoReadOnlyError } from "../lib/demo-mode";

// 用真实 :memory: 库跑 action 级验证(M1 过滤/整批失败/自定义保存/恢复默认)。
process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";

describe("识别规则 actions (issue #44)", () => {
  let actions: typeof import("./actions");
  let getWorkflowRepository: typeof import("../lib/workflow-runtime").getWorkflowRepository;

  beforeAll(async () => {
    [actions, getWorkflowRepository] = await Promise.all([
      import("./actions"),
      import("../lib/workflow-runtime").then((m) => m.getWorkflowRepository),
    ]);
  }, 30_000);

  beforeEach(async () => {
    // 每个用例从空表开始(:memory: 库在模块级缓存,用例间共享)。
    await getWorkflowRepository().replaceRulePatterns([]);
  });

  afterEach(() => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
  });

  it("demo 模式拒绝写", async () => {
    process.env.MEDIA_TRACK_DEMO_MODE = "1";
    await expect(actions.saveRulePatternsAction([])).rejects.toBeInstanceOf(DemoReadOnlyError);
    await expect(actions.resetRulePatternsAction()).rejects.toBeInstanceOf(DemoReadOnlyError);
    await expect(actions.savePromptOverridesAction([])).rejects.toBeInstanceOf(DemoReadOnlyError);
    await expect(actions.resetPromptOverridesAction()).rejects.toBeInstanceOf(DemoReadOnlyError);
  });

  it("M1:留空的内置行保存时剔除(停用),不报错", async () => {
    const res = await actions.saveRulePatternsAction([
      { ruleId: "sxxexx", role: "season-episode", expression: "", label: "", sortOrder: 0, isDefault: true },
      { ruleId: "digits", role: "episode-only", expression: "^([0-9]{1,4})$", label: "纯数字", sortOrder: 5, isDefault: false },
    ]);
    expect(res.success).toBe(true);
    const rows = await getWorkflowRepository().listRulePatterns();
    expect(rows.map((r) => r.ruleId)).toEqual(["digits"]);
  });

  it("任一自定义行校验失败 → 整批不落库,errors 逐行返回", async () => {
    const res = await actions.saveRulePatternsAction([
      { ruleId: "digits", role: "episode-only", expression: "^([0-9]{1,4})$", label: "", sortOrder: 5, isDefault: false },
      { ruleId: "custom-bad", role: "episode-only", expression: "([unclosed", label: "坏", sortOrder: 6, isDefault: false },
    ]);
    expect(res.success).toBe(false);
    expect(res.errors?.["custom-bad"]).toBe("不是合法的正则表达式");
    expect(await getWorkflowRepository().listRulePatterns()).toEqual([]); // 整批未落库
  });

  it("恢复默认 = 清空表(回退内置)", async () => {
    const res = await actions.resetRulePatternsAction();
    expect(res.success).toBe(true);
    expect(await getWorkflowRepository().listRulePatterns()).toEqual([]);
  });
});

describe("AI 仲裁提示词 actions (issue #44 Phase 2)", () => {
  let actions: typeof import("./actions");
  let getWorkflowRepository: typeof import("../lib/workflow-runtime").getWorkflowRepository;

  beforeAll(async () => {
    [actions, getWorkflowRepository] = await Promise.all([
      import("./actions"),
      import("../lib/workflow-runtime").then((m) => m.getWorkflowRepository),
    ]);
  }, 30_000);

  beforeEach(async () => {
    await getWorkflowRepository().replacePromptOverrides([]);
  });

  afterEach(() => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
  });

  it("保存覆盖(kind → body),空体 kind 不落库", async () => {
    const res = await actions.savePromptOverridesAction([
      { arbitrationKind: "selection", promptText: "规则甲\n- 只看 B 级" },
      { arbitrationKind: "movie-selection", promptText: "   " }, // 空体 = 内置,不写行
    ]);
    expect(res.success).toBe(true);
    const rows = await getWorkflowRepository().listPromptOverrides();
    expect(rows.map((o) => o.arbitrationKind)).toEqual(["selection"]);
    expect(rows[0]?.promptText).toBe("规则甲\n- 只看 B 级");
  });

  it("超长 body → 整批不落库 + errors 逐 kind 返回", async () => {
    const res = await actions.savePromptOverridesAction([
      { arbitrationKind: "selection", promptText: "x".repeat(2001) },
    ]);
    expect(res.success).toBe(false);
    expect(res.errors?.["selection"]).toContain("提示词过长");
    expect(await getWorkflowRepository().listPromptOverrides()).toEqual([]);
  });

  it("未知 kind → errors,不落库", async () => {
    const res = await actions.savePromptOverridesAction([
      { arbitrationKind: "not-a-kind", promptText: "whatever" },
    ]);
    expect(res.success).toBe(false);
    expect(res.errors?.["not-a-kind"]).toBe("未知 kind");
  });

  it("恢复默认 = 清空 prompt_overrides", async () => {
    await actions.savePromptOverridesAction([{ arbitrationKind: "selection", promptText: "规则甲" }]);
    const res = await actions.resetPromptOverridesAction();
    expect(res.success).toBe(true);
    expect(await getWorkflowRepository().listPromptOverrides()).toEqual([]);
  });
});

