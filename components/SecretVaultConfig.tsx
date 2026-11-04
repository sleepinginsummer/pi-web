"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigEmptyState, ConfigPanelShell, ConfigSectionTitle } from "./SettingsUi";

interface SecretRow {
  name: string;
  addedAt: number;
  length: number;
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
/** Below this the extension does not hide a value in output, because it would hit ordinary text. */
const MIN_HIDDEN_LENGTH = 6;

const inputStyle = {
  width: "100%",
  padding: "9px 10px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--text)",
  outline: "none",
  fontSize: 13,
} as const;

/** Settings › Vault: names only. There is deliberately no way to read a value back here. */
export function SecretVaultConfig({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [secrets, setSecrets] = useState<SecretRow[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const apply = useCallback(async (response: Response) => {
    const data = await response.json() as { secrets?: SecretRow[]; error?: string };
    if (!response.ok || !data.secrets) throw new Error(data.error ?? t("vault.loadFailed"));
    setSecrets(data.secrets);
  }, [t]);

  useEffect(() => {
    fetch("/api/secret-vault").then(apply).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [apply]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !NAME_RE.test(name) || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apply(await fetch("/api/secret-vault", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, value }),
      }));
      setName("");
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: string) => {
    setBusy(true);
    setError(null);
    try {
      await apply(await fetch(`/api/secret-vault?name=${encodeURIComponent(target)}`, { method: "DELETE" }));
      setConfirming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const nameInvalid = name.length > 0 && !NAME_RE.test(name);
  return (
    <ConfigPanelShell embedded title={t("settings.vault")} onClose={onClose}>
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16, overflowY: "auto", minHeight: 0 }}>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{t("vault.description")}</div>
        <form onSubmit={add} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <ConfigSectionTitle>{t("vault.addTitle")}</ConfigSectionTitle>
          <input
            aria-label={t("vault.nameLabel")}
            placeholder={t("vault.namePlaceholder")}
            value={name}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
            style={inputStyle}
          />
          {nameInvalid && <div style={{ fontSize: 12, color: "var(--danger, #d33)" }}>{t("vault.nameInvalid")}</div>}
          <input
            type="password"
            aria-label={t("vault.valueLabel")}
            placeholder={t("vault.valuePlaceholder")}
            value={value}
            autoComplete="new-password"
            spellCheck={false}
            onChange={(event) => setValue(event.target.value)}
            style={inputStyle}
          />
          {value.length > 0 && value.length < MIN_HIDDEN_LENGTH && (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("vault.tooShort", { count: MIN_HIDDEN_LENGTH })}</div>
          )}
          <div>
            <ConfigButton type="submit" disabled={busy || !NAME_RE.test(name) || !value.trim()}>{t("vault.save")}</ConfigButton>
          </div>
        </form>
        {error && <div role="alert" style={{ fontSize: 12, color: "var(--danger, #d33)" }}>{error}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <ConfigSectionTitle>{t("vault.savedTitle")}</ConfigSectionTitle>
          {secrets?.length === 0 && <ConfigEmptyState>{t("vault.empty")}</ConfigEmptyState>}
          {secrets?.map((secret) => (
            <div
              key={secret.name}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 7 }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 13, overflowWrap: "anywhere" }}>{`{{sec:${secret.name}}}`}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {t("vault.rowMeta", { length: secret.length, date: new Date(secret.addedAt).toLocaleDateString() })}
                </div>
              </div>
              {confirming === secret.name ? (
                <>
                  <ConfigButton disabled={busy} onClick={() => void remove(secret.name)}>{t("vault.confirmRemove")}</ConfigButton>
                  <ConfigButton disabled={busy} onClick={() => setConfirming(null)}>{t("chat.cancel")}</ConfigButton>
                </>
              ) : (
                <ConfigButton disabled={busy} onClick={() => setConfirming(secret.name)}>{t("vault.remove")}</ConfigButton>
              )}
            </div>
          ))}
        </div>
      </div>
    </ConfigPanelShell>
  );
}
