"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, LoaderCircle, RotateCcw, Save } from "lucide-react";
import { resetPromptOverridesAction, savePromptOverridesAction } from "../app/actions";
import { runAction } from "../lib/run-action";
// 子路径导入:ruleset/prompt-templates 零 node 依赖,可安全进客户端 chunk(barrel 含 sqlite→node:module,Turbopack 会炸)。
import { PROMPT_TEMPLATES } from "@media-track/workflow/prompt-templates";
import { validatePromptBody } from "@media-track/workflow/ruleset";

/** 四种仲裁 kind 的展示名称(head/tail 取 PROMPT_TEMPLATES 真实文本,只读展示)。 */
const KIND_META: Array<{ kind: string; name: string }> = [
  { kind: "selection", name: "选片仲裁（剧集）" },
  { kind: "episode-mapping", name: "集数映射仲裁（剧集）" },
  { kind: "movie-selection", name: "选片仲裁（电影）" },
  { kind: "movie-diagnosis", name: "落盘诊断仲裁（电影）" },
];

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
      const payload = drafts.filter((d) => d.promptText.trim().length > 0);
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
      setDrafts(initial.map((d) => ({ ...d, promptText: "" })));
      setMessages({});
      router.refresh();
    });
  }

  const openKinds = Array.from(expanded);

  return (
    <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
      <div style={{ fontSize: 13, color: "var(--text-secondary, #888)" }}>
        四段升级仲裁的系统提示词 —— 展开卡片编辑「规则指令」中段；角色定位(head)与 JSON 输出契约(tail)固定不可改；留空 = 内置模板。
      </div>
      {KIND_META.map((meta) => {
        const draft = drafts.find((d) => d.arbitrationKind === meta.kind) ?? {
          arbitrationKind: meta.kind,
          promptText: "",
        };
        const template = PROMPT_TEMPLATES[meta.kind as keyof typeof PROMPT_TEMPLATES];
        const error = errors[meta.kind];
        const isOpen = expanded.has(meta.kind);
        return (
          <div
            key={meta.kind}
            style={{
              border: "1px solid rgba(127,127,127,.22)",
              borderRadius: 8,
            }}
          >
            <button
              type="button"
              onClick={() => toggle(meta.kind)}
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
              <strong>{meta.name}</strong>
              {draft.promptText.trim().length > 0 ? (
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
                <pre
                  style={{
                    margin: 0,
                    padding: "6px 8px",
                    background: "rgba(127,127,127,.08)",
                    borderRadius: 6,
                    fontSize: 12,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  {template.head}
                </pre>
                {error ? (
                  <div style={{ color: "#dc2626", fontSize: 12, margin: "8px 0 4px" }}>⚠ {error}</div>
                ) : null}
                <textarea
                  value={draft.promptText}
                  onChange={(e) => setBody(meta.kind, e.target.value)}
                  rows={7}
                  spellCheck={false}
                  placeholder={"输入「规则指令」中段（head 与 JSON 契约自动环绕，不可改）"}
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
                <pre
                  style={{
                    margin: "8px 0 0",
                    padding: "6px 8px",
                    background: "rgba(127,127,127,.08)",
                    borderRadius: 6,
                    fontSize: 12,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                    color: "var(--text-secondary, #888)",
                  }}
                >
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
          className="btn btn-primary"
          onClick={handleSave}
          disabled={hasErrors || isPending}
        >
          {isPending ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />} 保存
        </button>
        <button
          type="button"
          className="btn"
          onClick={handleReset}
          disabled={isResetting || isPending}
        >
          {isResetting ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />} 恢复默认
        </button>
      </div>
    </div>
  );
}
