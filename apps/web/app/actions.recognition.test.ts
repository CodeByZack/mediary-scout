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

  it("M1:留空的内置行保存时剔除(= 恢复内置默认),不报错", async () => {
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

describe("解析测试台 testEpisodeRuleAction (issue #44 Phase 3)", () => {
  let actions: typeof import("./actions");
  let getWorkflowRepository: typeof import("../lib/workflow-runtime").getWorkflowRepository;

  beforeAll(async () => {
    [actions, getWorkflowRepository] = await Promise.all([
      import("./actions"),
      import("../lib/workflow-runtime").then((m) => m.getWorkflowRepository),
    ]);
  }, 30_000);

  beforeEach(async () => {
    await getWorkflowRepository().replaceRulePatterns([]);
  });

  it("内置规则:标准 SxxExx 命中 sxxexx 槽位", async () => {
    const r = await actions.testEpisodeRuleAction({ fileName: "狂飙.S01E01.1080p.mkv", multiSeason: false });
    expect(r.code).toBe("S01E01");
    expect(r.matched).toBe("sxxexx");
  });

  it("内置规则:第N集单季命中 chinese,多季禁用无季规则 → null", async () => {
    const single = await actions.testEpisodeRuleAction({ fileName: "第3集.mkv", multiSeason: false });
    expect(single.code).toBe("S01E03");
    expect(single.matched).toBe("chinese");
    const multi = await actions.testEpisodeRuleAction({ fileName: "第3集.mkv", multiSeason: true });
    expect(multi.code).toBeNull();
    expect(multi.matched).toBeNull();
  });

  it("已保存自定义规则参与试跑:digits 槽位覆盖 4 位", async () => {
    await actions.saveRulePatternsAction([
      { ruleId: "digits", role: "episode-only", expression: "^([0-9]{1,4})$", label: "纯数字", sortOrder: 5, isDefault: false },
    ]);
    const r = await actions.testEpisodeRuleAction({ fileName: "0700.mkv", multiSeason: false });
    expect(r.code).toBe("S01E700");
    expect(r.matched).toBe("digits");
  });

  it("M1 回归:表中仅存部分行时,缺失内置槽位按内置回退命中(未停用)", async () => {
    // 只保存 digits 一行 → 其余内置槽位在真实路径经 ?? 回退内置正则仍生效,
    // 探针必须镜像该语义(compiled ?? 内置同源),不得误报无命中。
    await actions.saveRulePatternsAction([
      { ruleId: "digits", role: "episode-only", expression: "^([0-9]{1,4})$", label: "纯数字", sortOrder: 5, isDefault: false },
    ]);
    const sxx = await actions.testEpisodeRuleAction({ fileName: "狂飙.S01E01.1080p.mkv", multiSeason: false });
    expect(sxx.code).toBe("S01E01");
    expect(sxx.matched).toBe("sxxexx");
    const variant = await actions.testEpisodeRuleAction({ fileName: "S01 E01.mkv", multiSeason: false });
    expect(variant.code).toBe("S01E01");
    expect(variant.matched).toBe("variant");
    const chinese = await actions.testEpisodeRuleAction({ fileName: "第3集.mkv", multiSeason: false });
    expect(chinese.code).toBe("S01E03");
    expect(chinese.matched).toBe("chinese");
  });

  it("空文件名 → 提示", async () => {
    const r = await actions.testEpisodeRuleAction({ fileName: "   ", multiSeason: false });
    expect(r.message).toContain("文件名不能为空");
  });
});


