import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { arbitrateEpisodeMapping, resolvePromptText, PROMPT_TEMPLATES } from "../src/acquisition-v2/arbitrator.js";
import { EPISODE_MAPPING_BODY_SINGLE, EPISODE_MAPPING_BODY_MULTI } from "../src/prompt-templates.js";
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

describe("issue #53 — 多季/单季 episode-mapping body 变体", () => {
  it("D1: 单季 body 包含'文件名'措辞", () => {
    expect(EPISODE_MAPPING_BODY_SINGLE).toContain("文件名");
    expect(EPISODE_MAPPING_BODY_SINGLE).not.toContain("文件路径");
  });

  it("D2: 多季 body 包含'文件路径'措辞", () => {
    expect(EPISODE_MAPPING_BODY_MULTI).toContain("文件路径");
    expect(EPISODE_MAPPING_BODY_MULTI).not.toContain("文件名与集数");
  });

  it("D3: PROMPT_TEMPLATES 默认使用单季 body(零回归)", () => {
    expect(PROMPT_TEMPLATES["episode-mapping"].body).toBe(EPISODE_MAPPING_BODY_SINGLE);
  });

  it("D4: 覆盖 body 时 head/tail 固定不变", () => {
    const text = resolvePromptText("episode-mapping", { "episode-mapping": "自定义规则" });
    expect(text.startsWith(PROMPT_TEMPLATES["episode-mapping"].head)).toBe(true);
    expect(text.endsWith(PROMPT_TEMPLATES["episode-mapping"].tail)).toBe(true);
    expect(text).toContain("自定义规则");
  });
});

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

/** 记录实际收到的 system prompt 的假模型(2026-09-12 接线测试)。 */
function capturingModel(captured: string[]) {
  return new MockLanguageModelV3({
    doGenerate: async (args: { prompt?: Array<{ role: string; content: unknown }> }) => {
      const part = (c: unknown): string =>
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? (c as Array<{ text?: string }>)
                .map((p) => p.text ?? "")
                .join("")
            : "";
      captured.push((args.prompt ?? []).map((m) => `${m.role}::${part(m.content)}`).join("\n"));
      return {
        content: [{ type: "text" as const, text: '{"mapping":{},"unmapped":[],"reasoning":"probe"}' }],
        finishReason: { unified: "stop" as const, raw: "stop" as const },
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

describe("arbitrateEpisodeMapping body 接线(2026-09-12 空覆盖误伤修复)", () => {
  const base = {
    allFiles: ["2025.07.27-第1期上.mp4"],
    title: "地球超新鲜",
    knownEpisodeRange: { min: 1, max: 20 } as const,
  };

  it("E1: 无 overrides + 多季 → system 用 MULTI body", async () => {
    const seen: string[] = [];
    await arbitrateEpisodeMapping({ model: capturingModel(seen), seasons: [1, 2], ...base });
    expect(seen[0]).toContain(EPISODE_MAPPING_BODY_MULTI);
    expect(seen[0]).not.toContain(EPISODE_MAPPING_BODY_SINGLE);
  });

  it("E2: 空对象 {} + 多季 → 仍用 MULTI body(回归:旧 truthy 判断被 {} 误伤)", async () => {
    const seen: string[] = [];
    await arbitrateEpisodeMapping({ model: capturingModel(seen), seasons: [1, 2], ...base, promptOverrides: {} });
    expect(seen[0]).toContain(EPISODE_MAPPING_BODY_MULTI);
    expect(seen[0]).not.toContain(EPISODE_MAPPING_BODY_SINGLE);
  });

  it("E3: 空对象 {} + 单季 → 用 SINGLE body(单季零回归)", async () => {
    const seen: string[] = [];
    await arbitrateEpisodeMapping({ model: capturingModel(seen), seasons: [1], ...base, promptOverrides: {} });
    expect(seen[0]).toContain(EPISODE_MAPPING_BODY_SINGLE);
    expect(seen[0]).not.toContain(EPISODE_MAPPING_BODY_MULTI);
  });

  it("E4: 已覆盖 episode-mapping + 多季 → 自定义正文优先(单季/多季共用)", async () => {
    const seen: string[] = [];
    await arbitrateEpisodeMapping({
      model: capturingModel(seen),
      seasons: [1, 2],
      ...base,
      promptOverrides: { "episode-mapping": "自定义正文" },
    });
    expect(seen[0]).toContain("自定义正文");
    expect(seen[0]).not.toContain(EPISODE_MAPPING_BODY_MULTI);
    expect(seen[0]).not.toContain(EPISODE_MAPPING_BODY_SINGLE);
  });
});
