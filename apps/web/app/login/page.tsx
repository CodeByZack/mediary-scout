"use client";

import { useEffect, useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";

/**
 * 单用户登录 / 设置密码。
 *
 * 远程访问无条件需要 session。未设密码的实例远程会被挡在这里，
 * 页面上提供设置密码表单——设完密码再登录换取 session。
 */
export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [bootstrap, setBootstrap] = useState<{ passwordSet?: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/auth/bootstrap")
      .then((res) => res.json())
      .then((data) => setBootstrap(data))
      .catch(() => setBootstrap(null));
  }, []);

  const settingPassword = bootstrap?.passwordSet === false;

  /** 首次设置访问密码，然后立刻用它登录换 session，最后回媒体库。 */
  const submitNewPassword = () => {
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "设置失败，请重试。");
        return;
      }
      // 设完密码，远程这条路仍然需要 session：顺手登录，免得用户再输一次。
      await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      }).catch(() => undefined);
      window.location.href = "/";
    });
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "操作失败，请重试。");
    });
  };

  const title = settingPassword ? "设置访问密码" : "输入密码";
  const note = settingPassword
    ? "这台实例已开启外网访问，但还没有设置访问密码。任何人只要知道这个网址就能进来，看到你的媒体库、网盘凭据和全部设置。现在设一个密码把它锁上——局域网内依旧免登录。"
    : "这台实例已设置访问密码。局域网内无需登录，从外网访问需要输入密码。";
  const buttonText = settingPassword ? "设置密码并进入" : "进入";

  return (
    <main style={{ maxWidth: 360, margin: "14vh auto", padding: "0 20px" }}>
      <div className="panel" style={{ textAlign: "center" }}>
        <h1 className="panel-title" style={{ margin: "0 0 6px" }}>
          {title}
        </h1>
        <p className="panel-note" style={{ marginBottom: 20 }}>
          {note}
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (settingPassword) {
              submitNewPassword();
            } else {
              submit();
            }
          }}
        >
          <div className="setting-row" style={{ marginBottom: 14 }}>
            <input
              type="password"
              className="setting-control"
              value="password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder={settingPassword ? "设置密码（至少 6 位）" : "密码"}
              aria-label={settingPassword ? "设置访问密码" : "密码"}
              autoComplete={settingPassword ? "new-password" : "current-password"}
            />
          </div>
          {error ? (
            <p className="panel-note" style={{ color: "var(--danger, #e5484d)", marginBottom: 12 }}>
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            className="primary-button"
            disabled={isPending}
            style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : buttonText}
          </button>
        </form>
      </div>
    </main>
  );
}
