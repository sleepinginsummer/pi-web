"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { DEFAULT_TEAM_LEADER_PROMPT, type Team, type TeamMember } from "@/lib/team-types";
import type { TeamRolePreset } from "@/lib/team-role-presets";
import { THINKING_LEVELS } from "@/lib/thinking-levels";
import { DirectoryPicker } from "./DirectoryPicker";
import { TeamDirectoryLabel } from "./TeamDirectoryLabel";

interface ModelOption {
  id: string;
  name: string;
  provider: string;
  providerName?: string;
}

interface Props {
  teams: Team[];
  selectedSessionId: string | null;
  runningSessionIds: ReadonlySet<string>;
  awaitingInputSessionIds: ReadonlySet<string>;
  unreadSessionIds: ReadonlySet<string>;
  defaultCwd: string | null;
  onSelectMemberSession: (sessionId: string, cwd: string) => void;
  onOpenBoard: (teamId: string, teamName: string) => void;
  onTeamsChanged: (openSession?: { sessionId: string; cwd: string }) => void;
}

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 12,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  outline: "none",
};

const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "var(--text-muted)",
  marginBottom: 4,
};

/** 仅在用户通过目录选择器明确确认目录时调用，避免输入草稿提前扩大进程级文件访问白名单。 */
async function authorizeSelectedDirectory(path: string): Promise<string> {
  try {
    const res = await fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: path }),
    });
    if (!res.ok) return path;
    const data = await res.json().catch(() => null) as { cwd?: string } | null;
    return data?.cwd || path;
  } catch {
    return path;
  }
}

