import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withPrivateFileLock, writePrivateFileAtomicSync } from "./atomic-file";
import {
  TEAM_CARD_STATUSES,
  type Team,
  type TeamCard,
  type TeamCardStatus,
  type TeamMember,
  type TeamMemberRole,
} from "./team-types";

/**
 * 团队存储：`<agentDir>/pi-web-teams.json`。
 *
 * 每次修改都在 withPrivateFileLock() 下读改写，leader 的工具、各成员的轮次结束记录和浏览器
 * 可能同时改同一个团队。文件损坏时另存 `.corrupt-*` 并从空开始，避免整个功能卡死。
 */

export const MAX_TEAMS = 50;
export const MAX_MEMBERS_PER_TEAM = 20;
export const MAX_CARDS_PER_TEAM = 200;
export const MAX_NOTES_PER_CARD = 20;
export const MAX_PROMPT_LENGTH = 8_000;
export const MAX_TITLE_LENGTH = 120;
export const MAX_NOTE_LENGTH = 2_000;
const MEMBER_NAME_PATTERN = /^[\p{L}\p{N}_-]{1,32}$/u;

interface StoreFile {
  version: 1;
  teams: Team[];
  committedRebuildSessions?: string[];
}

export function getTeamsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web-teams.json");
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function isMember(value: unknown): value is TeamMember {
  const member = value as TeamMember;
  return Boolean(member) && typeof member === "object"
    && typeof member.id === "string" && typeof member.sessionId === "string"
    && typeof member.name === "string" && (member.role === "leader" || member.role === "member")
    && typeof member.cwd === "string";
}

function isTeam(value: unknown): value is Team {
  const team = value as Team;
  return Boolean(team) && typeof team === "object"
    && typeof team.id === "string" && typeof team.name === "string"
    && Array.isArray(team.members) && Array.isArray(team.cards);
}

function normalizeTeam(team: Team): Team {
  return {
    ...team,
    prompt: typeof team.prompt === "string" ? team.prompt : "",
    members: team.members.filter(isMember).map((member) => ({
      ...member,
      title: typeof member.title === "string" ? member.title : "",
      prompt: typeof member.prompt === "string" ? member.prompt : "",
    })),
    cards: team.cards.filter((card) => card && typeof card.id === "string" && typeof card.title === "string")
      .map((card) => ({
        ...card,
        description: typeof card.description === "string" ? card.description : "",
        status: (TEAM_CARD_STATUSES as readonly string[]).includes(card.status) ? card.status : "todo",
        notes: Array.isArray(card.notes) ? card.notes : [],
      })),
  };
}

function readTeamStore(path: string, recoverOnCorrupt = false): StoreFile {
  const empty: StoreFile = { version: 1, teams: [] };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreFile>;
    if (!Array.isArray(parsed?.teams)) throw new Error("teams is not an array");
    const committedRebuildSessions = Array.isArray(parsed.committedRebuildSessions)
      ? parsed.committedRebuildSessions.filter((id) => typeof id === "string")
      : undefined;
    return { version: 1, teams: parsed.teams.filter(isTeam).map(normalizeTeam), committedRebuildSessions };
  } catch (error) {
    // 只读路径绝不写盘，避免在锁外覆盖另一进程刚写好的数据；仅持锁修改路径确认仍损坏时才另存并重置。
    if (!recoverOnCorrupt) {
      console.warn("[pi-web] 团队存储无法读取:", error instanceof Error ? error.message : error);
      return empty;
    }
    console.warn("[pi-web] 团队存储无法读取，另存后从空开始:", error instanceof Error ? error.message : error);
    try {
      writePrivateFileAtomicSync(`${path}.corrupt-${Date.now()}`, readFileSync(path, "utf8"));
      writePrivateFileAtomicSync(path, JSON.stringify(empty, null, 2));
    } catch (backupError) {
      console.warn("[pi-web] 团队存储备份失败:", backupError instanceof Error ? backupError.message : backupError);
    }
    return empty;
  }
}

function readTeams(path: string): Team[] {
  return readTeamStore(path).teams;
}

