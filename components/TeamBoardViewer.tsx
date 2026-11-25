"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  TEAM_CARD_STATUSES,
  type Team,
  type TeamCard,
  type TeamCardStatus,
  type TeamMember,
} from "@/lib/team-types";

import { TeamDirectoryLabel } from "./TeamDirectoryLabel";

const POLL_MS = 2_500;

interface Props {
  teamId: string;
  fallbackLabel: string;
  onOpenMemberSession: (sessionId: string, cwd: string) => void;
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

function formatRelativeTime(ms: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return new Date(ms).toLocaleDateString();
}

export function TeamBoardViewer({ teamId, fallbackLabel, onOpenMemberSession }: Props) {
  const { t } = useI18n();
  const [team, setTeam] = useState<Team | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [awaitingIds, setAwaitingIds] = useState<Set<string>>(new Set());
  const [missing, setMissing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const selectedCard = selectedCardId && team ? team.cards.find((c) => c.id === selectedCardId) ?? null : null;
  const [notice, setNotice] = useState<string | null>(null);

  const reportReviewNotice = useCallback((reviewNotification?: { notified: boolean; reviewerName?: string; error?: string }) => {
    if (reviewNotification && !reviewNotification.notified && reviewNotification.error) {
      const who = reviewNotification.reviewerName ? ` ${reviewNotification.reviewerName}` : "";
      setNotice(`卡片已保存为待审核，但未能通知审核人${who}：${reviewNotification.error}`);
    }
  }, []);

  const statusLabel = useCallback((status: TeamCardStatus) => {
    switch (status) {
      case "todo": return t("teams.boardStatusTodo");
      case "doing": return t("teams.boardStatusDoing");
      case "review": return t("teams.boardStatusReview");
      case "done": return t("teams.boardStatusDone");
      case "blocked": return t("teams.boardStatusBlocked");
    }
  }, [t]);

  const boardEpochRef = useRef(0);

  const fetchBoard = useCallback(async () => {
    const epoch = ++boardEpochRef.current;
    try {
      const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}`, { cache: "no-store" });
      if (epoch !== boardEpochRef.current) return;
      if (res.status === 404) {
        setMissing(true);
        return;
      }
      if (!res.ok) return;
      const data = await res.json() as {
        team?: Team;
        runningSessionIds?: string[];
        awaitingInputSessionIds?: string[];
      };
      if (epoch !== boardEpochRef.current) return;
      if (data.team) {
        setMissing(false);
        setTeam(data.team);
      }
      setRunningIds(new Set(data.runningSessionIds ?? []));
      setAwaitingIds(new Set(data.awaitingInputSessionIds ?? []));
    } catch {
      // 保留上次快照，下次轮询重试。
    }
  }, [teamId]);

  const applyTeamSnapshot = useCallback((updatedTeam: Team, options?: { refresh?: boolean }) => {
    // 淘汰此前发出的在途轮询，避免旧响应晚到把刚收到的最新快照（含 409 冲突卡片）覆盖回旧值。
    boardEpochRef.current += 1;
    setMissing(false);
    setTeam(updatedTeam);
    if (options?.refresh) {
      void fetchBoard();
    }
  }, [fetchBoard]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (!stopped) timer = setTimeout(() => { void tick(false); }, POLL_MS);
    };
    const tick = async (force: boolean) => {
      if (force || typeof document === "undefined" || document.visibilityState !== "hidden") {
        await fetchBoard();
      }
      schedule();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") {
        void fetchBoard();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void tick(true);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetchBoard]);

  if (missing) {
    return (
      <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>
        {t("teams.boardMissing")}
      </div>
    );
  }

  const membersById = new Map<string, TeamMember>();
  for (const member of team?.members ?? []) membersById.set(member.id, member);
  const sortedMembers = [...(team?.members ?? [])].sort((a, b) => (a.role === "leader" ? -1 : b.role === "leader" ? 1 : a.createdAt - b.createdAt));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "var(--bg)" }}>
      {/* 顶栏 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {team?.name ?? fallbackLabel}
          </span>
          {team && <TeamDirectoryLabel cwd={team.members.find((member) => member.role === "leader")?.cwd ?? ""} />}
          {team && (
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {team.members.length} · {team.cards.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          style={{
            padding: "4px 10px",
            fontSize: 12,
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--text)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          + {t("teams.boardNewCard")}
        </button>
      </div>

      {/* 上半部分：成员实时状态（系统自动维护） */}
      {notice && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 14px", borderBottom: "1px solid var(--border)", background: "rgba(245, 158, 11, 0.12)", color: "#f59e0b", fontSize: 12, flexShrink: 0 }}>
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示" style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 4px", flexShrink: 0 }}>
            ×
          </button>
        </div>
      )}

      {/* 上半部分：成员实时状态（系统自动维护，限高可滚动避免挤占看板） */}
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0, maxHeight: "34%", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-dim)", marginBottom: 6, flexShrink: 0 }}>
          {t("teams.boardMembers")}
        </div>
        <div className="scrollbar-subtle" style={{ display: "flex", flexDirection: "column", gap: 4, overflowY: "auto", minHeight: 0 }}>
          {sortedMembers.map((member) => {
            const awaiting = awaitingIds.has(member.sessionId);
            const running = runningIds.has(member.sessionId);
            const statusText = awaiting ? t("teams.boardAwaiting") : running ? t("teams.boardRunning") : t("teams.boardIdle");
            const dotColor = awaiting ? "#f59e0b" : running ? "#22c55e" : "var(--text-dim)";
            return (
              <button
                key={member.id}
                type="button"
                onClick={() => onOpenMemberSession(member.sessionId, member.cwd)}
                title={`${t("teams.boardOpenChat")} · ${member.cwd}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "5px 8px",
                  borderRadius: 6,
                  border: "1px solid transparent",
                  background: "var(--bg-subtle, rgba(128,128,128,0.06))",
                  color: "var(--text)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 12,
                }}
              >
                <span style={{ color: member.role === "leader" ? "#eab308" : "var(--text-dim)", fontSize: 11, width: 12, textAlign: "center", flexShrink: 0 }}>
                  {member.role === "leader" ? "★" : "·"}
                </span>
                <span style={{ fontWeight: 500, flexShrink: 0 }}>{member.name}</span>
                {member.title && (
                  <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>{member.title}</span>
                )}
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor }} />
                  {statusText}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "var(--text-muted)" }}>
                  {member.lastActivity
                    ? `${formatRelativeTime(member.lastActivity.at)} · ${member.lastActivity.summary}`
                    : t("teams.boardNoActivity")}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 下半部分：5 列看板 */}
      <div style={{ flex: 1, minHeight: 0, overflowX: "auto", overflowY: "hidden", padding: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(180px, 1fr))", gap: 10, height: "100%" }}>
          {TEAM_CARD_STATUSES.map((status) => {
            const cards = (team?.cards ?? []).filter((card) => card.status === status);
            return (
              <div
                key={status}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg-subtle, rgba(128,128,128,0.04))",
                  overflow: "hidden",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", borderBottom: "1px solid var(--border)", fontSize: 12, fontWeight: 500, color: "var(--text)" }}>
                  <span>{statusLabel(status)}</span>
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{cards.length}</span>
                </div>
                <div className="scrollbar-subtle" style={{ flex: 1, overflowY: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                  {cards.map((card) => {
                    const assignee = card.assigneeId ? membersById.get(card.assigneeId) : undefined;
                    const reviewer = card.reviewerId ? membersById.get(card.reviewerId) : undefined;
                    const lastNote = card.notes[card.notes.length - 1];
                    return (
                      <button
                        key={card.id}
                        type="button"
                        onClick={() => setSelectedCardId(card.id)}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 5,
                          width: "100%",
                          padding: "8px 10px",
                          borderRadius: 6,
                          border: "1px solid var(--border)",
                          background: "var(--bg)",
                          color: "var(--text)",
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.4 }}>{card.title}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {assignee ? assignee.name : t("teams.boardUnassigned")}
                          {reviewer ? ` → ${reviewer.name}` : ""}
                        </div>
                        {lastNote?.text && (
                          <div style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", lineHeight: 1.4 }}>
                            {lastNote.text}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {createOpen && team && (
        <CreateCardModal
          team={team}
          statusLabel={statusLabel}
          onClose={() => setCreateOpen(false)}
          onCreated={(_updatedTeam, reviewNotification) => {
            setCreateOpen(false);
            reportReviewNotice(reviewNotification);
            void fetchBoard();
          }}
        />
      )}

      {selectedCard && team && (
        <CardDetailModal
          team={team}
          card={selectedCard}
          membersById={membersById}
          statusLabel={statusLabel}
          onOpenMemberSession={onOpenMemberSession}
          onClose={() => setSelectedCardId(null)}
          onConflictSync={(updatedTeam) => {
            applyTeamSnapshot(updatedTeam, { refresh: true });
          }}
          onUpdated={(_updatedTeam, reviewNotification) => {
            setSelectedCardId(null);
            reportReviewNotice(reviewNotification);
            void fetchBoard();
          }}
        />
      )}
    </div>
  );
}

function CreateCardModal({
  team,
  statusLabel,
  onClose,
  onCreated,
}: {
  team: Team;
  statusLabel: (status: TeamCardStatus) => string;
  onClose: () => void;
  onCreated: (team: Team, reviewNotification?: { notified: boolean; reviewerName?: string; error?: string }) => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<TeamCardStatus>("todo");
  const [assignee, setAssignee] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/teams/${encodeURIComponent(team.id)}/cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          status,
          ...(assignee ? { assignee } : {}),
          ...(reviewer ? { reviewer } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as {
        team?: Team;
        error?: string;
        reviewNotification?: { notified: boolean; reviewerName?: string; error?: string };
      };
      if (!res.ok || !data.team) throw new Error(data.error ?? `HTTP ${res.status}`);
      onCreated(data.team, data.reviewNotification);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.42)" }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{ width: 420, maxWidth: "100%", padding: 18, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", boxShadow: "0 16px 48px rgba(0,0,0,0.28)", display: "flex", flexDirection: "column", gap: 12 }}
      >
        <h3 style={{ margin: 0, fontSize: 15, color: "var(--text)" }}>{t("teams.boardNewCard")}</h3>
        {error && <div style={{ fontSize: 12, color: "#f87171" }}>{error}</div>}
        <div>
          <label style={LABEL_STYLE}>{t("teams.boardCardTitle")}</label>
          <input required value={title} onChange={(e) => setTitle(e.target.value)} style={INPUT_STYLE} />
        </div>
        <div>
          <label style={LABEL_STYLE}>{t("teams.boardCardDesc")}</label>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} style={{ ...INPUT_STYLE, resize: "vertical" }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <div>
            <label style={LABEL_STYLE}>状态</label>
            <select value={status} onChange={(e) => setStatus(e.target.value as TeamCardStatus)} style={INPUT_STYLE}>
              {TEAM_CARD_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
          </div>
          <div>
            <label style={LABEL_STYLE}>{t("teams.boardAssignee")}</label>
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={INPUT_STYLE}>
              <option value="">{t("teams.boardUnassigned")}</option>
              {team.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div>
            <label style={LABEL_STYLE}>{t("teams.boardReviewer")}</label>
            <select value={reviewer} onChange={(e) => setReviewer(e.target.value)} style={INPUT_STYLE}>
              <option value="">{t("teams.boardUnassigned")}</option>
              {team.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" disabled={busy} onClick={onClose} style={{ padding: "6px 12px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer" }}>
            {t("common.cancel")}
          </button>
          <button type="submit" disabled={busy} style={{ padding: "6px 14px", fontSize: 12, borderRadius: 6, border: "none", background: "var(--accent, #2563eb)", color: "#fff", cursor: "pointer" }}>
            {t("common.ok")}
          </button>
        </div>
      </form>
    </div>
  );
}

function CardDetailModal({
  team,
  card,
  membersById,
  statusLabel,
  onOpenMemberSession,
  onClose,
  onConflictSync,
  onUpdated,
}: {
  team: Team;
  card: TeamCard;
  membersById: Map<string, TeamMember>;
  statusLabel: (status: TeamCardStatus) => string;
  onOpenMemberSession: (sessionId: string, cwd: string) => void;
  onClose: () => void;
  onConflictSync: (team: Team) => void;
  onUpdated: (team: Team, reviewNotification?: { notified: boolean; reviewerName?: string; error?: string }) => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<TeamCardStatus>(card.status);
  const [assignee, setAssignee] = useState(card.assigneeId ?? "");
  const [reviewer, setReviewer] = useState(card.reviewerId ?? "");
  const [dirtyStatus, setDirtyStatus] = useState(false);
  const [dirtyAssignee, setDirtyAssignee] = useState(false);
  const [dirtyReviewer, setDirtyReviewer] = useState(false);
  const [baseUpdatedAt, setBaseUpdatedAt] = useState(card.updatedAt);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 轮询刷新时同步用户未编辑过的字段，避免仅写备注时覆盖队友刚改的状态或指派。
  useEffect(() => {
    if (!dirtyStatus) setStatus(card.status);
    if (!dirtyAssignee) setAssignee(card.assigneeId ?? "");
    if (!dirtyReviewer) setReviewer(card.reviewerId ?? "");
    if (!dirtyStatus && !dirtyAssignee && !dirtyReviewer) {
      setBaseUpdatedAt(card.updatedAt);
    }
  }, [card.status, card.assigneeId, card.reviewerId, card.updatedAt, dirtyStatus, dirtyAssignee, dirtyReviewer]);

  const assigneeMember = assignee ? membersById.get(assignee) : undefined;
  const reviewerMember = reviewer ? membersById.get(reviewer) : undefined;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmedNote = note.trim();
    const editsFields = dirtyStatus || dirtyAssignee || dirtyReviewer;
    if (!editsFields && !trimmedNote) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        ...(dirtyStatus ? { status } : {}),
        ...(dirtyAssignee ? { assignee: assignee || null } : {}),
        ...(dirtyReviewer ? { reviewer: reviewer || null } : {}),
        ...(trimmedNote ? { note: trimmedNote } : {}),
        ...(editsFields ? { expectedUpdatedAt: baseUpdatedAt } : {}),
      };
      const res = await fetch(`/api/teams/${encodeURIComponent(team.id)}/cards/${encodeURIComponent(card.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({})) as {
        team?: Team;
        card?: TeamCard;
        conflict?: boolean;
        error?: string;
        reviewNotification?: { notified: boolean; reviewerName?: string; error?: string };
      };
      if (res.status === 409 && data.conflict && data.card) {
        if (data.team) onConflictSync(data.team);
        setStatus(data.card.status);
        setAssignee(data.card.assigneeId ?? "");
        setReviewer(data.card.reviewerId ?? "");
        setDirtyStatus(false);
        setDirtyAssignee(false);
        setDirtyReviewer(false);
        setBaseUpdatedAt(data.card.updatedAt);
        setError(data.error ?? "该卡片已被其他成员更新，已刷新为最新状态，请确认后再保存");
        return;
      }
      if (!res.ok || !data.team) throw new Error(data.error ?? `HTTP ${res.status}`);
      onUpdated(data.team, data.reviewNotification);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/teams/${encodeURIComponent(team.id)}/cards/${encodeURIComponent(card.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({})) as { team?: Team; error?: string };
      if (!res.ok || !data.team) throw new Error(data.error ?? `HTTP ${res.status}`);
      onUpdated(data.team);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.42)" }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <form
        onSubmit={(e) => void handleSave(e)}
        style={{ width: 460, maxWidth: "100%", maxHeight: "88vh", overflowY: "auto", padding: 18, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", boxShadow: "0 16px 48px rgba(0,0,0,0.28)", display: "flex", flexDirection: "column", gap: 12 }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 15, color: "var(--text)", lineHeight: 1.4 }}>{card.title}</h3>
          <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>{card.id}</span>
        </div>
        {card.description && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
            {card.description}
          </div>
        )}
        {error && <div style={{ fontSize: 12, color: "#f87171" }}>{error}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <div>
            <label style={LABEL_STYLE}>状态</label>
            <select value={status} onChange={(e) => { setStatus(e.target.value as TeamCardStatus); setDirtyStatus(true); }} style={INPUT_STYLE}>
              {TEAM_CARD_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
          </div>
          <div>
            <label style={LABEL_STYLE}>{t("teams.boardAssignee")}</label>
            <select value={assignee} onChange={(e) => { setAssignee(e.target.value); setDirtyAssignee(true); }} style={INPUT_STYLE}>
              <option value="">{t("teams.boardUnassigned")}</option>
              {team.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div>
            <label style={LABEL_STYLE}>{t("teams.boardReviewer")}</label>
            <select value={reviewer} onChange={(e) => { setReviewer(e.target.value); setDirtyReviewer(true); }} style={INPUT_STYLE}>
              <option value="">{t("teams.boardUnassigned")}</option>
              {team.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>
        {(assigneeMember || reviewerMember) && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {assigneeMember && (
              <button
                type="button"
                onClick={() => {
                  onOpenMemberSession(assigneeMember.sessionId, assigneeMember.cwd);
                  onClose();
                }}
                style={{ padding: "4px 8px", fontSize: 11, borderRadius: 5, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
              >
                {t("teams.boardOpenChat")}: {assigneeMember.name}
              </button>
            )}
            {reviewerMember && reviewerMember.id !== assigneeMember?.id && (
              <button
                type="button"
                onClick={() => {
                  onOpenMemberSession(reviewerMember.sessionId, reviewerMember.cwd);
                  onClose();
                }}
                style={{ padding: "4px 8px", fontSize: 11, borderRadius: 5, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
              >
                {t("teams.boardOpenChat")}: {reviewerMember.name}
              </button>
            )}
          </div>
        )}
        <div>
          <label style={LABEL_STYLE}>{t("teams.boardNote")}</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} style={INPUT_STYLE} placeholder={t("teams.boardNotePlaceholder")} />
        </div>
        {card.notes.length > 0 && (
          <div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 6 }}>{t("teams.boardHistory")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 160, overflowY: "auto" }}>
              {[...card.notes].reverse().map((item, idx) => {
                const actor = item.by === "user" ? "用户" : (membersById.get(item.by)?.name ?? item.by);
                return (
                  <div key={`${item.at}-${idx}`} style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4 }}>
                    <span style={{ color: "var(--text-dim)" }}>{formatRelativeTime(item.at)}</span>
                    {" · "}
                    <span style={{ color: "var(--text)" }}>{actor}</span>
                    {item.status ? ` → ${statusLabel(item.status)}` : ""}
                    {item.text ? `：${item.text}` : ""}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
          <button type="button" disabled={busy} onClick={() => void handleDelete()} style={{ padding: "6px 10px", fontSize: 12, borderRadius: 6, border: "none", background: "transparent", color: "#ef4444", cursor: "pointer" }}>
            删除
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" disabled={busy} onClick={onClose} style={{ padding: "6px 12px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer" }}>
              {t("common.cancel")}
            </button>
            <button type="submit" disabled={busy} style={{ padding: "6px 14px", fontSize: 12, borderRadius: 6, border: "none", background: "var(--accent, #2563eb)", color: "#fff", cursor: "pointer" }}>
              {t("common.ok")}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