function useAvailableModels(enabled: boolean, cwd: string, refreshNonce = 0): ModelOption[] {
  const [models, setModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    if (!enabled) {
      setModels([]);
      return;
    }
    let cancelled = false;
    const trimmed = cwd.trim();
    // 切换目录时立即清空旧目录的模型列表，避免请求中或失败时沿用旧选项。
    setModels([]);
    const timer = setTimeout(() => {
      const query = trimmed ? `?cwd=${encodeURIComponent(trimmed)}` : "";
      fetch(`/api/models${query}`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { modelList?: ModelOption[] } | null) => {
          if (!cancelled) {
            setModels(Array.isArray(data?.modelList) ? data.modelList : []);
          }
        })
        .catch(() => {
          if (!cancelled) setModels([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, cwd, refreshNonce]);
  return models;
}

export function TeamSidebarSection({
  teams,
  selectedSessionId,
  runningSessionIds,
  awaitingInputSessionIds,
  unreadSessionIds,
  defaultCwd,
  onSelectMemberSession,
  onOpenBoard,
  onTeamsChanged,
}: Props) {
  const { t } = useI18n();
  const [collapsedTeamIds, setCollapsedTeamIds] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [editTeam, setEditTeam] = useState<Team | null>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [syncedPresets, setSyncedPresets] = useState<TeamRolePreset[] | null>(null);
  const [addMemberTeam, setAddMemberTeam] = useState<Team | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Team | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const toggleTeamCollapsed = useCallback((teamId: string) => {
    setCollapsedTeamIds((prev) => {
      const next = new Set(prev);
      if (next.has(teamId)) next.delete(teamId);
      else next.add(teamId);
      return next;
    });
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/teams/${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" });
      if (res.ok) {
        setDeleteTarget(null);
        onTeamsChanged();
      }
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteBusy, deleteTarget, onTeamsChanged]);

  return (
    <section data-teams-section style={{ padding: "6px 6px 8px", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px 4px 10px" }}>
        <span style={{ fontSize: 11, fontWeight: 500, color: "var(--text-dim)", userSelect: "none" }}>
          {t("teams.sectionTitle")}
        </span>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <button
            type="button"
            title={t("teams.presetsTitle")}
            onClick={() => setPresetsOpen(true)}
            style={{
              padding: "1px 6px",
              height: 20,
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 10,
              lineHeight: 1,
            }}
          >
            {t("teams.presetsButton")}
          </button>
          <button
            type="button"
            title={t("teams.create")}
            aria-label={t("teams.create")}
            onClick={() => setCreateOpen(true)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 20,
              height: 20,
              borderRadius: 4,
              border: "none",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            +
          </button>
        </div>
      </div>

      {teams.length === 0 ? (
        <div style={{ padding: "4px 10px 4px", fontSize: 11, color: "var(--text-dim)" }}>
          {t("teams.empty")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {teams.map((team) => {
            const collapsed = collapsedTeamIds.has(team.id);
            const sortedMembers = [...team.members].sort((a, b) => (a.role === "leader" ? -1 : b.role === "leader" ? 1 : a.createdAt - b.createdAt));
            const teamCwd = team.members.find((member) => member.role === "leader")?.cwd ?? "";
            return (
              <div key={team.id} data-team-id={team.id}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "4px 6px 4px 8px",
                    borderRadius: 6,
                    fontSize: 12,
                    color: "var(--text)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleTeamCollapsed(team.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      flex: "0 1 auto",
                      minWidth: 0,
                      border: "none",
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                      padding: 0,
                      textAlign: "left",
                    }}
                  >
                    <svg
                      width="9"
                      height="9"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ transform: collapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s", flexShrink: 0, color: "var(--text-dim)" }}
                    >
                      <path d="M3 1.5L7 5L3 8.5" />
                    </svg>
                    <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {team.name}
                    </span>
                  </button>
                  <TeamDirectoryLabel cwd={teamCwd} />
                  <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{team.members.length}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 2, marginLeft: "auto", flexShrink: 0 }}>
                    <button type="button" aria-label={`${team.name} ${t("teams.edit")}`} title={t("teams.edit")} onClick={() => setEditTeam(team)} style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", padding: "2px 4px", fontSize: 11, whiteSpace: "nowrap" }}>
                      {t("teams.edit")}
                    </button>
                    <button type="button" aria-label={`${team.name} ${t("teams.board")}`} title={t("teams.board")} onClick={() => onOpenBoard(team.id, team.name)} style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", padding: "2px 4px", fontSize: 11, whiteSpace: "nowrap" }}>
                      {t("teams.board")}
                    </button>
                    <button type="button" aria-label={t("teams.addMember")} title={t("teams.addMember")} onClick={() => setAddMemberTeam(team)} style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", padding: "2px 4px", fontSize: 11, whiteSpace: "nowrap" }}>
                      {t("teams.addMember")}
                    </button>
                    <button type="button" aria-label={t("teams.delete")} title={t("teams.delete")} onClick={() => setDeleteTarget(team)} style={{ border: "none", background: "transparent", color: "var(--text-dim)", cursor: "pointer", padding: "2px 4px", fontSize: 11, whiteSpace: "nowrap" }}>
                      {t("teams.delete")}
                    </button>
                  </div>
                </div>

                {!collapsed && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, paddingLeft: 14 }}>
                    {sortedMembers.map((member) => {
                      const active = member.sessionId === selectedSessionId;
                      const awaiting = awaitingInputSessionIds.has(member.sessionId);
                      const running = runningSessionIds.has(member.sessionId);
                      const unread = unreadSessionIds.has(member.sessionId);
                      return (
                        <button
                          key={member.id}
                          type="button"
                          onClick={() => onSelectMemberSession(member.sessionId, member.cwd)}
                          title={member.cwd}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            width: "100%",
                            padding: "5px 8px",
                            borderRadius: 6,
                            border: "none",
                            background: active ? "var(--bg-active, rgba(128,128,128,0.16))" : "transparent",
                            color: active ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: 12,
                          }}
                        >
                          <span style={{ width: 12, textAlign: "center", flexShrink: 0, fontSize: 11, color: member.role === "leader" ? "#eab308" : "var(--text-dim)" }}>
                            {member.role === "leader" ? "★" : "·"}
                          </span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: active ? 500 : 400 }}>
                            {member.name}
                          </span>
                          {member.title && (
                            <span style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                              {member.title}
                            </span>
                          )}
                          {!member.title && <span style={{ flex: 1 }} />}
                          {(awaiting || running || unread) && (
                            <span
                              style={{
                                width: 7,
                                height: 7,
                                borderRadius: "50%",
                                flexShrink: 0,
                                background: awaiting ? "#f59e0b" : running ? "#22c55e" : "var(--accent, #3b82f6)",
                              }}
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {createOpen && (
        <CreateTeamModal
          defaultCwd={defaultCwd ?? ""}
          onClose={() => setCreateOpen(false)}
          onCreated={(team) => {
            setCreateOpen(false);
            const leader = team.members.find((m) => m.role === "leader") ?? team.members[0];
            onTeamsChanged(leader ? { sessionId: leader.sessionId, cwd: leader.cwd } : undefined);
          }}
        />
      )}

      {editTeam && (
        <CreateTeamModal
          team={editTeam}
          defaultCwd={editTeam.members.find((member) => member.role === "leader")?.cwd ?? defaultCwd ?? ""}
          onClose={() => setEditTeam(null)}
          onCreated={(updated) => {
            setEditTeam(null);
            const leader = updated.members.find((member) => member.role === "leader");
            onTeamsChanged(leader ? { sessionId: leader.sessionId, cwd: leader.cwd } : undefined);
          }}
        />
      )}

      {addMemberTeam && (
        <AddMemberModal
          team={addMemberTeam}
          syncedPresets={syncedPresets}
          onOpenPresets={() => setPresetsOpen(true)}
          onClose={() => setAddMemberTeam(null)}
          onAdded={(member) => {
            setAddMemberTeam(null);
            onTeamsChanged({ sessionId: member.sessionId, cwd: member.cwd });
          }}
        />
      )}

      {presetsOpen && (
        <RolePresetsModal
          onClose={() => setPresetsOpen(false)}
          onChanged={(nextPresets) => setSyncedPresets(nextPresets)}
        />
      )}

      {deleteTarget && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.42)" }}
          onClick={(e) => { if (e.target === e.currentTarget && !deleteBusy) setDeleteTarget(null); }}
        >
          <div style={{ width: 360, maxWidth: "100%", padding: 18, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", boxShadow: "0 16px 48px rgba(0,0,0,0.28)" }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 14, color: "var(--text)" }}>{t("teams.delete")}</h3>
            <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t("teams.deleteConfirm", { name: deleteTarget.name })}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" disabled={deleteBusy} onClick={() => setDeleteTarget(null)} style={{ padding: "5px 12px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer" }}>
                {t("common.cancel")}
              </button>
              <button type="button" disabled={deleteBusy} onClick={() => void handleConfirmDelete()} style={{ padding: "5px 12px", fontSize: 12, borderRadius: 6, border: "none", background: "#ef4444", color: "#fff", cursor: "pointer" }}>
                {t("common.ok")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}


function RolePresetsModal({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: (presets: TeamRolePreset[]) => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const nameId = useId();
  const promptId = useId();
  useEffect(() => {
    // 原生模态进入顶层，避免移动端侧栏的 transform 把弹窗限制在侧栏内。
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, []);
  const [presets, setPresets] = useState<TeamRolePreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | "new">("new");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [origName, setOrigName] = useState("");
  const [origPrompt, setOrigPrompt] = useState("");
  const [baseUpdatedAt, setBaseUpdatedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTip, setSavedTip] = useState(false);
  const [conflictServerPreset, setConflictServerPreset] = useState<TeamRolePreset | null>(null);

  const locked = loading || busy;

  const selectPreset = useCallback((preset: TeamRolePreset | null) => {
    setError(null);
    setConflictServerPreset(null);
    setSavedTip(false);
    if (!preset) {
      setSelectedId("new");
      setName("");
      setPrompt("");
      setOrigName("");
      setOrigPrompt("");
      setBaseUpdatedAt(null);
      return;
    }
    setSelectedId(preset.id);
    setName(preset.name);
    setPrompt(preset.prompt);
    setOrigName(preset.name);
    setOrigPrompt(preset.prompt);
    setBaseUpdatedAt(preset.updatedAt);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/team-role-presets", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { presets?: TeamRolePreset[] } | null) => {
        if (cancelled) return;
        const list = Array.isArray(data?.presets) ? data.presets : [];
        setPresets(list);
        if (list.length > 0) {
          selectPreset(list[0]);
        } else {
          selectPreset(null);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectPreset]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (locked) return;
    const isNew = selectedId === "new";
    const nameChanged = name !== origName;
    const promptChanged = prompt !== origPrompt;
    if (!isNew && !nameChanged && !promptChanged) {
      setSavedTip(true);
      return;
    }
    setBusy(true);
    setError(null);
    setSavedTip(false);
    setConflictServerPreset(null);
    try {
      const url = isNew
        ? "/api/team-role-presets"
        : `/api/team-role-presets/${encodeURIComponent(selectedId)}`;
      const payload = isNew
        ? { name, prompt }
        : {
          ...(nameChanged ? { name } : {}),
          ...(promptChanged ? { prompt } : {}),
          ...(baseUpdatedAt !== null ? { expectedUpdatedAt: baseUpdatedAt } : {}),
        };
      const res = await fetch(url, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({})) as {
        preset?: TeamRolePreset;
        presets?: TeamRolePreset[];
        conflict?: boolean;
        error?: string;
      };
      if (res.status === 409 && data.conflict && data.preset) {
        if (Array.isArray(data.presets)) {
          setPresets(data.presets);
          onChanged(data.presets);
        }
        if (!nameChanged) setName(data.preset.name);
        if (!promptChanged) setPrompt(data.preset.prompt);
        setOrigName(data.preset.name);
        setOrigPrompt(data.preset.prompt);
        setBaseUpdatedAt(data.preset.updatedAt);
        setConflictServerPreset(data.preset);
        setError(t("teams.presetsConflictSave"));
        return;
      }
      if (!res.ok || !data.preset) throw new Error(data.error ?? `HTTP ${res.status}`);
      const nextList = Array.isArray(data.presets) ? data.presets : presets;
      setPresets(nextList);
      selectPreset(data.preset);
      setSavedTip(true);
      onChanged(nextList);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (busy || selectedId === "new") return;
    setBusy(true);
    setError(null);
    setSavedTip(false);
    setConflictServerPreset(null);
    try {
      const query = baseUpdatedAt !== null ? `?expectedUpdatedAt=${encodeURIComponent(String(baseUpdatedAt))}` : "";
      const res = await fetch(`/api/team-role-presets/${encodeURIComponent(selectedId)}${query}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({})) as {
        preset?: TeamRolePreset;
        presets?: TeamRolePreset[];
        conflict?: boolean;
        error?: string;
      };
      if (res.status === 409 && data.conflict && data.preset) {
        if (Array.isArray(data.presets)) {
          setPresets(data.presets);
          onChanged(data.presets);
        }
        const nameChanged = name !== origName;
        const promptChanged = prompt !== origPrompt;
        if (nameChanged || promptChanged) {
          if (!nameChanged) setName(data.preset.name);
          if (!promptChanged) setPrompt(data.preset.prompt);
          setOrigName(data.preset.name);
          setOrigPrompt(data.preset.prompt);
          setBaseUpdatedAt(data.preset.updatedAt);
          setConflictServerPreset(data.preset);
          setError(t("teams.presetsConflictDeleteWithDraft"));
        } else {
          selectPreset(data.preset);
          setError(t("teams.presetsConflictDelete"));
        }
        return;
      }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const nextList = Array.isArray(data.presets)
        ? data.presets
        : presets.filter((item) => item.id !== selectedId);
      setPresets(nextList);
      selectPreset(nextList[0] ?? null);
      onChanged(nextList);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="team-role-presets-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => { event.stopPropagation(); event.preventDefault(); if (!busy) onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="team-role-presets-panel">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <h3 id={titleId} style={{ margin: 0, fontSize: 14, color: "var(--text)" }}>{t("teams.presetsTitle")}</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              disabled={locked}
              onClick={() => selectPreset(null)}
              style={{ padding: "4px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer" }}
            >
              + {t("teams.presetsNew")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              aria-label={t("common.cancel")}
              style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "2px 4px" }}
            >
              ×
            </button>
          </div>
        </div>

        <div className="team-role-presets-body">
          <div className="team-role-presets-list scrollbar-subtle">
            {loading ? (
              <div style={{ padding: 8, fontSize: 12, color: "var(--text-dim)" }}>...</div>
            ) : presets.length === 0 ? (
              <div style={{ padding: 8, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                {t("teams.presetsEmpty")}
              </div>
            ) : (
              presets.map((preset) => {
                const active = selectedId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={locked}
                    aria-pressed={active}
                    onClick={() => selectPreset(preset)}
                    style={{
                      textAlign: "left",
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: "none",
                      background: active ? "var(--bg-active, rgba(128,128,128,0.16))" : "transparent",
                      color: active ? "var(--text)" : "var(--text-muted)",
                      fontWeight: active ? 500 : 400,
                      fontSize: 12,
                      cursor: "pointer",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {preset.name}
                  </button>
                );
              })
            )}
          </div>

          <form className="team-role-presets-form scrollbar-subtle" onSubmit={(e) => void handleSave(e)}>
            {error && <div style={{ fontSize: 12, color: "#f87171", flexShrink: 0 }}>{error}</div>}
            {conflictServerPreset && (
              <div style={{ padding: 8, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-muted, rgba(128,128,128,0.08))", fontSize: 11, color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <strong style={{ color: "var(--text)" }}>{t("teams.presetsServerLatest")}: {conflictServerPreset.name}</strong>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => selectPreset(conflictServerPreset)}
                    style={{ padding: "2px 8px", fontSize: 11, borderRadius: 4, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer" }}
                  >
                    {t("teams.presetsUseServerVersion")}
                  </button>
                </div>
                <pre style={{ margin: 0, maxHeight: 72, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit" }}>
                  {conflictServerPreset.prompt || t("teams.presetsEmptyPrompt")}
                </pre>
              </div>
            )}
            <div style={{ flexShrink: 0 }}>
              <label htmlFor={nameId} style={LABEL_STYLE}>{t("teams.presetsName")}</label>
              <input
                id={nameId}
                required
                disabled={locked}
                value={name}
                onChange={(e) => { setName(e.target.value); setSavedTip(false); }}
                style={{ ...INPUT_STYLE, fontSize: "var(--role-preset-field-size, 12px)" }}
                placeholder="例如：后端开发 / 代码审核"
              />
            </div>
            <div style={{ flex: "1 0 140px", minWidth: 0, display: "flex", flexDirection: "column" }}>
              <label htmlFor={promptId} style={LABEL_STYLE}>{t("teams.presetsPrompt")}</label>
              <textarea
                id={promptId}
                disabled={locked}
                value={prompt}
                onChange={(e) => { setPrompt(e.target.value); setSavedTip(false); }}
                style={{ ...INPUT_STYLE, fontSize: "var(--role-preset-field-size, 12px)", flex: 1, resize: "none", minHeight: 120 }}
                placeholder={t("teams.presetsPromptPlaceholder")}
              />
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, flexShrink: 0 }}>
              <div>
                {selectedId !== "new" && (
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => void handleDelete()}
                    style={{ padding: "5px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "#f87171", cursor: "pointer" }}
                  >
                    {t("teams.presetsDeleteConfirm")}
                  </button>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {savedTip && <span style={{ fontSize: 11, color: "#22c55e" }}>{t("teams.presetsSaved")}</span>}
                <button
                  type="submit"
                  disabled={locked}
                  style={{ padding: "6px 14px", fontSize: 12, borderRadius: 6, border: "none", background: "var(--accent, #2563eb)", color: "#fff", cursor: "pointer" }}
                >
                  {t("systemPromptAddon.save")}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </dialog>
  );
}

function CreateTeamModal({
  team,
  defaultCwd,
  onClose,
  onCreated,
}: {
  team?: Team;
  defaultCwd: string;
  onClose: () => void;
  onCreated: (team: Team) => void;
}) {
  const { t } = useI18n();
  const leader = team?.members.find((member) => member.role === "leader");
  const [name, setName] = useState(team?.name ?? "");
  const [prompt, setPrompt] = useState(team?.prompt ?? "");
  const [leaderName, setLeaderName] = useState(leader?.name ?? "leader");
  const [leaderPrompt, setLeaderPrompt] = useState(leader?.prompt ?? (team ? "" : DEFAULT_TEAM_LEADER_PROMPT));
  const [confirming, setConfirming] = useState(false);
  const [cwd, setCwd] = useState(defaultCwd);
  const cwdSeqRef = useRef(0);
  const [modelsRefreshNonce, setModelsRefreshNonce] = useState(0);
  const models = useAvailableModels(true, cwd, modelsRefreshNonce);
  const [modelKey, setModelKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("auto");
  const [dirPickerOpen, setDirPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    // 目录选择器通过 portal 打开；临时让出原生模态顶层，返回后恢复编辑草稿。
    if (!dirPickerOpen) dialog?.showModal();
    return () => { dialog?.close(); };
  }, [dirPickerOpen]);
  const effectiveModelKey = modelKey && models.some((m) => `${m.provider}:${m.id}` === modelKey)
    ? modelKey
    : "";

  useEffect(() => {
    if (modelKey && !models.some((m) => `${m.provider}:${m.id}` === modelKey)) {
      setModelKey("");
    }
  }, [modelKey, models]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (team && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const [provider, ...rest] = effectiveModelKey ? effectiveModelKey.split(":") : [];
      const modelId = rest.join(":");
      const res = await fetch(team ? `/api/teams/${encodeURIComponent(team.id)}` : "/api/teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          prompt,
          leaderName,
          leaderPrompt,
          ...(team ? { confirmRebuild: true, expectedUpdatedAt: team.updatedAt } : {}),
          cwd,
          ...(provider && modelId ? { provider, modelId } : {}),
          ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as { team?: Team; error?: string };
      if (!res.ok || !data.team) throw new Error(data.error ?? `HTTP ${res.status}`);
      onCreated(data.team);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}
        style={{ padding: 0, border: 0, width: 440, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(var(--app-viewport-height, 100dvh) - 32px)", background: "transparent", color: "var(--text)" }}
      >
        <form
          onSubmit={(e) => void handleSubmit(e)}
          style={{ width: 440, maxWidth: "100%", maxHeight: "calc(var(--app-viewport-height, 100dvh) - 32px)", overflowY: "auto", padding: 18, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", boxShadow: "0 16px 48px rgba(0,0,0,0.28)", display: "flex", flexDirection: "column", gap: 12 }}
        >
          <h3 id={titleId} style={{ margin: 0, fontSize: 15, color: "var(--text)" }}>{team ? t("teams.editTitle") : t("teams.createTitle")}</h3>
          {error && <div style={{ fontSize: 12, color: "#f87171" }}>{error}</div>}
          <fieldset disabled={busy || confirming} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={LABEL_STYLE}>{t("teams.teamName")}</label>
              <input required value={name} onChange={(e) => setName(e.target.value)} style={INPUT_STYLE} placeholder="例如：支付重构组" />
            </div>
            <div>
              <label style={LABEL_STYLE}>{t("teams.teamPrompt")}</label>
              <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ ...INPUT_STYLE, resize: "vertical" }} placeholder={t("teams.teamPromptPlaceholder")} />
            </div>
            <div>
              <label style={LABEL_STYLE}>{t("teams.leaderName")}</label>
              <input required value={leaderName} onChange={(e) => setLeaderName(e.target.value)} style={INPUT_STYLE} />
            </div>
            <div>
              <label style={LABEL_STYLE}>{t("teams.cwd")}</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input required value={cwd} onChange={(e) => { cwdSeqRef.current += 1; setCwd(e.target.value); }} style={{ ...INPUT_STYLE, flex: 1 }} placeholder="/path/to/project" />
                <button type="button" onClick={() => setDirPickerOpen(true)} style={{ padding: "0 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer", flexShrink: 0 }}>
                  {t("teams.cwdBrowse")}
                </button>
              </div>
            </div>
            <div>
              <label style={LABEL_STYLE}>{t("teams.model")}</label>
              <select value={effectiveModelKey} onChange={(e) => setModelKey(e.target.value)} style={INPUT_STYLE}>
                <option value="">{team ? t("teams.keepCurrent") : t("teams.modelDefault")}</option>
                {models.map((m) => (
                  <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>
                    {m.providerName ?? m.provider} / {m.name || m.id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={LABEL_STYLE}>{t("teams.thinking")}</label>
              <select value={thinkingLevel} onChange={(e) => setThinkingLevel(e.target.value)} style={INPUT_STYLE}>
                <option value="auto">{team ? t("teams.keepCurrent") : t("teams.thinkingAuto")}</option>
                {THINKING_LEVELS.map((lvl) => <option key={lvl} value={lvl}>{lvl}</option>)}
              </select>
            </div>
            <div>
              <label style={LABEL_STYLE}>{t("teams.leaderPrompt")}</label>
              <textarea rows={6} value={leaderPrompt} onChange={(e) => setLeaderPrompt(e.target.value)} style={{ ...INPUT_STYLE, resize: "vertical" }} />
            </div>
          </fieldset>
          {confirming && team && <div role="alert" style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.6 }}>{t("teams.rebuildConfirm", { count: team.members.length })}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
            <button type="button" disabled={busy} onClick={() => confirming ? setConfirming(false) : onClose()} style={{ padding: "6px 12px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer" }}>
              {confirming ? t("teams.backToEdit") : t("common.cancel")}
            </button>
            <button type="submit" disabled={busy} style={{ padding: "6px 14px", fontSize: 12, borderRadius: 6, border: "none", background: "var(--accent, #2563eb)", color: "#fff", cursor: "pointer" }}>
              {busy ? t("teams.saving") : team ? confirming ? t("teams.confirmRebuild") : t("teams.save") : t("teams.submitCreate")}
            </button>
          </div>
        </form>
      </dialog>
      {dirPickerOpen && (
        <DirectoryPicker
          initialPath={cwd || undefined}
          onCancel={() => setDirPickerOpen(false)}
          onSelect={(path) => {
            const seq = ++cwdSeqRef.current;
            setDirPickerOpen(false);
            setCwd(path);
            setModelKey("");
            void authorizeSelectedDirectory(path).then((resolved) => {
              if (cwdSeqRef.current !== seq) return;
              if (resolved !== path) setCwd(resolved);
              setModelsRefreshNonce((n) => n + 1);
            });
          }}
        />
      )}
    </>
  );
}

function AddMemberModal({
  team,
  syncedPresets,
  onOpenPresets,
  onClose,
  onAdded,
}: {
  team: Team;
  syncedPresets: TeamRolePreset[] | null;
  onOpenPresets: () => void;
  onClose: () => void;
  onAdded: (member: TeamMember) => void;
}) {
  const { t } = useI18n();
  const leaderCwd = team.members.find((m) => m.role === "leader")?.cwd ?? "";
  const presets = useRolePresets(true, syncedPresets);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const customDraftRef = useRef<{ title: string; prompt: string }>({ title: "", prompt: "" });
  const presetFilledRef = useRef<{ title: string; prompt: string } | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const cwdSeqRef = useRef(0);
  const [modelsRefreshNonce, setModelsRefreshNonce] = useState(0);
  const models = useAvailableModels(true, cwd.trim() || leaderCwd, modelsRefreshNonce);
  const [modelKey, setModelKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("auto");
  const [dirPickerOpen, setDirPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveModelKey = modelKey && models.some((m) => `${m.provider}:${m.id}` === modelKey)
    ? modelKey
    : "";

  useEffect(() => {
    if (modelKey && !models.some((m) => `${m.provider}:${m.id}` === modelKey)) {
      setModelKey("");
    }
  }, [modelKey, models]);

  useEffect(() => {
    if (selectedPresetId && !presets.some((p) => p.id === selectedPresetId)) {
      const filled = presetFilledRef.current;
      presetFilledRef.current = null;
      setSelectedPresetId("");
      setTitle((cur) => (!filled || cur === filled.title ? customDraftRef.current.title : cur));
      setPrompt((cur) => (!filled || cur === filled.prompt ? customDraftRef.current.prompt : cur));
    }
  }, [selectedPresetId, presets]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const [provider, ...rest] = effectiveModelKey ? effectiveModelKey.split(":") : [];
      const modelId = rest.join(":");
      const res = await fetch(`/api/teams/${encodeURIComponent(team.id)}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          title,
          prompt,
          ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
          ...(provider && modelId ? { provider, modelId } : {}),
          ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as { member?: TeamMember; error?: string };
      if (!res.ok || !data.member) throw new Error(data.error ?? `HTTP ${res.status}`);
      onAdded(data.member);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.42)" }}
        onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      >
        <form
          onSubmit={(e) => void handleSubmit(e)}
          style={{ width: 440, maxWidth: "100%", maxHeight: "88vh", overflowY: "auto", padding: 18, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", boxShadow: "0 16px 48px rgba(0,0,0,0.28)", display: "flex", flexDirection: "column", gap: 12 }}
        >
          <h3 style={{ margin: 0, fontSize: 15, color: "var(--text)" }}>{t("teams.addMemberTitle")} · {team.name}</h3>
          {error && <div style={{ fontSize: 12, color: "#f87171" }}>{error}</div>}
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <label style={{ ...LABEL_STYLE, marginBottom: 0 }}>{t("teams.presetsSelectLabel")}</label>
              <button
                type="button"
                onClick={onOpenPresets}
                style={{ border: "none", background: "transparent", color: "var(--accent, #3b82f6)", fontSize: 11, cursor: "pointer", padding: 0 }}
              >
                {t("teams.presetsManage")}
              </button>
            </div>
            <select
              value={selectedPresetId}
              onChange={(e) => {
                const nextId = e.target.value;
                if (!selectedPresetId && nextId) {
                  customDraftRef.current = { title, prompt };
                }
                setSelectedPresetId(nextId);
                if (!nextId) {
                  presetFilledRef.current = null;
                  setTitle(customDraftRef.current.title);
                  setPrompt(customDraftRef.current.prompt);
                  return;
                }
                const found = presets.find((p) => p.id === nextId);
                if (found) {
                  presetFilledRef.current = { title: found.name, prompt: found.prompt };
                  setTitle(found.name);
                  setPrompt(found.prompt);
                }
              }}
              style={INPUT_STYLE}
            >
              <option value="">{t("teams.presetsNone")}</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={LABEL_STYLE}>{t("teams.memberName")}</label>
              <input required value={name} onChange={(e) => setName(e.target.value)} style={INPUT_STYLE} placeholder="dev-1" />
            </div>
            <div>
              <label style={LABEL_STYLE}>{t("teams.memberTitle")}</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} style={INPUT_STYLE} placeholder="后端开发" />
            </div>
          </div>
          <div>
            <label style={LABEL_STYLE}>{t("teams.memberPrompt")}</label>
            <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ ...INPUT_STYLE, resize: "vertical" }} />
          </div>
          <div>
            <label style={LABEL_STYLE}>{t("teams.cwd")}</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input value={cwd} onChange={(e) => { cwdSeqRef.current += 1; setCwd(e.target.value); }} style={{ ...INPUT_STYLE, flex: 1 }} placeholder={leaderCwd || t("teams.cwdSameAsLeader")} />
              <button type="button" onClick={() => setDirPickerOpen(true)} style={{ padding: "0 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer", flexShrink: 0 }}>
                {t("teams.cwdBrowse")}
              </button>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={LABEL_STYLE}>{t("teams.model")}</label>
              <select value={effectiveModelKey} onChange={(e) => setModelKey(e.target.value)} style={INPUT_STYLE}>
                <option value="">{t("teams.modelSameAsLeader")}</option>
                {models.map((m) => (
                  <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>
                    {m.providerName ?? m.provider} / {m.name || m.id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={LABEL_STYLE}>{t("teams.thinking")}</label>
              <select value={thinkingLevel} onChange={(e) => setThinkingLevel(e.target.value)} style={INPUT_STYLE}>
                <option value="auto">{t("teams.thinkingSameAsLeader")}</option>
                {THINKING_LEVELS.map((lvl) => <option key={lvl} value={lvl}>{lvl}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
            <button type="button" disabled={busy} onClick={onClose} style={{ padding: "6px 12px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer" }}>
              {t("common.cancel")}
            </button>
            <button type="submit" disabled={busy} style={{ padding: "6px 14px", fontSize: 12, borderRadius: 6, border: "none", background: "var(--accent, #2563eb)", color: "#fff", cursor: "pointer" }}>
              {t("teams.submitAddMember")}
            </button>
          </div>
        </form>
      </div>
      {dirPickerOpen && (
        <DirectoryPicker
          initialPath={cwd || leaderCwd || undefined}
          onCancel={() => setDirPickerOpen(false)}
          onSelect={(path) => {
            const seq = ++cwdSeqRef.current;
            setDirPickerOpen(false);
            setCwd(path);
            setModelKey("");
            void authorizeSelectedDirectory(path).then((resolved) => {
              if (cwdSeqRef.current !== seq) return;
              if (resolved !== path) setCwd(resolved);
              setModelsRefreshNonce((n) => n + 1);
            });
          }}
        />
      )}
    </>
  );
}

function useRolePresets(enabled: boolean, syncedPresets: TeamRolePreset[] | null): TeamRolePreset[] {
  const [presets, setPresets] = useState<TeamRolePreset[]>([]);
  const seqRef = useRef(0);
  const lastSyncedRef = useRef(syncedPresets);
  useEffect(() => {
    if (syncedPresets === lastSyncedRef.current) return;
    lastSyncedRef.current = syncedPresets;
    if (syncedPresets !== null) {
      seqRef.current += 1;
      setPresets(syncedPresets);
    }
  }, [syncedPresets]);
  useEffect(() => {
    if (!enabled) return;
    const seq = ++seqRef.current;
    let cancelled = false;
    fetch("/api/team-role-presets", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { presets?: TeamRolePreset[] } | null) => {
        if (!cancelled && seqRef.current === seq && Array.isArray(data?.presets)) {
          setPresets(data.presets);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return presets;
}
