"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, RotateCcw, Save } from "lucide-react";
import { resetPromptOverridesAction, savePromptOverridesAction } from "../app/actions";
import { runAction } from "../lib/run-action";
import { PROMPT_TEMPLATES, validatePromptBody } from "@media-track/workflow";

/** 四种仲裁 kind 的展示名称（head/tail 取 PROMPT_TEMPLATES 真实文本,只读展示 —— S1）。 */
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

/** issue #44 Phase 2:AI 仲裁 prompt 编辑器。head/tail 固定只读,只编辑「规则指令」中段;
 *  留空 = 使用内置模板(不写覆盖行)。 */
export function PromptOverridesForm({ initial }: { initial: PromptDraft[] }) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<PromptDraft[]>(initial);
  const [messages, setMessages] = useState<Record<string, string>>({});
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
      // 留空 kind 的草稿不提交(action 端同样处理,双保险)。
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
      // 恢复默认：所有 kind 回到内置模板(空 body)。
      setDrafts(initial.map((d) => ({ ...d, promptText: "" })));
      setMessages({});
      router.refresh();
    });
  }

  return (
    <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
      {KIND_META.map((meta) => {
        const draft = drafts.find((d) => d.arbitrationKind === meta.kind) ?? {
          arbitrationKind: meta.kind,
          promptText: "",
        };
        const template = PROMPT_TEMPLATES[meta.kind as keyof typeof PROMPT_TEMPLATES];
        const error = errors[meta.kind];
        return (
          <div
            key={meta.kind}
            style={{
              border: "1px solid rgba(127,127,127,.22)",
              borderRadius: 8,
              padding: "10px 12px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>{meta.name}</strong>
              <span style={{ fontSize: 12, color: "var(--text-secondary, #888)" }}>留空 = 内置模板</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary, #888)", margin: "4px 0 8px" }}>
              角色定位（固定，从模板取真实文本）：
            </div>
            <pre
              style={{
                margin: "0 0 8px",
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
              <div style={{ color: "#dc2626", fontSize: 12, marginBottom: 6 }}>⚠ {error}</div>
            ) : null}
            <textarea
              value={draft.promptText}
              onChange={(e) => setBody(meta.kind, e.target.value)}
              rows={8}
              spellCheck={false}
              placeholder={"输入「规则指令」中段（head 与 JSON 契约自动环绕，不可改）"}
              style={{
                width: "100%",
                minHeight: 120,
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
                margin: "6px 0 0",
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
