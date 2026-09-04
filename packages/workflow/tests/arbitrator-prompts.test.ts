import { describe, expect, it } from "vitest";
import { resolvePromptText, PROMPT_TEMPLATES } from "../src/acquisition-v2/arbitrator.js";
import {
  ARBITRATION_KINDS,
  compilePromptLookup,
  MAX_PROMPT_BODY_LENGTH,
  validatePromptBody,
} from "../src/ruleset.js";

describe("resolvePromptText (issue #44 Phase 2)", () => {
  it("缺省 = head + 内置 body + tail 重组的完整模板", () => {
    // selection 模板共 9 行:head 1 + body 6 + tail 2。
    const text = resolvePromptText("selection", undefined);
    const lines = text.split("\n");
    expect(lines[0]).toBe("你是剧集资源选片仲裁员。代码已把搜索候选按规则分级（A>B>C>D），但没有唯一高分，需要你从候选中选出最可能是目标剧集的那个资源。");
    expect(lines[lines.length - 2]).toContain("只输出 JSON");
    expect(lines[lines.length - 1]).toContain("candidateId");
    expect(lines).toContain("规则：");
  });

  it("覆盖 body 时 head/tail 固定不变", () => {
    const text = resolvePromptText("selection", { selection: "自定规则\n- 只看 B 级" });
    const lines = text.split("\n");
    expect(lines[0]).toBe(PROMPT_TEMPLATES.selection.head);
    expect(lines[lines.length - 1]).toBe(PROMPT_TEMPLATES.selection.tail.split("\n").pop());
    expect(text).toContain("自定规则");
    expect(text).not.toContain("规则："); // 内置 body 被覆盖
  });

  it("四种 kind 的模板结构完整(head≠空、tail 含 JSON 契约)", () => {
    for (const kind of ARBITRATION_KINDS) {
      const t = PROMPT_TEMPLATES[kind];
      expect(t.head.length).toBeGreaterThan(10);
      expect(t.body.length).toBeGreaterThan(10);
      expect(t.tail).toContain("只输出 JSON");
      const text = resolvePromptText(kind, undefined);
      expect(text.startsWith(t.head)).toBe(true);
      expect(text.endsWith(t.tail)).toBe(true);
    }
  });
});

describe("compilePromptLookup / validatePromptBody", () => {
  it("只收录 active + 合法 body 的行", () => {
    const lookup = compilePromptLookup([
      { arbitrationKind: "selection", promptText: "规则甲", isActive: true },
      { arbitrationKind: "movie-selection", promptText: "规则乙", isActive: false }, // inactive 跳过
      { arbitrationKind: "not-a-kind" as never, promptText: "未知", isActive: true }, // 未知 kind 跳过
      { arbitrationKind: "episode-mapping", promptText: "   ", isActive: true }, // 空体跳过
    ]);
    expect(lookup).toEqual({ selection: "规则甲" });
  });

  it("validatePromptBody:空 / 超长拒绝,边界 2000 通过", () => {
    expect(validatePromptBody("   ")).toBe("提示词不能为空");
    expect(validatePromptBody("x".repeat(MAX_PROMPT_BODY_LENGTH))).toBeNull();
    expect(validatePromptBody("x".repeat(MAX_PROMPT_BODY_LENGTH + 1))).toContain("提示词过长");
  });
});
