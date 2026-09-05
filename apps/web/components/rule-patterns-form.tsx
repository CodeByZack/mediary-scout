"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle, Plus, RefreshCcw } from "lucide-react";
import { resetRulePatternsAction, saveRulePatternsAction } from "../app/actions";
import { runAction } from "../lib/run-action";
import {
  BUILTIN_ID_SET,
  filterDisabledBuiltins,
  formatRuleBlock,
  parseRuleBlock,
  type RulePatternDraft,
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
      <div style={{ fontSize: 12.5, color: "var(--text-secondary, #888)", lineHeight: 1.7, marginBottom: 10 }}>
        <div>· 每行一条正则，<strong>顺序 = 优先级</strong>（从上到下依次尝试，第一条命中即生效）。</div>
        <div>· <strong>S:</strong> = 季+集（两个捕获组，如 SxxExx / 1×01）；<strong>E:</strong> = 仅集号（一个捕获组，如 E01 / 第N集，仅单季任务启用）。前缀不是正则的一部分。</div>
        <div>· 前 6 行为内置槽位：只能留空（= 恢复内置默认），<strong>不要删除整行</strong>，否则后续行会错位挂到前一槽位。</div>
        <div>· 正则只决定匹配文本；剥扩展名 / 合理集数守卫 / 年份排除 / 衍生黑名单等语义由解析代码固定保留。</div>
        <div>· 支持 <code>#</code> 开头的注释行（会忽略）。</div>
      </div>
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
        <button type="button" className="secondary-button" onClick={addCustom} disabled={isPending}>
          <Plus size={14} aria-hidden />
          添加自定义规则
        </button>
        <button type="button" className="secondary-button" onClick={handleReset} disabled={isPending}>
          <RefreshCcw size={14} aria-hidden />
          恢复默认
        </button>
      </div>
      {result ? <p className="panel-note" style={{ marginTop: 10 }}>{result}</p> : null}
    </div>
  );
}
