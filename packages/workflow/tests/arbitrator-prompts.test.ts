import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { arbitrateEpisodeMapping, resolvePromptText, PROMPT_TEMPLATES } from "../src/acquisition-v2/arbitrator.js";
import { EPISODE_MAPPING_BODY } from "../src/prompt-templates.js";
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

describe("episode-mapping body 合并(2026-09-12 用户拍板「合成一个」)", () => {
  it("D1: 合并正文同时覆盖两种输入——纯文件名与带文件夹的路径", () => {
    expect(EPISODE_MAPPING_BODY).toContain("纯文件名");
    expect(EPISODE_MAPPING_BODY).toContain("带文件夹");
  });

  it("D2: 季号来源明确——路径含季信息用它,否则用任务给的目标季", () => {
    expect(EPISODE_MAPPING_BODY).toContain("定 SxxExx 的季号");
    expect(EPISODE_MAPPING_BODY).toContain("用任务给的目标季");
  });

  it("D3: PROMPT_TEMPLATES 指向合并后的单版 body", () => {
    expect(PROMPT_TEMPLATES["episode-mapping"].body).toBe(EPISODE_MAPPING_BODY);
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

describe("arbitrateEpisodeMapping body 接线(2026-09-12 空覆盖误伤修复 + body 合并)", () => {
  const base = {
    allFiles: ["2025.07.27-第1期上.mp4"],
    title: "地球超新鲜",
    knownEpisodeRange: { min: 1, max: 20 } as const,
  };
  const HEADER = "需要识别集数的文件(可能是纯文件名,也可能带文件夹):";

  it("E1: 无 overrides + 多季 → 内置合并 body", async () => {
    const seen: string[] = [];
    await arbitrateEpisodeMapping({ model: capturingModel(seen), seasons: [1, 2], ...base });
    expect(seen[0]).toContain(EPISODE_MAPPING_BODY);
    expect(seen[0]).toContain(HEADER);
  });

  it("E2: 空对象 {} + 多季 → 仍用内置合并 body(回归:旧 truthy 判断被 {} 误伤)", async () => {
    const seen: string[] = [];
    await arbitrateEpisodeMapping({ model: capturingModel(seen), seasons: [1, 2], ...base, promptOverrides: {} });
    expect(seen[0]).toContain(EPISODE_MAPPING_BODY);
  });

  it("E3: 空对象 {} + 单季 → 同一版内置 body(单季/多季不再分版)", async () => {
    const seen: string[] = [];
    await arbitrateEpisodeMapping({ model: capturingModel(seen), seasons: [1], ...base, promptOverrides: {} });
    expect(seen[0]).toContain(EPISODE_MAPPING_BODY);
  });

  it("E4: 已覆盖 episode-mapping + 多季 → 自定义正文优先", async () => {
    const seen: string[] = [];
    await arbitrateEpisodeMapping({
      model: capturingModel(seen),
      seasons: [1, 2],
      ...base,
      promptOverrides: { "episode-mapping": "自定义正文" },
    });
    expect(seen[0]).toContain("自定义正文");
    expect(seen[0]).not.toContain(EPISODE_MAPPING_BODY);
  });

  it("E5: 单季与多季收到同一份 body 与同一份 prompt 抬头", async () => {
    const single: string[] = [];
    const multi: string[] = [];
    await arbitrateEpisodeMapping({ model: capturingModel(single), seasons: [1], ...base });
    await arbitrateEpisodeMapping({ model: capturingModel(multi), seasons: [1, 2], ...base });
    for (const seen of [single, multi]) {
      expect(seen[0]).toContain(EPISODE_MAPPING_BODY);
      expect(seen[0]).toContain(HEADER);
    }
  });
});
