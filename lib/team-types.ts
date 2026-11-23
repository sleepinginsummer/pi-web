/**
 * 团队（多 bot 协作）的共享类型，浏览器与服务端共用，不能引入 node 模块。
 *
 * 一个团队 = 一个 leader + 若干成员；每个成员对应一个普通 pi 会话（独立的 cwd、模型、思考强度）。
 * 团队记录只保存成员与会话的对应关系、提示词和看板，会话内容仍在各自的 .jsonl 里。
 */

export type TeamMemberRole = "leader" | "member";

export interface TeamMemberActivity {
  /** 最近一轮结束的时间（毫秒）。 */
  at: number;
  /** 最近一次回复的第一句话，系统在每轮结束时自动写入。 */
  summary: string;
}

export interface TeamMember {
  id: string;
  /** 对应的 pi 会话 id。 */
  sessionId: string;
  /** 团队内唯一，`team_send` 用它寻址。 */
  name: string;
  role: TeamMemberRole;
  /** 职位，例如“开发”“审核”。 */
  title: string;
  /** 人员定义提示词。 */
  prompt: string;
  cwd: string;
  createdAt: number;
  lastActivity?: TeamMemberActivity;
}

export const TEAM_CARD_STATUSES = ["todo", "doing", "review", "done", "blocked"] as const;
export type TeamCardStatus = (typeof TEAM_CARD_STATUSES)[number];

export interface TeamCardNote {
  at: number;
  /** 写下进度的成员 id；用户在界面上的操作为 "user"。 */
  by: string;
  text: string;
  /** 这条记录把卡片改成的状态。 */
  status?: TeamCardStatus;
}

export interface TeamCard {
  id: string;
  title: string;
  description: string;
  status: TeamCardStatus;
  /** 负责人成员 id。 */
  assigneeId?: string;
  /** 审核人成员 id；卡片进入 review 时系统会通知他。 */
  reviewerId?: string;
  notes: TeamCardNote[];
  createdAt: number;
  updatedAt: number;
}

export interface Team {
  id: string;
  name: string;
  /** 团队定义提示词：目标、协作规则。 */
  prompt: string;
  members: TeamMember[];
  cards: TeamCard[];
  createdAt: number;
  updatedAt: number;
}

/** 团队成员会话里记录归属的自定义条目类型。 */
export const TEAM_MEMBER_ENTRY_TYPE = "pi-web:team-member";
