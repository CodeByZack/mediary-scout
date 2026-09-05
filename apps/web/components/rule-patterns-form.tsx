"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle, Plus, RefreshCcw } from "lucide-react";
import {
  resetRulePatternsAction,
  saveRulePatternsAction,
  type RulePatternDraft,
} from "../app/actions";
import { runAction } from "../lib/run-action";
import {
  BUILTIN_ID_SET,
  filterDisabledBuiltins,
  formatRuleBlock,
  parseRuleBlock,
} from "../lib/rule-patterns-utils";

/** issue #44 UI 重构:解析规则 = 单个多行输入框。懂正则的人直接编辑文本块;
 *  行格式 S:/E: 前缀,顺序 = 优先级,详见 formatRuleBlock 的注释头。 */
export function RulePatternsForm({ initial }: { initial: RulePatternDraft[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [text, setText] = useState(() => formatRuleBlock(initial));
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 实时解析:行错误(行号 → 文案)。只读,不触发重渲染循环。
  const parsed = useMemo(() => parseRuleBlock(text), [text]);
  const lineErrors = useMemo(() => {
    const merged: Record<string, string> = { ...parsed.errors };
    for (const [k, v] of Object.entries(serverErrors)) {
      // 服务端错误按 ruleId 来,文本模式下按行号展示不可靠 → 合并进全局错误。
      if (!merged[k]) merged["_server:" + k] = v;
    }
    return merged;
  }, [parsed.errors, serverErrors]);
  const hasLineErrors = Object.keys(lineErrors).some((k) => !k.startsWith("_server"));
  const hasServerErrors = Object.keys(lineErrors).some((k) => k.startsWith("_server"));

  const addCustom = () => {
    setServerErrors({});
    const trimmed = text.replace(/\s+$/, "");
    setText(trimmed.length > 0 ? trimmed + "\nE: " : "E: ");
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    });
  };

  const handleSave = () => {
    if (hasLineErrors) {
      setResult("❌ 有行未通过校验,修正后再保存");
      setTimeout(() => setResult(null), 3000);
      return;
    }
    startTransition(async () => {
      const payload = filterDisabledBuiltins(parsed.rows);
      const r = await runAction(() => saveRulePatternsAction(payload), (msg) => {
        setResult("❌ " + msg);
        setTimeout(() => setResult(null), 3000);
      });
      if (!r.ok) return;
      const res = r.value;
      if (!res.success) {
        setServerErrors(res.errors ?? {});
        setResult("❌ " + (res.message ?? "保存失败"));
        setTimeout(() => setResult(null), 3000);
        return;
      }
      setServerErrors({});
      setResult("✅ 保存成功(下次采集任务即生效)");
      setTimeout(() => setResult(null), 3000);
      router.refresh();
    });
  };

  const handleReset = () => {
    startTransition(async () => {
      const r = await runAction(() => resetRulePatternsAction(), (msg) => {
        setResult("❌ " + msg);
        setTimeout(() => setResult(null), 3000);
      });
      if (!r.ok) return;
      setResult(r.value.success ? "✅ 已恢复默认规则" : "❌ " + (r.value.message ?? "恢复失败"));
      setServerErrors({});
      setTimeout(() => setResult(null), 3000);
      // 空表 = ruleset.loadRulePatterns 回退内置 → 文本回到「全内置留空」形态。
      const builtinEmpties = initial
        .filter((row) => BUILTIN_ID_SET.has(row.ruleId))
        .map((row) => ({ ...row, expression: "" }));
      setText(formatRuleBlock(builtinEmpties));
      router.refresh();
    });
  };

  const lineErrorCount = Object.keys(lineErrors).filter((k) => !k.startsWith("_server")).length;

  return (
    <div>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setServerErrors({});
        }}
        spellCheck={false}
        wrap="off"
        rows={Math.max(12, text.split("\n").length + 1)}
        style={{
          width: "100%",
          boxSizing: "border-box",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12.5,
          lineHeight: 1.65,
          padding: 10,
          border: "1px solid rgba(127,127,127,.3)",
          borderRadius: 6,
          background: "transparent",
          color: "inherit",
          whiteSpace: "pre",
        }}
        aria-label="集数解析正则(多行,每行一条)"
      />
      {lineErrorCount > 0 || hasServerErrors ? (
        <ul style={{ marginTop: 8, paddingLeft: 18, color: "#dc2626", fontSize: 12.5 }}>
          {Object.entries(lineErrors).map(([key, msg]) => (
            <li key={key} style={{ margin: "2px 0" }}>
              {key.startsWith("_server") ? "⚠ " + msg : "第 " + key + " 行: " + msg}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="setting-row" style={{ marginTop: 12, flexWrap: "wrap", gap: 8 }}>
        <button type="button" className="primary-button" onClick={handleSave} disabled={isPending || hasLineErrors}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存规则
        </button>
        <button type="button" className="text-button" onClick={addCustom} disabled={isPending}>
          <Plus size={14} aria-hidden />
          添加自定义规则
        </button>
        <button type="button" className="text-button" onClick={handleReset} disabled={isPending}>
          <RefreshCcw size={14} aria-hidden />
          恢复默认
        </button>
      </div>
      {result ? <p className="panel-note" style={{ marginTop: 10 }}>{result}</p> : null}
    </div>
  );
}
