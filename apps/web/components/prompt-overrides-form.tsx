"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CSSProperties } from "react";
import { ChevronDown, ChevronRight, LoaderCircle, RotateCcw, Save } from "lucide-react";
import { resetPromptOverridesAction, savePromptOverridesAction } from "../app/actions";
import { runAction } from "../lib/run-action";
// 子路径导入:ruleset/prompt-templates 零 node 依赖,可安全进客户端 chunk(barrel 含 sqlite→node:module,Turbopack 会炸)。
import { PROMPT_TEMPLATES } from "@media-track/workflow/prompt-templates";
import { ARBITRATION_KINDS, validatePromptBody, type ArbitrationKind } from "@media-track/workflow/ruleset";

/** 只读展示段(head / tail)的统一样式。 */
const READONLY_PRE_STYLE: CSSProperties = {
  margin: 0,
  padding: "6px 8px",
  background: "rgba(127,127,127,.08)",
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

/** 输入框内容是否等于内置正文(留空同样算内置)——判「已覆盖」与「要不要落库」的同一口径。 */
function isBuiltinBody(kind: string, text: string): boolean {
  return text.trim() === (PROMPT_TEMPLATES[kind as keyof typeof PROMPT_TEMPLATES]?.body ?? "").trim();
}

/** kind → 展示名称。遍历 ARBITRATION_KINDS 渲染卡片,所以新增 kind 不会静默不显示。 */
const KIND_LABELS: Record<ArbitrationKind, string> = {
  selection: "选片仲裁（剧集）",
  "episode-mapping": "集数映射仲裁（剧集）",
  "movie-selection": "选片仲裁（电影）",
  "movie-diagnosis": "落盘诊断仲裁（电影）",
};

interface PromptDraft {
  arbitrationKind: string;
  promptText: string;
}

/** issue #44 UI 重构:四段 prompt 折叠卡片(默认折叠,展开编辑「规则指令」中段)。 */
export function PromptOverridesForm({ initial }: { initial: PromptDraft[] }) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<PromptDraft[]>(initial);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [isResetting, startReset] = useTransition();

  const errors = useMemo(() => {
    const errs: Record<string, string> = {};
    for (const d of drafts) {
      const body = d.promptText.trim();
      if (body.length === 0) continue; // 留空 = 内置,合法
      const error = validatePromptBody(body);
      if (error !== null) errs[d.arbitrationKind] = error;
    }
    return errs;
  }, [drafts]);
  const hasErrors = Object.keys(errors).length > 0;

  function toggle(kind: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function setBody(kind: string, text: string) {
    setDrafts((prev) => prev.map((d) => (d.arbitrationKind === kind ? { ...d, promptText: text } : d)));
    setMessages((prev) => {
      const next = { ...prev };
      delete next[kind];
      return next;
    });
  }

  function handleSave() {
    if (hasErrors || isPending) return;
    startTransition(async () => {
      // 留空(清空恢复内置)与「未改动 = 逐字等于内置正文」都不落库,保持「空表 = 全内置」语义。
      const payload = drafts.filter(
        (d) => d.promptText.trim().length > 0 && !isBuiltinBody(d.arbitrationKind, d.promptText),
      );
      const r = await runAction(() => savePromptOverridesAction(payload), (msg) => {
        setMessages((prev) => ({ ...prev, _global: msg }));
      });
      if (!r.ok) return;
      const res = r.value;
      if (!res.success) {
        if (res.errors) setMessages(res.errors);
        if (res.message !== undefined) {
          setMessages((prev) => ({ ...prev, _global: res.message as string }));
        }
        return;
      }
      router.refresh();
    });
  }

  function handleReset() {
    if (isResetting || isPending) return;
    startReset(async () => {
      const r = await runAction(() => resetPromptOverridesAction(), (msg) => {
        setMessages((prev) => ({ ...prev, _global: msg }));
      });
      if (!r.ok) return;
      // initial 已预填内置正文(settings/page.tsx 装配),恢复默认 = 直接回到 initial。
      setDrafts(initial);
      setMessages({});
      router.refresh();
    });
  }

  return (
    <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
      <div style={{ fontSize: 13, color: "var(--text-secondary, #888)" }}>
        四段升级仲裁的系统提示词。展开卡片直接改「规则指令」中段（已预填内置正文）；角色定位与 JSON 输出契约固定不可改。清空输入框 = 恢复内置；有改动时保存是整段替换，不是追加。
      </div>
      {ARBITRATION_KINDS.map((kind) => {
        const draft = drafts.find((d) => d.arbitrationKind === kind) ?? {
          arbitrationKind: kind,
          promptText: "",
        };
        const template = PROMPT_TEMPLATES[kind];
        const error = errors[kind];
        const isOpen = expanded.has(kind);
        return (
          <div
            key={kind}
            style={{
              border: "1px solid rgba(127,127,127,.22)",
              borderRadius: 8,
            }}
          >
            <button
              type="button"
              onClick={() => toggle(kind)}
              aria-expanded={isOpen}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "10px 12px",
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "inherit",
                textAlign: "left",
                fontSize: 14,
              }}
            >
              {isOpen ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
              <strong>{KIND_LABELS[kind]}</strong>
              {!isBuiltinBody(kind, draft.promptText) ? (
                <span style={{ fontSize: 12, color: "#2563eb", marginLeft: 4 }}>已覆盖</span>
              ) : null}
              {error ? <span style={{ fontSize: 12, color: "#dc2626", marginLeft: 4 }}>⚠ 校验未过</span> : null}
              <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-secondary, #888)" }}>
                留空 = 内置模板
              </span>
            </button>
            {isOpen ? (
              <div style={{ padding: "0 12px 12px", borderTop: "1px solid rgba(127,127,127,.15)" }}>
                <div style={{ fontSize: 12, color: "var(--text-secondary, #888)", margin: "10px 0 6px" }}>
                  角色定位（固定，从模板取真实文本）：
                </div>
                <pre style={READONLY_PRE_STYLE}>{template.head}</pre>
                {error ? (
                  <div style={{ color: "#dc2626", fontSize: 12, margin: "8px 0 4px" }}>⚠ {error}</div>
                ) : null}
                <div style={{ fontSize: 12, color: "var(--text-secondary, #888)", margin: "10px 0 6px" }}>
                  规则指令（已预填内置正文，可直接改；清空 = 恢复内置）：
                </div>
                <textarea
                  value={draft.promptText}
                  onChange={(e) => setBody(kind, e.target.value)}
                  rows={7}
                  spellCheck={false}
                  placeholder={"清空 = 恢复内置模板（head 与 JSON 契约自动环绕，不可改）"}
                  style={{
                    width: "100%",
                    marginTop: 8,
                    minHeight: 110,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontSize: 12.5,
                    lineHeight: 1.6,
                    padding: 8,
                    boxSizing: "border-box",
                    border: "1px solid rgba(127,127,127,.3)",
                    borderRadius: 6,
                    background: "transparent",
                    color: "inherit",
                  }}
                />
                <pre style={{ ...READONLY_PRE_STYLE, margin: "8px 0 0", color: "var(--text-secondary, #888)" }}>
                  JSON 契约（固定，环绕在 body 之后）：{"{"}
                  {template.tail}
                  {"}"}
                </pre>
              </div>
            ) : null}
          </div>
        );
      })}
      {messages._global ? (
        <div style={{ color: "#dc2626", fontSize: 12 }}>⚠ {messages._global}</div>
      ) : null}
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button
          type="button"
          className="primary-button"
          onClick={handleSave}
          disabled={hasErrors || isPending}
        >
          {isPending ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />} 保存
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={handleReset}
          disabled={isResetting || isPending}
        >
          {isResetting ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />} 恢复默认
        </button>
      </div>
    </div>
  );
}
