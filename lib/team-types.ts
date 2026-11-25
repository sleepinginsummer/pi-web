/**
 * 团队（多 bot 协作）的共享类型，浏览器与服务端共用，不能引入 node 模块。
 *
 * 一个团队 = 一个 leader + 若干成员；每个成员对应一个普通 pi 会话（独立的 cwd、模型、思考强度）。
 * 团队记录只保存成员与会话的对应关系、提示词和看板，会话内容仍在各自的 .jsonl 里。
 */

/** 新团队的 Leader 默认职责；创建表单可修改或清空，已有团队保持原提示词。 */
export const DEFAULT_TEAM_LEADER_PROMPT = `你是团队负责人，负责推动团队完成用户目标，并对最终交付质量负责。

1. 先理解目标、约束和验收标准，检查现有资料；能自行查证的先查证，关键需求不明确时再向用户确认。
2. 将目标拆成有明确产出和验收标准的任务，梳理依赖，用看板记录，并为任务指定负责人和审核人。
3. 按实际需要创建成员，优先复用合适的角色预设，明确每个人的职责、工作目录和协作边界，避免多人同时修改同一部分。
4. 使用团队消息下达具体任务、协调依赖和处理阻塞。只在有新进展、问题或结论时沟通，避免空回复和反复催促。
5. 跟踪看板与成员产出，发现问题及时调整分工。提交审核后核对实现、测试与验收结果，未经验证不要标记完成。
6. 向用户汇报已完成内容、验证结果和未解决的问题，清楚说明风险与需要用户决定的事项，不夸大进度。`;

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