export function readCommittedTeamRebuildSessions(path = getTeamsPath()): Set<string> {
  return new Set(readTeamStore(path).committedRebuildSessions);
}

function writeTeams(path: string, store: StoreFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify(store, null, 2));
}

async function mutate<T>(
  operation: (teams: Team[]) => {
    teams: Team[];
    result: T;
    rebuiltLeaderSessionId?: string;
    aroundWrite?: (commitTeams: () => void) => void | Promise<void>;
  },
  path: string,
): Promise<T> {
  return withPrivateFileLock(path, async () => {
    const previous = readTeamStore(path, true);
    const { teams, result, aroundWrite, rebuiltLeaderSessionId } = operation(previous.teams);
    // 与团队同一次落盘。之后 leader 转为普通会话时仍能凭原提交授权。
    let committedRebuildSessions = previous.committedRebuildSessions;
    if (rebuiltLeaderSessionId && !committedRebuildSessions?.includes(rebuiltLeaderSessionId)) {
      committedRebuildSessions = [...(committedRebuildSessions ?? []), rebuiltLeaderSessionId];
    }
    const commitTeams = () => writeTeams(path, { ...previous, teams, committedRebuildSessions });
    if (aroundWrite) {
      await aroundWrite(commitTeams);
    } else {
      commitTeams();
    }
    return result;
  });
}

/** 在锁内修改一个团队；找不到就报错。 */
/** 持锁推进卡片版本时间戳，保证每次修改都严格递增，避免同毫秒连续写入跳过乐观锁检查。 */
function nextCardUpdatedAt(currentUpdatedAt: number, now: number): number {
  return now > currentUpdatedAt ? now : currentUpdatedAt + 1;
}

async function mutateTeam<T>(
  teamId: string,
  operation: (team: Team, now: number) => {
    team: Team;
    result: T;
    rebuiltLeaderSessionId?: string;
    aroundWrite?: (commitTeams: () => void) => void | Promise<void>;
  },
  path: string,
  now?: number,
): Promise<T> {
  return mutate((teams) => {
    const index = teams.findIndex((team) => team.id === teamId);
    if (index < 0) throw new Error(`团队 ${teamId} 不存在`);
    // 团队编辑用这个版本核对成员基线，同毫秒的连续操作也必须让旧编辑失效。
    const ts = Math.max(now ?? Date.now(), teams[index].updatedAt + 1);
    const { team, result, aroundWrite, rebuiltLeaderSessionId } = operation(teams[index], ts);
    const next = [...teams];
    next[index] = { ...team, updatedAt: ts };
    return { teams: next, result, aroundWrite, rebuiltLeaderSessionId };
  }, path);
}

export function listTeams(path = getTeamsPath()): Team[] {
  return readTeams(path).sort((a, b) => a.createdAt - b.createdAt);
}

export function getTeam(teamId: string, path = getTeamsPath()): Team | undefined {
  return readTeams(path).find((team) => team.id === teamId);
}

export interface TeamMembership {
  team: Team;
  member: TeamMember;
}

export function findMembershipBySession(sessionId: string, path = getTeamsPath()): TeamMembership | undefined {
  for (const team of readTeams(path)) {
    const member = team.members.find((candidate) => candidate.sessionId === sessionId);
    if (member) return { team, member };
  }
  return undefined;
}

/** 按名字（不区分大小写）或 id 找成员。 */
export function resolveMember(team: Team, nameOrId: string): TeamMember | undefined {
  const key = nameOrId.trim().toLowerCase();
  return team.members.find((member) => member.id === nameOrId || member.name.toLowerCase() === key);
}

