"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle, Plus, RefreshCcw } from "lucide-react";
import { resetRulePatternsAction, saveRulePatternsAction } from "../app/actions";
import { runAction } from "../lib/run-action";
import {
  BUILTIN_ID_SET,
  builtinSlotsFor,
  filterDisabledBuiltins,
  formatRuleBlocks,
  parseRuleBlocks,
  type RulePatternDraft,
} from "../lib/rule-patterns-utils";

/** issue #44 UI 重构:解析规则按 role 拆成两个区块(2026-09-07 用户拍板「(a) UI 分组」)。
 *  S 区块 = 文件名里带季号的写法,E 区块 = 只有集号的写法;区块内行序 = 优先级,
 *  前 N 行 = 该区块的内置槽位(留空 = 恢复内置)。行格式 S:/E: 前缀 + 正则。 */
export function RulePatternsForm({ initial }: { initial: RulePatternDraft[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [blocks, setBlocks] = useState(() => formatRuleBlocks(initial));
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string | null>(null);
  const seasonRef = useRef<HTMLTextAreaElement>(null);
  const episodeRef = useRef<HTMLTextAreaElement>(null);

  // 实时解析:分区块行错误(行号 → 文案)。只读,不触发重渲染循环。
  const parsed = useMemo(() => parseRuleBlocks(blocks.season, blocks.episode), [blocks]);
  const hasLineErrors = Object.keys(parsed.errors.season).length + Object.keys(parsed.errors.episode).length > 0;
  const hasServerErrors = Object.keys(serverErrors).length > 0;

  function setBlock(key: "season" | "episode", value: string) {
    setBlocks((prev) => ({ ...prev, [key]: value }));
    setServerErrors({});
  }

  const addCustom = (key: "season" | "episode") => {
    setServerErrors({});
    setBlocks((prev) => {
      const text = prev[key].replace(/\s+$/, "");
      const prefix = key === "season" ? "S: " : "E: ";
      return { ...prev, [key]: text.length > 0 ? text + "\n" + prefix : prefix };
    });
    requestAnimationFrame(() => {
      const el = key === "season" ? seasonRef.current : episodeRef.current;
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
      // 空表 = ruleset.loadRulePatterns 回退内置 → 文本回到「全内置留空」形态(自定义一并清空)。
      const builtinEmpties = initial
        .filter((row) => BUILTIN_ID_SET.has(row.ruleId))
        .map((row) => ({ ...row, expression: "" }));
      setBlocks(formatRuleBlocks(builtinEmpties));
      router.refresh();
    });
  };

  const blockUi = (key: "season" | "episode") => {
    const role = key === "season" ? "season-episode" : "episode-only";
    const prefix = key === "season" ? "S" : "E";
    const slots = builtinSlotsFor(role);
    const slotNames = slots.map((s) => s.label ?? s.ruleId).join(" / ");
    const errors = key === "season" ? parsed.errors.season : parsed.errors.episode;
    const errorCount = Object.keys(errors).length;
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
          <strong style={{ fontSize: 13 }}>
            {key === "season" ? "季集规则" : "纯集号规则"}
          </strong>
          <span style={{ fontSize: 12, color: "var(--text-secondary, #888)" }}>
            <strong>{prefix}:</strong>
            {key === "season" ? " 文件名里带季号(如 SxxExx / 1×01)" : " 文件名里只有集号(如 E01 / 第N集,仅单季任务启用)"}
          </span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary, #888)", lineHeight: 1.6, marginBottom: 6 }}>
          · 前 {slots.length} 行 = 内置槽位({slotNames}):留空 = 恢复内置默认,<strong>不要删除整行</strong>,否则后续行会错位挂到前一槽位。
          <br />
          · 其后是自定义规则,顺序 = 优先级。前缀 <strong>{prefix}:</strong> 不是正则的一部分;支持 <code>#</code> 开头的注释行。
        </div>
        <textarea
          ref={key === "season" ? seasonRef : episodeRef}
          value={blocks[key]}
          onChange={(e) => setBlock(key, e.target.value)}
          spellCheck={false}
          wrap="off"
          rows={Math.max(5, blocks[key].split("\n").length + 1)}
          style={{
            width: "100%",
            boxSizing: "border-box",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12.5,
            lineHeight: 1.65,
            padding: 10,
            border: "1px solid " + (errorCount > 0 ? "rgba(220,38,38,.55)" : "rgba(127,127,127,.3)"),
            borderRadius: 6,
            background: "transparent",
            color: "inherit",
            whiteSpace: "pre",
          }}
          aria-label={key === "season" ? "季集规则(S: 前缀)" : "纯集号规则(E: 前缀)"}
        />
        {errorCount > 0 ? (
          <ul style={{ marginTop: 6, paddingLeft: 18, color: "#dc2626", fontSize: 12.5 }}>
            {Object.entries(errors).map(([lineNo, msg]) => (
              <li key={lineNo} style={{ margin: "2px 0" }}>第 {lineNo} 行: {msg}</li>
            ))}
          </ul>
        ) : null}
        <button type="button" className="secondary-button" style={{ marginTop: 8 }} onClick={() => addCustom(key)} disabled={isPending}>
          <Plus size={14} aria-hidden />
          添加自定义{key === "season" ? "季集" : "集号"}规则
        </button>
      </div>
    );
  };

  return (
    <div>
      <div style={{ fontSize: 12.5, color: "var(--text-secondary, #888)", lineHeight: 1.7, marginBottom: 12 }}>
        <div>· 识别规则分两类:<strong>季集</strong>(文件名里带季号)与<strong>纯集号</strong>(只有集号,仅单季任务启用)。多季任务只认季集类。</div>
        <div>· 顺序 = 优先级:先试内置(按槽位顺序),再试自定义;季集区块的自定义优先于纯集号区块的自定义。</div>
        <div>· 正则只决定匹配文本;剥扩展名 / 合理集数守卫 / 年份排除 / 衍生黑名单等语义由解析代码固定保留。</div>
      </div>
      {blockUi("season")}
      {blockUi("episode")}
      {hasServerErrors ? (
        <ul style={{ marginTop: 8, paddingLeft: 18, color: "#dc2626", fontSize: 12.5 }}>
          {Object.entries(serverErrors).map(([ruleId, msg]) => (
            <li key={ruleId} style={{ margin: "2px 0" }}>
              {ruleId}: {msg}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="setting-row" style={{ marginTop: 12, flexWrap: "wrap", gap: 8 }}>
        <button type="button" className="primary-button" onClick={handleSave} disabled={isPending || hasLineErrors}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存规则
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
