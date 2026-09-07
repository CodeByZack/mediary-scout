"use client";

import { useState, useTransition } from "react";
import { Check, ChevronDown, ChevronRight, LoaderCircle, Pencil, Trash2, X } from "lucide-react";
import { resetRulePatternsAction, saveRulePatternsAction } from "../app/actions";
import { runAction } from "../lib/run-action";
import { BUILTIN_RULE_PATTERNS, type RuleRole } from "@media-track/workflow/ruleset";
import { ruleRowError, type RulePatternDraft } from "../lib/rule-patterns-utils";

/**
 * 正则区 UI(2026-09-07 用户拍板定稿 + 当晚微调):
 * - 节标题「正则」+ 右侧文字链接「恢复默认」;内置 6 条**只读**展示;
 * - 带季号 / 仅集号 两组像 Prompt 卡片一样可折叠(默认展开);
 * - 每组标题行尾部「+ 添加」文字链接,点开才出现输入框;
 * - 自定义排在各组内置之后,每条独立 保存 / 编辑 / 删除(每条自己带保存)。
 */

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const ROLES: Array<{ role: RuleRole; title: string; note: string }> = [
  { role: "season-episode", title: "带季号", note: "文件名里同时带季号和集号,任何任务都认" },
  { role: "episode-only", title: "仅集号", note: "文件名里只有集号,仅单季任务启用" },
];

/** 内置槽位总数 = 自定义 sortOrder 起点。 */
const CUSTOM_ORDER_BASE = BUILTIN_RULE_PATTERNS.length;

