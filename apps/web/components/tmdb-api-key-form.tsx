"use client";

import { useState, useTransition } from "react";
import { Check, ExternalLink, LoaderCircle, Trash2 } from "lucide-react";
import { saveTmdbApiKeyAction, clearTmdbApiKeyAction, testTmdbConnectionAction } from "../app/actions";
import { runAction } from "../lib/run-action";

export function TmdbApiKeyForm({ apiKeySet, baseUrlSet }: { apiKeySet: boolean; baseUrlSet: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [hasKey, setHasKey] = useState(apiKeySet);
  const [hasBaseUrl, setHasBaseUrl] = useState(baseUrlSet);
  const [result, setResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      // 必须 catch:server action 会 throw(demo 门禁、运行时错误、网络中断),
      // 不 catch 就是未处理 rejection,界面上什么都不变(见 runAction 注释)。
      // 业务错误(success:false)仍走下方原逻辑;这里只拦异常。
      const r = await runAction(
        () => saveTmdbApiKeyAction(apiKey, baseUrl),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 保存成功" : `❌ ${res.message ?? "保存失败"}`);
      if (res.success) {
        if (apiKey.trim()) {
          setApiKey("");
          setHasKey(true);
        }
        if (baseUrl.trim()) {
          setBaseUrl("");
          setHasBaseUrl(true);
        }
      }
      setTimeout(() => setResult(null), 3000);
    });
  };

  const handleClear = () => {
    startTransition(async () => {
      // 必须 catch:server action 会 throw(demo 门禁、运行时错误、网络中断),
      // 不 catch 就是未处理 rejection,界面上什么都不变(见 runAction 注释)。
      // 业务错误(success:false)仍走下方原逻辑;这里只拦异常。
      const r = await runAction(
        () => clearTmdbApiKeyAction(),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 已清除" : `❌ ${res.message ?? "清除失败"}`);
      if (res.success) {
        setHasKey(false);
        setHasBaseUrl(false);
      }
      setTimeout(() => setResult(null), 3000);
    });
  };

  const handleTest = () => {
    startTransition(async () => {
      const r = await runAction(
        () => testTmdbConnectionAction(),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? `✅ ${res.message ?? "连接成功"}` : `❌ ${res.message ?? "连接失败"}`);
      setTimeout(() => setResult(null), 5000);
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 6 }}>
        影视元数据来源；可填自己的 key 直连，大陆网络可自建 tmdb-proxy
      </p>
      <p className="push-help" style={{ marginBottom: 12 }}>
        了解 TMDB{" "}
        <a href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer">
          官网 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
        </a>
        {" · 申请自己的 API Read Token "}
        <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">
          获取方法 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
        </a>
      </p>
      <div className="setting-row" style={{ marginBottom: 8 }}>
        <input
          type="text"
          className="setting-control"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={hasBaseUrl ? "已设置(留空不改)" : "自定义 API Base URL（如 https://tmdb.your-domain.com）"}
          aria-label="TMDB Base URL"
          autoComplete="off"
        />
      </div>
      <div className="setting-row" style={{ marginBottom: 12 }}>
        <input
          type="password"
          className="setting-control"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={hasKey ? "已设置(留空不改)" : "TMDB API Read Token（eyJhbGciOi…）"}
          aria-label="TMDB API Key"
          autoComplete="off"
        />
      </div>
      <div className="setting-row">
        <button type="button" className="primary-button" onClick={handleSave} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存
        </button>
        {(hasKey || hasBaseUrl) ? (
          <button type="button" className="secondary-button" onClick={handleClear} disabled={isPending}>
            <Trash2 size={14} aria-hidden />
            清除
          </button>
        ) : null}
        <button type="button" className="secondary-button" onClick={handleTest} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : null}
          测试连接
        </button>
      </div>
      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
