"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle, Plus, RefreshCcw, Trash2 } from "lucide-react";
import {
  resetRulePatternsAction,
  saveRulePatternsAction,
  type RulePatternDraft,
} from "../app/actions";
import { runAction } from "../lib/run-action";
import { collectRowErrors, filterDisabledBuiltins, ruleRowError } from "../lib/rule-patterns-utils";

const ROLE_LABELS: Record<string, string> = {
  "season-episode": "季+集",
  "episode-only": "仅集号",
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  "season-episode": "group1=季、group2=集（如 SxxExx / 1×01）",
  "episode-only": "group1=集号（如 E01 / 第N集），仅单季任务启用",
};

/** 六大内置槽位的展示说明（与 ruleset.ts BUILTIN_RULE_PATTERNS 一一对应）。 */
const BUILTIN_HINTS: Record<string, { name: string; note: string }> = {
  sxxexx: {
    name: "标准 SxxExx",
    note: "自带季信息，始终可解析（长篇动漫允许 4 位集号）",
  },
  variant: {
    name: "松散变体",
    note: "空格 / 点分隔，如 S01 E01、s01.e01",
  },
  "ep-only": {
    name: "E01 / EP01",
    note: "单季任务；集号过合理防护（排除分辨率/年份/超大数字）",
  },
  cross: {
    name: "1×01 / 1x01",
    note: "Plex 兼容写法，自带季信息",
  },
  chinese: {
    name: "第N集 / 第N话 / 第N期",
    note: "单季任务；「第N期」带衍生内容黑名单（加更/花絮等不算正片）",
  },
  digits: {
    name: "纯数字整名",
    note: "整个文件名只有数字（去扩展名）；单季任务按目标季解析",
  },
};
const BUILTIN_ID_SET = new Set(Object.keys(BUILTIN_HINTS));

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? `未知角色：${role}`;
}

