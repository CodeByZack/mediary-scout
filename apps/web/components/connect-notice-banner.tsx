"use client";

import { X } from "lucide-react";
import { useState, useTransition } from "react";
import { dismissConnectNoticeAction } from "../app/actions";
import { runAction } from "../lib/run-action";

export function ConnectNoticeBanner({ hasTunnelToken = false }: { hasTunnelToken?: boolean }) {
  const [dismissed, setDismissed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (dismissed) return null;

  function handleDismiss() {
    // 重试前复位 failed,否则上次的「关闭失败」提示会残留到本次尝试
    // (Copilot round 4)。
    setFailed(false);
    startTransition(async () => {
      // 必须 catch(见 runAction 注释)。
      // 失败时**不关闭**:让用户看到 banner 还在 = 关闭没生效,会再点一次。
      // 乐观关闭会与「下次刷新又出现」矛盾 —— 用户以为关了却没关掉
      // (Copilot round 3)。
      const r = await runAction(
        () => dismissConnectNoticeAction(),
        () => setFailed(true),
      );
      if (!r.ok) return;
      setDismissed(true);
    });
  }

  return (
    <div className="connect-notice">
      <div className="connect-notice-body">
        <div className="connect-notice-icon">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <p className="connect-notice-text">
          {hasTunnelToken
            ? "远程访问已上线，随时随地访问媒体库"
            : "🎉 付费远程访问现已上线！扫码即通 — 详见控制台"}
        </p>
      </div>
      <div className="connect-notice-actions">
        <a className="connect-notice-link" href="/settings?tab=remote-access">
          了解详情
        </a>
        {failed ? (
          <span className="push-help tone-amber" role="alert">
            关闭失败，请重试
          </span>
        ) : null}
        <button
          onClick={handleDismiss}
          disabled={isPending}
          className="connect-notice-close"
          aria-label="关闭通知"
        >
          <X />
        </button>
      </div>
    </div>
  );
}
