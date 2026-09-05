"use client";

import { useState, useTransition } from "react";
import { FlaskConical, LoaderCircle } from "lucide-react";
import { testEpisodeRuleAction } from "../app/actions";
import { runAction } from "../lib/run-action";

interface BenchResult {
  code: string | null;
  matched: string | null;
  message?: string;
}

/** issue #44 Phase 3:解析规则测试台。输入样例文件名试跑**已保存**的生效规则。 */
export function RuleTestBench() {
  const [fileName, setFileName] = useState("");
  const [multiSeason, setMultiSeason] = useState(false);
  const [result, setResult] = useState<BenchResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    if (isPending) return;
    startTransition(async () => {
      const r = await runAction(
        () => testEpisodeRuleAction({ fileName, multiSeason }),
        (msg) => setResult({ code: null, matched: null, message: msg }),
      );
      if (!r.ok) return;
      setResult(r.value);
    });
  }

  return (
    <div
      style={{
        border: "1px dashed rgba(127,127,127,.35)",
        borderRadius: 8,
        padding: "10px 12px",
        marginTop: 18,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <FlaskConical size={15} aria-hidden />
        <strong>解析测试台</strong>
        <span style={{ fontSize: 12, color: "var(--text-secondary, #888)" }}>
          试跑基于已保存规则（保存后生效，与采集 worker 同源）
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
        <input
          value={fileName}
          onChange={(e) => setFileName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
          placeholder={'样例文件名，如 "狂飙.S01E01.1080p.mkv" / "第3集.mkv" / "07.mkv"'}
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 260,
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid rgba(127,127,127,.3)",
            background: "transparent",
            color: "inherit",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12.5,
          }}
        />
        <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="checkbox"
            checked={multiSeason}
            onChange={(e) => setMultiSeason(e.target.checked)}
          />
          多季任务
        </label>
        <button type="button" className="btn" onClick={run} disabled={isPending}>
          {isPending ? <LoaderCircle className="spin" size={14} /> : null} 试跑
        </button>
      </div>
      {result ? (
        <div style={{ marginTop: 8, fontSize: 13 }}>
          {result.message ? (
            <span style={{ color: "#dc2626" }}>⚠ {result.message}</span>
          ) : result.code === null ? (
            <span>
              未解析出集数（<span style={{ color: "#b45309" }}>不认这个文件为某集</span>
              {result.matched ? `　·　命中槽位：${result.matched}` : ""}】）
            </span>
          ) : (
            <span>
              解析结果：<strong style={{ fontFamily: "ui-monospace, monospace" }}>{result.code}</strong>
              {result.matched ? `　·　命中槽位：${result.matched}` : ""}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
