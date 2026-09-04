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