export function RulePatternsForm({ initial }: { initial: RulePatternDraft[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [rows, setRows] = useState<RulePatternDraft[]>(initial);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string | null>(null);

  const inlineErrors = useMemo(() => collectRowErrors(rows), [rows]);

  const hasErrors = Object.keys(inlineErrors).length > 0;
  const nextSortOrder = rows.reduce((max, row) => Math.max(max, row.sortOrder), 0) + 1;

  const update = (index: number, patch: Partial<RulePatternDraft>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const addCustom = () => {
    setServerErrors({});
    setRows((prev) => [
      ...prev,
      {
        ruleId: `custom-${Date.now()}`,
        role: "episode-only",
        expression: "",
        label: "自定义规则",
        sortOrder: nextSortOrder,
        isDefault: false,
      },
    ]);
  };

  const removeCustom = (index: number) => {
    setServerErrors({});
    setRows((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = () => {
    if (hasErrors) {
      setResult("❌ 有规则校验未通过，修正后再保存");
      setTimeout(() => setResult(null), 3000);
      return;
    }
    startTransition(async () => {
      // M1:留空的内置槽位 = 停用——从 payload 剔除,表缺失该内置即不生效(Phase 0 loader 语义)。
      const payload = filterDisabledBuiltins(rows);
      const r = await runAction(() => saveRulePatternsAction(payload), (msg) => {
        setResult(`❌ ${msg}`);
        setTimeout(() => setResult(null), 3000);
      });
      if (!r.ok) return;
      const res = r.value;
      if (!res.success) {
        setServerErrors(res.errors ?? {});
        setResult(`❌ ${res.message ?? "保存失败"}`);
        setTimeout(() => setResult(null), 3000);
        return;
      }
      setServerErrors({});
      setResult("✅ 保存成功（下次采集任务即生效）");
      setTimeout(() => setResult(null), 3000);
    });
  };

  const handleReset = () => {
    startTransition(async () => {
      const r = await runAction(() => resetRulePatternsAction(), (msg) => {
        setResult(`❌ ${msg}`);
        setTimeout(() => setResult(null), 3000);
      });
      if (!r.ok) return;
      setResult(r.value.success ? "✅ 已恢复默认规则" : `❌ ${r.value.message ?? "恢复失败"}`);
      setServerErrors({});
      setTimeout(() => setResult(null), 3000);
      // 服务端重渲染(空表 = ruleset.loadRulePatterns 回退内置)。
      router.refresh();
    });
  };

  return (
    <div>
      <p className="panel-note" style={{ marginBottom: 12 }}>
        控制「文件名 → 集数」的解析正则。内置六条与实际解析代码一致；正则只决定匹配文本，
        剥扩展名 / 合理集数守卫 / 年份排除 / 衍生内容黑名单等语义由解析代码按规则固定保留
        （不可配置，防误识别）。自定义规则（季+集 / 仅集号）在所有内置规则之后匹配。
      </p>
      <div style={{ overflowX: "auto" }}>
        <table className="rule-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>规则</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>角色（捕获组契约）</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>正则</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>排序</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const builtin = BUILTIN_ID_SET.has(row.ruleId);
              const error = inlineErrors[row.ruleId] ?? serverErrors[row.ruleId];
              const hint = BUILTIN_HINTS[row.ruleId];
              return (
                <Fragment key={row.ruleId}>
                  <tr style={{ borderTop: "1px solid rgba(127,127,127,.18)" }}>
                  <td style={{ padding: "8px", verticalAlign: "top", minWidth: 170 }}>
                    <div style={{ fontWeight: 600 }}>{hint?.name ?? row.label}</div>
                    <div className="panel-note" style={{ fontSize: 12 }}>
                      {hint?.note ?? `${row.ruleId}（自定义）`}
                    </div>
                    {builtin ? (
                      <div className="panel-note" style={{ fontSize: 12 }}>
                        code={row.ruleId}
                      </div>
                    ) : null}
                  </td>
                  <td style={{ padding: "8px", verticalAlign: "top", minWidth: 130 }}>
                    {builtin ? (
                      <div>
                        <span style={{ fontSize: 13 }}>{roleLabel(row.role)}</span>
                        <div className="panel-note" style={{ fontSize: 12 }}>
                          {ROLE_DESCRIPTIONS[row.role] ?? ""}
                        </div>
                      </div>
                    ) : (
                      <select
                        value={row.role}
                        onChange={(event) => update(index, { role: event.target.value })}
                        className="setting-control"
                        aria-label={`${row.label ?? row.ruleId} 的角色`}
                      >
                        <option value="season-episode">季+集</option>
                        <option value="episode-only">仅集号</option>
                      </select>
                    )}
                  </td>
                  <td style={{ padding: "8px", verticalAlign: "top", minWidth: 260 }}>
                    <input
                      value={row.expression}
                      onChange={(event) => update(index, { expression: event.target.value })}
                      placeholder="如 [Ss](\d{1,2})[Ee](\d{1,4})"
                      className="setting-control"
                      style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, width: "100%" }}
                      aria-label={`${row.label ?? row.ruleId} 的正则`}
                      spellCheck={false}
                    />
                    {builtin && !row.expression.trim() ? (
                      <div className="panel-note" style={{ fontSize: 12 }}>
                        留空 = 该内置规则停用（行仍显示，便于恢复）
                      </div>
                    ) : null}
                  </td>
                  <td style={{ padding: "8px", verticalAlign: "top" }}>
                    <input
                      type="number"
                      value={row.sortOrder}
                      min={0}
                      onChange={(event) => update(index, { sortOrder: Number(event.target.value) || 0 })}
                      className="setting-control"
                      style={{ width: 72 }}
                      aria-label={`${row.label ?? row.ruleId} 的排序`}
                    />
                  </td>
                  <td style={{ padding: "8px", verticalAlign: "top" }}>
                    {builtin ? (
                      <span className="panel-note" style={{ fontSize: 12 }}>
                        内置
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => removeCustom(index)}
                        className="text-button"
                        style={{ color: "#dc2626" }}
                        aria-label={`删除 ${row.label ?? row.ruleId}`}
                      >
                        <Trash2 size={14} aria-hidden />
                        删除
                      </button>
                    )}
                  </td>
                  </tr>
                  {error ? (
                    <tr style={{ borderTop: "none" }}>
                      <td colSpan={5} style={{ padding: "0 8px 6px", color: "#dc2626", fontSize: 12 }}>
                        ⚠ {error}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="panel-note" style={{ padding: 12 }}>
                  当前没有生效规则（表为空 = 全部内置规则生效）。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="setting-row" style={{ marginTop: 14, flexWrap: "wrap", gap: 8 }}>
        <button type="button" className="primary-button" onClick={handleSave} disabled={isPending || hasErrors}>
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
      {hasErrors ? (
        <p className="panel-note" style={{ marginTop: 10, color: "#dc2626" }}>
          ⚠ {Object.keys(inlineErrors).length} 条规则未通过校验（角色捕获组契约：季+集需 2 组、仅集号需 1 组），标红处修正后可保存。
        </p>
      ) : null}
      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
