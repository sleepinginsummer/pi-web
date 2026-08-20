"use client";

import { FormEvent, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getSafeInternalPath } from "@/lib/web-auth-redirect";
import styles from "./login.module.css";

export function LoginForm() {
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setError("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/web-auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, remember }),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        setError(result?.error ?? "登录失败，请重试");
        return;
      }
      window.location.replace(getSafeInternalPath(searchParams.get("next")));
    } catch {
      setError("无法连接登录服务，请检查网络后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.ambient} aria-hidden="true" />
      <section className={styles.panel} aria-labelledby="login-title">
        <div className={styles.brandMark} aria-hidden="true">π</div>
        <header className={styles.header}>
          <h1 id="login-title">登录 Pi Web</h1>
          <p>验证身份后继续访问工作区</p>
        </header>

        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label htmlFor="username">用户名</label>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              required
              maxLength={64}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={submitting}
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="password">密码</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "login-error" : undefined}
            />
          </div>

          <div className={styles.formMeta}>
            <label className={styles.remember}>
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                disabled={submitting}
              />
              <span>保持登录 30 天</span>
            </label>
            <span className={styles.secureNote}>仅限受信任设备</span>
          </div>

          <div className={styles.feedback} aria-live="polite">
            {error && <span id="login-error" role="alert">{error}</span>}
          </div>

          <button type="submit" disabled={submitting}>
            {submitting ? "正在登录…" : "登录"}
          </button>
        </form>

        <footer className={styles.footer}>
          <span aria-hidden="true" />
          <p>Private workspace</p>
          <span aria-hidden="true" />
        </footer>
      </section>
    </main>
  );
}