/** 下一个自定义 ruleId 序号(整表替换保存,删除释放的序号可复用,取当前最大 +1)。 */
function nextCustomId(customs: RulePatternDraft[]): string {
  let max = 0;
  for (const c of customs) {
    const m = /^custom-(\d+)$/.exec(c.ruleId);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return "custom-" + (max + 1);
}

/** 保存前按数组位置重排 sortOrder,保证显示顺序 == 采集优先级顺序。 */
function indexSortOrder(customs: RulePatternDraft[]): RulePatternDraft[] {
  return customs.map((c, i) => ({ ...c, sortOrder: CUSTOM_ORDER_BASE + i }));
}

interface EditorState {
  role: RuleRole;
  editingId: string | null; // null = 新增
  expression: string;
}

export function RulePatternsForm({ initial }: { initial: RulePatternDraft[] }) {
  const [customs, setCustoms] = useState<RulePatternDraft[]>(initial);
  // 默认折叠(2026-09-07 用户拍板),点标题行展开;+ 添加 点击会自动展开该组。
  const [expanded, setExpanded] = useState<Record<RuleRole, boolean>>({
    "season-episode": false,
    "episode-only": false,
  });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function openAdd(role: RuleRole) {
    setExpanded((prev) => ({ ...prev, [role]: true }));
    setEditor({ role, editingId: null, expression: "" });
    setEditorError(null);
  }

  function openEdit(role: RuleRole, row: RulePatternDraft) {
    setEditor({ role, editingId: row.ruleId, expression: row.expression });
    setEditorError(null);
  }

  function closeEditor() {
    setEditor(null);
    setEditorError(null);
  }

  function flash(msg: string) {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 3000);
  }

  function persist(next: RulePatternDraft[], onSaved: () => void) {
    startTransition(async () => {
      const ordered = indexSortOrder(next);
      const r = await runAction(() => saveRulePatternsAction(ordered), (msg) => flash("❌ " + msg));
      if (!r.ok) return;
      if (!r.value.success) {
        flash("❌ " + (r.value.message ?? "保存失败"));
        return;
      }
      setCustoms(ordered);
      onSaved();
    });
  }

  function commit() {
    if (!editor || isPending) return;
    const expression = editor.expression.trim();
    const err = ruleRowError({ ruleId: "custom-x", role: editor.role, expression, sortOrder: 0 });
    if (err !== null) {
      setEditorError(err);
      return;
    }
    setEditorError(null);
    const ok = () => {
      setEditor(null);
      flash("✅ 已保存(下次采集任务即生效)");
    };
    if (editor.editingId === null) {
      const next = [
        ...customs,
        { ruleId: nextCustomId(customs), role: editor.role, expression, label: "自定义规则", sortOrder: 0, isDefault: false },
      ];
      persist(next, ok);
    } else {
      const next = customs.map((c) => (c.ruleId === editor.editingId ? { ...c, role: editor.role, expression } : c));
      persist(next, ok);
    }
  }

  function remove(row: RulePatternDraft) {
    if (isPending) return;
    const next = customs.filter((c) => c.ruleId !== row.ruleId);
    persist(next, () => flash("✅ 已删除"));
  }

  function handleReset() {
    if (isPending) return;
    startTransition(async () => {
      const r = await runAction(() => resetRulePatternsAction(), (msg) => flash("❌ " + msg));
      if (!r.ok) return;
      if (r.value.success) {
        setCustoms([]);
        setEditor(null);
        flash("✅ 已恢复默认(清空全部自定义)");
      } else {
        flash("❌ " + (r.value.message ?? "恢复失败"));
      }
    });
  }

  const editorForm = (role: RuleRole) => {
    const captureHint = role === "season-episode" ? "第 1 组季号、第 2 组集号" : "1 个捕获组:集号";
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          margin: "8px 0",
          padding: "10px 12px",
          border: "1px dashed rgba(127,127,127,.35)",
          borderRadius: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <input
            value={editor?.expression ?? ""}
            onChange={(e) => setEditor((prev) => (prev ? { ...prev, expression: e.target.value } : prev))}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") closeEditor();
            }}
            placeholder={"正则,如 [Ss]([0-9]{1,2})_([0-9]{1,4}) —— " + captureHint}
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 240,
              fontFamily: MONO,
              fontSize: 12.5,
              padding: "6px 8px",
              borderRadius: 6,
              border: "1px solid rgba(127,127,127,.3)",
              background: "transparent",
              color: "inherit",
            }}
            aria-label={role === "season-episode" ? "自定义带季号正则" : "自定义仅集号正则"}
          />
          <button type="button" className="secondary-button" onClick={commit} disabled={isPending}>
            {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
            保存
          </button>
          <button type="button" className="secondary-button" onClick={closeEditor} disabled={isPending}>
            <X size={14} aria-hidden />
            取消
          </button>
        </div>
        {editorError ? <span style={{ color: "#dc2626", fontSize: 12.5 }}>⚠ {editorError}</span> : null}
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>正则</h3>
        <span style={{ fontSize: 12, color: "var(--text-secondary, #888)" }}>文件名 → 集数 解析规则</span>
        <button
          type="button"
          onClick={handleReset}
          disabled={isPending}
          style={{
            marginLeft: "auto",
            background: "none",
            border: "none",
            padding: 0,
            cursor: isPending ? "wait" : "pointer",
            color: "var(--text-secondary, #888)",
            fontSize: 12.5,
            textDecoration: "underline",
          }}
        >
          恢复默认
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-secondary, #888)", lineHeight: 1.7, margin: "8px 0 12px" }}>
        <div>· 内置规则只读,不可修改;自定义规则排在各组内置之后(内置不认的写法才轮到自定义)。</div>
        <div>· 正则只决定匹配文本;剥扩展名 / 集数守卫 / 年份排除 / 衍生黑名单等由解析代码固定保留。</div>
      </div>

      {ROLES.map(({ role, title, note }) => {
        const isOpen = expanded[role] ?? false;
        const slots = BUILTIN_RULE_PATTERNS.filter((p) => p.role === role);
        const groupCustoms = customs.filter((c) => c.role === role);
        const editingThisGroup = editor?.role === role;
        return (
          <div key={role} style={{ marginBottom: 8, border: "1px solid rgba(127,127,127,.18)", borderRadius: 8, overflow: "hidden" }}>
            <div
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              onClick={() => setExpanded((prev) => ({ ...prev, [role]: !prev[role] }))}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", userSelect: "none" }}
            >
              {isOpen ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
              <strong style={{ fontSize: 13.5 }}>{title}</strong>
              <span style={{ fontSize: 12, color: "var(--text-secondary, #888)" }}>{note}</span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  openAdd(role);
                }}
                style={{ marginLeft: "auto", fontSize: 12.5, color: "inherit", cursor: "pointer", userSelect: "none" }}
              >
                + 添加
              </span>
            </div>
            {isOpen ? (
              <div style={{ padding: "0 12px 10px", borderTop: "1px solid rgba(127,127,127,.12)" }}>
                <div style={{ fontSize: 12, color: "var(--text-secondary, #888)", margin: "8px 0 6px" }}>
                  {role === "season-episode" ? "需 2 个捕获组:第 1 组季号、第 2 组集号" : "需 1 个捕获组:集号"}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {slots.map((p, i) => (
                    <div key={p.ruleId} style={{ display: "flex", alignItems: "baseline", gap: 8, fontFamily: MONO, fontSize: 12.5 }}>
                      <span style={{ minWidth: 22, textAlign: "right", color: "var(--text-secondary, #888)" }}>{i + 1}.</span>
                      <code>{p.expression}</code>
                      {p.example ? <span style={{ color: "var(--text-secondary, #888)" }}>example: {p.example}</span> : null}
                    </div>
                  ))}
                  {groupCustoms.map((c, i) => (
                    <div key={c.ruleId} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, flexWrap: "wrap" }}>
                      <span style={{ minWidth: 22, textAlign: "right", color: "#2563eb" }}>自{i + 1}.</span>
                      {editingThisGroup && editor.editingId === c.ruleId ? (
                        editorForm(role)
                      ) : (
                        <>
                          <code style={{ fontFamily: MONO }}>{c.expression}</code>
                          <button type="button" className="secondary-button" style={{ padding: "2px 6px", fontSize: 12 }} onClick={() => openEdit(role, c)} disabled={isPending}>
                            <Pencil size={12} aria-hidden /> 编辑
                          </button>
                          <button type="button" className="secondary-button" style={{ padding: "2px 6px", fontSize: 12 }} onClick={() => remove(c)} disabled={isPending}>
                            <Trash2 size={12} aria-hidden /> 删除
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                {editingThisGroup && editor?.editingId === null ? editorForm(role) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      {feedback ? <p className="panel-note" style={{ marginTop: 8 }}>{feedback}</p> : null}
    </div>
  );
}