function checkText(label: string, value: unknown, max: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label}不能为空`);
    return "";
  }
  if (typeof value !== "string") throw new Error(`${label}必须是字符串`);
  const text = value.trim();
  if (required && !text) throw new Error(`${label}不能为空`);
  if (text.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
  return text;
}

function checkMemberName(team: Team | undefined, name: unknown, exceptId?: string): string {
  if (typeof name !== "string" || !MEMBER_NAME_PATTERN.test(name.trim())) {
    throw new Error("成员名字只能包含文字、数字、- 和 _，长度 1–32");
  }
  const value = name.trim();
  if (value.toLowerCase() === "all" || value.toLowerCase() === "user") throw new Error(`成员名字不能是保留字 ${value}`);
  if (team?.members.some((member) => member.id !== exceptId && member.name.toLowerCase() === value.toLowerCase())) {
    throw new Error(`团队里已有名为 ${value} 的成员`);
  }
  return value;
}

export interface TeamMemberInput {
  sessionId: string;
  name: string;
  title?: string;
  prompt?: string;
  cwd: string;
}

function buildMember(team: Team | undefined, input: TeamMemberInput, role: TeamMemberRole, now: number): TeamMember {
  if (!input.sessionId) throw new Error("sessionId 不能为空");
  if (!input.cwd) throw new Error("cwd 不能为空");
  return {
    id: newId("m"),
    sessionId: input.sessionId,
    name: checkMemberName(team, input.name),
    role,
    title: checkText("职位", input.title, MAX_TITLE_LENGTH),
    prompt: checkText("人员定义", input.prompt, MAX_PROMPT_LENGTH),
    cwd: input.cwd,
    createdAt: now,
  };
}

/** 名字与职位只做校验，不落盘；建会话之前先调用，避免留下无主会话。 */
export function validateMemberDraft(teamId: string | undefined, input: { name: unknown; title?: unknown; prompt?: unknown }, path = getTeamsPath()): void {
  const team = teamId ? getTeam(teamId, path) : undefined;
  if (teamId && !team) throw new Error(`团队 ${teamId} 不存在`);
  if (team && team.members.length >= MAX_MEMBERS_PER_TEAM) throw new Error(`每个团队最多 ${MAX_MEMBERS_PER_TEAM} 名成员`);
  checkMemberName(team, input.name);
  checkText("职位", input.title, MAX_TITLE_LENGTH);
  checkText("人员定义", input.prompt, MAX_PROMPT_LENGTH);
}

/** 创建团队前的预检：在落盘 leader 会话前校验团队名、定义、上限与 leader 信息，避免留下孤立会话。 */
export function validateTeamDraft(
  input: { name: unknown; prompt?: unknown; leader: { name: unknown; title?: unknown; prompt?: unknown } },
  path = getTeamsPath(),
): void {
  checkText("团队名", input.name, MAX_TITLE_LENGTH, true);
  checkText("团队定义", input.prompt, MAX_PROMPT_LENGTH);
  if (readTeams(path).length >= MAX_TEAMS) throw new Error(`最多 ${MAX_TEAMS} 个团队`);
  validateMemberDraft(undefined, input.leader, path);
}

export async function createTeam(
  input: { name: string; prompt?: string; leader: TeamMemberInput },
  now = Date.now(),
  path = getTeamsPath(),
): Promise<Team> {
  const name = checkText("团队名", input.name, MAX_TITLE_LENGTH, true);
  const prompt = checkText("团队定义", input.prompt, MAX_PROMPT_LENGTH);
  return mutate((teams) => {
    if (teams.length >= MAX_TEAMS) throw new Error(`最多 ${MAX_TEAMS} 个团队`);
    const team: Team = { id: newId("team"), name, prompt, members: [], cards: [], createdAt: now, updatedAt: now };
    team.members.push(buildMember(team, input.leader, "leader", now));
    return { teams: [...teams, team], result: team };
  }, path);
}

export async function updateTeam(teamId: string, patch: { name?: string; prompt?: string }, now = Date.now(), path = getTeamsPath()): Promise<Team> {
  return mutateTeam(teamId, (team) => {
    const next = {
      ...team,
      ...(patch.name !== undefined ? { name: checkText("团队名", patch.name, MAX_TITLE_LENGTH, true) } : {}),
      ...(patch.prompt !== undefined ? { prompt: checkText("团队定义", patch.prompt, MAX_PROMPT_LENGTH) } : {}),
    };
    return { team: next, result: next };
  }, path, now);
}

export class TeamEditConflictError extends Error {
  constructor() {
    super("团队已发生变化，请关闭编辑窗口后重新打开，核对最新成员与配置");
    this.name = "TeamEditConflictError";
  }
}

/** 在同一把团队文件锁内替换成员，保留团队身份与看板，清除指向旧成员的指派。 */
export async function rebuildTeam(
  teamId: string,
  input: { name: string; prompt?: string; leader: TeamMemberInput; expectedUpdatedAt: number },
  path = getTeamsPath(),
  options?: { aroundSave: (previous: Team, commitTeams: () => void) => void | Promise<void> },
): Promise<Team> {
  return mutateTeam(teamId, (previous, now) => {
    if (previous.updatedAt !== input.expectedUpdatedAt) throw new TeamEditConflictError();
    const team: Team = {
      ...previous,
      name: checkText("团队名", input.name, MAX_TITLE_LENGTH, true),
      prompt: checkText("团队定义", input.prompt, MAX_PROMPT_LENGTH),
      members: [buildMember(undefined, input.leader, "leader", now)],
      cards: previous.cards.map((card) => ({
        ...card,
        assigneeId: undefined,
        reviewerId: undefined,
        updatedAt: nextCardUpdatedAt(card.updatedAt, now),
      })),
      updatedAt: now,
    };
    return {
      team,
      result: team,
      rebuiltLeaderSessionId: team.members[0].sessionId,
      ...(options ? { aroundWrite: (commitTeams: () => void) => options.aroundSave(previous, commitTeams) } : {}),
    };
  }, path);
}

/** 只删除团队记录；成员会话保留为普通会话。 */
export async function deleteTeam(
  teamId: string,
  path = getTeamsPath(),
  options?: { aroundDelete?: (deleted: Team, commitTeams: () => void) => void | Promise<void> },
): Promise<Team | undefined> {
  return mutate((teams) => {
    const team = teams.find((candidate) => candidate.id === teamId);
    return {
      teams: teams.filter((candidate) => candidate.id !== teamId),
      result: team,
      ...(team && options?.aroundDelete
        ? { aroundWrite: (commitTeams: () => void) => options.aroundDelete!(team, commitTeams) }
        : {}),
    };
  }, path);
}

export async function addTeamMember(teamId: string, input: TeamMemberInput, now = Date.now(), path = getTeamsPath()): Promise<TeamMember> {
  return mutateTeam(teamId, (team) => {
    if (team.members.length >= MAX_MEMBERS_PER_TEAM) throw new Error(`每个团队最多 ${MAX_MEMBERS_PER_TEAM} 名成员`);
    const member = buildMember(team, input, "member", now);
    return { team: { ...team, members: [...team.members, member] }, result: member };
  }, path, now);
}

export async function updateTeamMember(
  teamId: string,
  memberId: string,
  patch: { name?: string; title?: string; prompt?: string },
  now?: number,
  path = getTeamsPath(),
  options?: { aroundSave?: (updated: TeamMember, previous: TeamMember, commitTeams: () => void) => void | Promise<void> },
): Promise<TeamMember> {
  return mutateTeam(teamId, (team) => {
    const current = team.members.find((member) => member.id === memberId);
    if (!current) throw new Error(`成员 ${memberId} 不存在`);
    const member: TeamMember = {
      ...current,
      ...(patch.name !== undefined ? { name: checkMemberName(team, patch.name, memberId) } : {}),
      ...(patch.title !== undefined ? { title: checkText("职位", patch.title, MAX_TITLE_LENGTH) } : {}),
      ...(patch.prompt !== undefined ? { prompt: checkText("人员定义", patch.prompt, MAX_PROMPT_LENGTH) } : {}),
    };
    return {
      team: { ...team, members: team.members.map((item) => item.id === memberId ? member : item) },
      result: member,
      ...(options?.aroundSave
        ? { aroundWrite: (commitTeams: () => void) => options.aroundSave!(member, current, commitTeams) }
        : {}),
    };
  }, path, now);
}

/** 把成员移出团队（会话保留）；leader 不能移除，他负责的卡片改为未分配。 */
export async function removeTeamMember(
  teamId: string,
  memberId: string,
  now?: number,
  path = getTeamsPath(),
  options?: { aroundSave?: (removed: TeamMember, commitTeams: () => void) => void | Promise<void> },
): Promise<TeamMember> {
  return mutateTeam(teamId, (team, ts) => {
    const member = team.members.find((item) => item.id === memberId);
    if (!member) throw new Error(`成员 ${memberId} 不存在`);
    if (member.role === "leader") throw new Error("leader 不能被移出团队");
    const cards = team.cards.map((card) => {
      const clearsAssignee = card.assigneeId === memberId;
      const clearsReviewer = card.reviewerId === memberId;
      if (!clearsAssignee && !clearsReviewer) return card;
      return {
        ...card,
        ...(clearsAssignee ? { assigneeId: undefined } : {}),
        ...(clearsReviewer ? { reviewerId: undefined } : {}),
        updatedAt: nextCardUpdatedAt(card.updatedAt, ts),
      };
    });
    return {
      team: { ...team, members: team.members.filter((item) => item.id !== memberId), cards },
      result: member,
      ...(options?.aroundSave
        ? { aroundWrite: (commitTeams: () => void) => options.aroundSave!(member, commitTeams) }
        : {}),
    };
  }, path, now);
}

/** 每轮结束由团队扩展自动调用，看板上的“成员状态”因此不依赖 AI 自觉更新。 */
export async function recordMemberActivity(sessionId: string, summary: string, now = Date.now(), path = getTeamsPath()): Promise<boolean> {
  return mutate((teams) => {
    let found = false;
    const next = teams.map((team) => {
      if (!team.members.some((member) => member.sessionId === sessionId)) return team;
      found = true;
      return {
        ...team,
        members: team.members.map((member) => member.sessionId === sessionId
          ? { ...member, lastActivity: { at: now, summary: summary.slice(0, 200) } }
          : member),
      };
    });
    return { teams: next, result: found };
  }, path);
}

function checkStatus(value: unknown): TeamCardStatus {
  if (!(TEAM_CARD_STATUSES as readonly unknown[]).includes(value)) {
    throw new Error(`状态必须是 ${TEAM_CARD_STATUSES.join(" / ")} 之一`);
  }
  return value as TeamCardStatus;
}

function checkMemberRef(team: Team, ref: string | null | undefined, label: string): string | undefined {
  if (ref === undefined || ref === null || ref === "") return undefined;
  const member = resolveMember(team, ref);
  if (!member) throw new Error(`${label} ${ref} 不在团队里`);
  return member.id;
}

function appendNote(card: TeamCard, note: TeamCard["notes"][number]): TeamCard["notes"] {
  return [...card.notes, note].slice(-MAX_NOTES_PER_CARD);
}

export interface CardCreateInput {
  title: string;
  description?: string;
  status?: TeamCardStatus;
  assignee?: string;
  reviewer?: string;
}

export async function createTeamCard(teamId: string, input: CardCreateInput, actorId: string, now = Date.now(), path = getTeamsPath()): Promise<TeamCard> {
  return mutateTeam(teamId, (team) => {
    if (team.cards.length >= MAX_CARDS_PER_TEAM) throw new Error(`每个团队最多 ${MAX_CARDS_PER_TEAM} 张卡片`);
    const status = input.status === undefined ? "todo" : checkStatus(input.status);
    const card: TeamCard = {
      id: newId("c"),
      title: checkText("标题", input.title, MAX_TITLE_LENGTH, true),
      description: checkText("描述", input.description, MAX_NOTE_LENGTH),
      status,
      assigneeId: checkMemberRef(team, input.assignee, "负责人"),
      reviewerId: checkMemberRef(team, input.reviewer, "审核人"),
      notes: [{ at: now, by: actorId, text: "创建", status }],
      createdAt: now,
      updatedAt: now,
    };
    return { team: { ...team, cards: [...team.cards, card] }, result: card };
  }, path, now);
}

export class TeamCardConflictError extends Error {
  readonly card: TeamCard;

  constructor(card: TeamCard) {
    super("该卡片已被其他成员更新，请核对最新内容后再保存");
    this.name = "TeamCardConflictError";
    this.card = card;
  }
}

export interface CardUpdateInput {
  title?: string;
  description?: string;
  status?: TeamCardStatus;
  note?: string;
  /** null 清空负责人。 */
  assignee?: string | null;
  reviewer?: string | null;
  /** 乐观并发控制：用户编辑卡片字段时传入打开时的 updatedAt，若已被他人改写则拒绝覆盖。 */
  expectedUpdatedAt?: number;
}

export interface CardUpdateResult {
  card: TeamCard;
  previousStatus: TeamCardStatus;
}

/**
 * 更新卡片。权限：leader（或 actorId 为 "user"）可改一切；
 * 普通成员只能改自己负责的卡片的状态与进度，不能改标题、指派。
 */
export async function updateTeamCard(
  teamId: string,
  cardId: string,
  input: CardUpdateInput,
  actorId: string,
  now?: number,
  path = getTeamsPath(),
): Promise<CardUpdateResult> {
  return mutateTeam(teamId, (team, ts) => {
    const current = team.cards.find((card) => card.id === cardId);
    if (!current) throw new Error(`卡片 ${cardId} 不存在`);
    const actor = team.members.find((member) => member.id === actorId);
    const privileged = actorId === "user" || actor?.role === "leader";
    if (!privileged) {
      if (!actor) throw new Error("只有团队成员能更新看板");
      // 审核人也要能把卡片退回或标记完成。
      if (current.assigneeId !== actorId && current.reviewerId !== actorId) {
        throw new Error("只能更新自己负责或审核的卡片");
      }
      if (input.title !== undefined || input.description !== undefined || input.assignee !== undefined || input.reviewer !== undefined) {
        throw new Error("只有 leader 能修改标题、描述和指派");
      }
    }
    const editsFields = input.title !== undefined
      || input.description !== undefined
      || input.status !== undefined
      || input.assignee !== undefined
      || input.reviewer !== undefined;
    if (editsFields && input.expectedUpdatedAt !== undefined && current.updatedAt !== input.expectedUpdatedAt) {
      throw new TeamCardConflictError(current);
    }
    const status = input.status === undefined ? current.status : checkStatus(input.status);
    const noteText = checkText("进度说明", input.note, MAX_NOTE_LENGTH);
    let card: TeamCard = {
      ...current,
      ...(input.title !== undefined ? { title: checkText("标题", input.title, MAX_TITLE_LENGTH, true) } : {}),
      ...(input.description !== undefined ? { description: checkText("描述", input.description, MAX_NOTE_LENGTH) } : {}),
      ...(input.assignee !== undefined ? { assigneeId: checkMemberRef(team, input.assignee, "负责人") } : {}),
      ...(input.reviewer !== undefined ? { reviewerId: checkMemberRef(team, input.reviewer, "审核人") } : {}),
      status,
      updatedAt: nextCardUpdatedAt(current.updatedAt, ts),
    };
    if (noteText || status !== current.status) {
      card = { ...card, notes: appendNote(card, { at: ts, by: actorId, text: noteText, ...(status !== current.status ? { status } : {}) }) };
    }
    return {
      team: { ...team, cards: team.cards.map((item) => item.id === cardId ? card : item) },
      result: { card, previousStatus: current.status },
    };
  }, path, now);
}

export async function deleteTeamCard(teamId: string, cardId: string, now = Date.now(), path = getTeamsPath()): Promise<void> {
  await mutateTeam(teamId, (team) => {
    if (!team.cards.some((card) => card.id === cardId)) throw new Error(`卡片 ${cardId} 不存在`);
    return { team: { ...team, cards: team.cards.filter((card) => card.id !== cardId) }, result: undefined };
  }, path, now);
}
