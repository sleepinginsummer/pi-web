import { Type } from "typebox";
import { getCurrentSystemMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  appendSystemPromptAddon,
  ensureTeamMemberRolePromptAddonLocked,
  readSessionSystemPromptAddon,
} from "./system-prompt-addon";
import {
  getMemberRuntimeStatus,
  notifyCardReviewer,
  provisionTeamMember,
  removeTeamMemberWithCleanup,
  sendTeamMessage,
  updateTeamMemberWithPrompt,
} from "./team-runtime";
import {
  createTeamRolePreset,
  deleteTeamRolePreset,
  getTeamRolePreset,
  listTeamRolePresets,
  updateTeamRolePreset,
  type TeamRolePreset,
} from "./team-role-presets";
import {
  TEAM_CARD_STATUSES,
  type Team,
  type TeamCard,
  type TeamCardStatus,
  type TeamMember,
} from "./team-types";
import {
  createTeamCard,
  deleteTeamCard,
  findMembershipBySession,
  getTeam,
  recordMemberActivity,
  resolveMember,
  updateTeamCard,
} from "./teams";
import { isThinkingLevel } from "./thinking-levels";
import { TEAM_MESSAGE_TYPE } from "./wake-message-types";

export const HOST_TEAM_EXTENSION_NAME = "pi-web-team";
export const TEAM_MEMBER_TOOL_NAMES = ["team_list", "team_send", "board_list", "board_update"] as const;
export const TEAM_LEADER_TOOL_NAMES = [
  "team_member_create",
  "team_member_update",
  "team_member_remove",
  "team_role_preset_list",
  "team_role_preset_create",
  "team_role_preset_update",
  "team_role_preset_delete",
  "board_create",
  "board_delete",
] as const;

function text(content: string, isError = false) {
  return {
    content: [{ type: "text" as const, text: content }],
    details: undefined,
    ...(isError ? { isError: true } : {}),
  };
}

const STATUS_LABELS: Record<TeamCardStatus, string> = {
  todo: "待办",
  doing: "进行中",
  review: "待审核",
  done: "已完成",
  blocked: "阻塞",
};

function memberNameById(team: Team, id?: string): string {
  if (!id) return "未分配";
  if (id === "user") return "用户";
  return team.members.find((member) => member.id === id)?.name ?? id;
}

export function formatTeamRoster(team: Team, selfId?: string): string {
  return team.members.map((member) => {
    const roleTag = member.role === "leader" ? "Leader" : (member.title || "成员");
    const selfTag = member.id === selfId ? "（你）" : "";
    const status = getMemberRuntimeStatus(member.sessionId) === "running" ? "运行中" : "空闲";
    const last = member.lastActivity?.summary ? ` · 最近：${member.lastActivity.summary}` : "";
    return `- ${member.name}${selfTag} [${roleTag}] · ${status} · 目录：${member.cwd}${last}`;
  }).join("\n");
}

export function formatBoard(team: Team, filterStatus?: TeamCardStatus): string {
  const cards = filterStatus ? team.cards.filter((card) => card.status === filterStatus) : team.cards;
  if (cards.length === 0) {
    return filterStatus ? `看板「${STATUS_LABELS[filterStatus]}」列为空。` : "看板暂无任务卡片。";
  }
  const byStatus = new Map<TeamCardStatus, TeamCard[]>();
  for (const status of TEAM_CARD_STATUSES) byStatus.set(status, []);
  for (const card of cards) byStatus.get(card.status)?.push(card);

  const sections: string[] = [];
  for (const status of TEAM_CARD_STATUSES) {
    const group = byStatus.get(status) ?? [];
    if (group.length === 0) continue;
    const lines = group.map((card) => {
      const assignee = memberNameById(team, card.assigneeId);
      const reviewer = card.reviewerId ? ` → 审核：${memberNameById(team, card.reviewerId)}` : "";
      const lastNote = card.notes[card.notes.length - 1];
      const note = lastNote?.text ? ` · 最新进度：${lastNote.text}` : "";
      const desc = card.description ? `\n    说明：${card.description}` : "";
      return `  - [${card.id}] ${card.title}（负责：${assignee}${reviewer}）${note}${desc}`;
    });
    sections.push(`## ${STATUS_LABELS[status]} (${group.length})\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

/** 拼装注入到系统提示词 <team> 段的文本：团队定义 + 人员定义 + 实时成员名单 + 协作规则。 */
export function buildTeamPromptSection(
  team: Team,
  member: TeamMember,
  options?: { memberPromptOverride?: string | null; rolePresets?: readonly TeamRolePreset[] },
): string {
  const parts: string[] = [
    `你属于团队「${team.name}」。`,
    `你的身份：${member.name}（${member.role === "leader" ? "Leader" : (member.title || "成员")}），工作目录：${member.cwd}。`,
  ];
  if (team.prompt.trim()) {
    parts.push(`\n### 团队定义\n${team.prompt.trim()}`);
  }
  const rolePrompt = options?.memberPromptOverride === undefined
    ? member.prompt.trim()
    : (options.memberPromptOverride ?? "").trim();
  if (rolePrompt) {
    parts.push(`\n### 你的职责定义\n${rolePrompt}`);
  }
  const roster = team.members.map((item) => {
    const roleTag = item.role === "leader" ? "Leader" : (item.title || "成员");
    const selfTag = item.id === member.id ? "（你）" : "";
    return `- ${item.name}${selfTag} [${roleTag}] · cwd: ${item.cwd}`;
  }).join("\n");
  parts.push(`\n### 当前团队成员\n${roster}`);
  const rules = [
    "协作规则：",
    "1. 需要与队友沟通时使用 team_send；只在有实际产出、明确问题或审核结论时发送，不要发“收到”“好的”等空回复，以免陷入循环。",
    "2. 开始、推进、提交审核或遇到阻塞时，务必用 board_update 及时更新看板进度；将卡片状态设为 review 且已指定审核人时，系统会自动通知审核人。",
    ...(member.role === "leader"
      ? [
        "3. 作为 Leader，你可以使用 team_member_create / team_member_update / team_member_remove 管理成员（添加成员时可传 preset 套用预设角色，或自定义新角色），使用 team_role_preset_list / team_role_preset_create / team_role_preset_update / team_role_preset_delete 管理全局预设角色，并使用 board_create / board_update / board_delete 维护看板。",
        ...(options?.rolePresets && options.rolePresets.length > 0
          ? [`4. 当前可用角色预设：${options.rolePresets.map((p) => p.name).join("、")}（调用 team_role_preset_list 可查看各预设完整提示词）。`]
          : []),
      ]
      : ["3. 你可以用 team_list 查看队友、用 board_list 查看看板、用 board_update 更新自己负责或审核的卡片。"]),
  ];
  parts.push(`\n${rules.join("\n")}`);
  return parts.join("\n");
}

/** 从本轮消息里提取助手最后一条回复的第一行，作为看板成员状态的自动摘要。 */
export function extractTurnSummary(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant") continue;
    const raw = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .map((block: { type?: string; text?: string }) => (block?.type === "text" ? block.text ?? "" : ""))
            .join("\n")
        : "";
    const firstLine = raw
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (firstLine) return firstLine.slice(0, 160);
  }
  return "";
}

/** 从当前分支尾部找出触发本轮的消息跳数；人类用户发起归零。 */
export function readCurrentTurnHop(branch: readonly unknown[]): number {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i] as {
      type?: string;
      customType?: string;
      details?: { hop?: unknown };
      message?: { role?: string };
    } | undefined;
    if (!entry) continue;
    if (entry.type === "message" && entry.message?.role === "user") return 0;
    if (entry.type === "custom_message" && entry.customType === TEAM_MESSAGE_TYPE) {
      const hop = Number(entry.details?.hop);
      return Number.isFinite(hop) && hop > 0 ? hop : 1;
    }
  }
  return 0;
}

const cardStatusSchema = Type.Union([
  Type.Literal("todo"),
  Type.Literal("doing"),
  Type.Literal("review"),
  Type.Literal("done"),
  Type.Literal("blocked"),
]);

export function createTeamExtension(options: {
  sessionId: string;
  hasSystemPromptAddonExtension?: () => boolean;
}): InlineExtension {
  return {
    name: HOST_TEAM_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      const initialMembership = findMembershipBySession(options.sessionId);
      if (!initialMembership) return;

      const requireMembership = (sessionId: string) => {
        const membership = findMembershipBySession(sessionId);
        if (!membership) throw new Error("当前会话已不再属于任何团队。");
        return membership;
      };

      const requireLeader = (sessionId: string) => {
        const membership = requireMembership(sessionId);
        if (membership.member.role !== "leader") {
          throw new Error("只有团队 Leader 才能执行该操作。");
        }
        return membership;
      };

      // 每轮开始前注入动态团队上下文（团队目标、成员名单、协作规则）；成员角色提示词统一走补充提示词快照，不写入 JSONL。
      pi.on("before_agent_start", async (event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const membership = findMembershipBySession(sessionId);
        if (!membership) return;
        if (membership.member.prompt.trim()) {
          await ensureTeamMemberRolePromptAddonLocked(
            sessionId,
            () => findMembershipBySession(sessionId)?.member.prompt ?? null,
          );
        }
        event.systemPromptOptions.sections["team"] = buildTeamPromptSection(
          membership.team,
          membership.member,
          {
            memberPromptOverride: null,
            ...(membership.member.role === "leader" ? { rolePresets: listTeamRolePresets() } : {}),
          },
        );
      });

      // 在每次模型调用前临时追加角色补充提示词（不持久化到 JSONL，运行中修改立即生效）：
      // - 独立扩展 pi-system-prompt-addon 已加载且职责已合入快照时，由独立扩展注入，此处跳过避免重复；
      // - 独立扩展未加载时由此处兜底追加快照；
      // - 旧成员快照因停用草稿或超限无法合入时（mode === "separate"），无论独立扩展是否加载都由此处单独追加职责。
      pi.on("context_with_system", async (event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const membership = findMembershipBySession(sessionId);
        if (!membership) return undefined;
        const addonLoaded = options.hasSystemPromptAddonExtension?.() ?? false;
        const resolution = membership.member.prompt.trim()
          ? await ensureTeamMemberRolePromptAddonLocked(
            sessionId,
            () => findMembershipBySession(sessionId)?.member.prompt ?? null,
          )
          : { mode: "snapshot" as const, addon: readSessionSystemPromptAddon(sessionId) };
        const basePrompt = getCurrentSystemPrompt(event.messages);
        let content = basePrompt;
        if (resolution.mode === "separate") {
          // 无独立扩展时先补上已启用的自定义快照，再追加独立职责，避免超限场景漏掉原补充提示词。
          if (!addonLoaded && resolution.addon) {
            content = appendSystemPromptAddon(content, resolution.addon) ?? content;
          }
          if (resolution.separateRoleText) {
            content = appendSystemPromptAddon(content, { enabled: true, text: resolution.separateRoleText }) ?? content;
          }
        } else if (!addonLoaded && resolution.addon) {
          content = appendSystemPromptAddon(content, resolution.addon) ?? content;
        }
        if (content === basePrompt) return undefined;
        const current = getCurrentSystemMessage(event.messages);
        return {
          messages: [
            {
              role: "system" as const,
              content,
              ...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
              timestamp: current?.timestamp ?? Date.now(),
            },
            ...event.messages.filter((message) => message.role !== "system"),
          ],
        };
      });

      // 每轮结束自动刷新成员在看板上的最近活动，不依赖 AI 手动汇报。
      pi.on("agent_end", async (event, ctx) => {
        const summary = extractTurnSummary(event.messages);
        if (!summary) return;
        try {
          await recordMemberActivity(ctx.sessionManager.getSessionId(), summary);
        } catch (error) {
          console.warn("[pi-web] 记录团队成员活动失败:", error instanceof Error ? error.message : error);
        }
      });

      pi.registerTool(defineTool({
        name: "team_list",
        label: "Team roster",
        description: "List all members of your team, their roles, working directories, live status, and recent activity.",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
          try {
            const { team, member } = requireMembership(ctx.sessionManager.getSessionId());
            return text(`团队「${team.name}」（共 ${team.members.length} 人）\n${formatTeamRoster(team, member.id)}`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "team_send",
        label: "Send team message",
        description: "Send a message to another member in your team. Wakes their session if idle or queues as follow-up if busy. Only send when you have concrete deliverables, questions, or review feedback — never send empty acknowledgments.",
        parameters: Type.Object({
          to: Type.String({ description: "Target teammate's name (from team_list)." }),
          message: Type.String({ description: "Message content to deliver." }),
          delivery: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer")], {
            description: 'Defaults to "followUp" (waits for their current turn to finish). Use "steer" only when urgent.',
          })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          try {
            const { team, member } = requireMembership(ctx.sessionManager.getSessionId());
            const hop = readCurrentTurnHop(ctx.sessionManager.getBranch());
            const { to } = await sendTeamMessage({
              team,
              from: member,
              toNameOrId: params.to,
              message: params.message,
              delivery: params.delivery,
              currentHop: hop,
            });
            return text(`已发送给 ${to.name}（${to.title || to.role}）。`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "board_list",
        label: "Team board",
        description: "List tasks on the team board, optionally filtered by status (todo, doing, review, done, blocked).",
        parameters: Type.Object({
          status: Type.Optional(cardStatusSchema),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          try {
            const { team } = requireMembership(ctx.sessionManager.getSessionId());
            return text(formatBoard(team, params.status));
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "board_update",
        label: "Update board card",
        description: "Update a board card's status and progress note. Members can update cards they are assigned to or reviewing; the leader can also change title, description, assignee, and reviewer. Moving a card to review automatically notifies its reviewer.",
        parameters: Type.Object({
          card_id: Type.String({ description: "Card id from board_list." }),
          status: Type.Optional(cardStatusSchema),
          note: Type.Optional(Type.String({ description: "Short progress note or review result." })),
          title: Type.Optional(Type.String({ description: "Leader only: new title." })),
          description: Type.Optional(Type.String({ description: "Leader only: new description." })),
          assignee: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Leader only: teammate name (or null to unassign)." })),
          reviewer: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Leader only: reviewer teammate name (or null to clear)." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          try {
            const { team, member } = requireMembership(ctx.sessionManager.getSessionId());
            const { card, previousStatus } = await updateTeamCard(team.id, params.card_id, {
              status: params.status,
              note: params.note,
              title: params.title,
              description: params.description,
              assignee: params.assignee,
              reviewer: params.reviewer,
            }, member.id);

            let notifySuffix = "";
            if (card.status === "review" && previousStatus !== "review") {
              const latestTeam = getTeam(team.id) ?? team;
              const hop = readCurrentTurnHop(ctx.sessionManager.getBranch());
              const notified = await notifyCardReviewer({
                team: latestTeam,
                card,
                actorName: member.name,
                actorId: member.id,
                note: params.note,
                currentHop: hop,
              });
              if (notified.notified && notified.reviewerName) {
                notifySuffix = `，已自动通知审核人 ${notified.reviewerName}`;
              } else if (notified.error) {
                notifySuffix = `（通知审核人失败：${notified.error}）`;
              }
            }
            return text(`已更新卡片 [${card.id}]「${card.title}」→ ${STATUS_LABELS[card.status]}${notifySuffix}。`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      // 以下工具仅向 Leader 注册，并在执行时再次校验身份。
      if (initialMembership.member.role !== "leader") return;

      pi.registerTool(defineTool({
        name: "team_member_create",
        label: "Add team member",
        description: "Leader only: add a new member to the team with their own persistent session. Can either apply an existing role preset via `preset` or define a brand-new role via `title`/`prompt`. Working directory, model, and thinking level default to a snapshot of the leader's current settings if omitted.",
        parameters: Type.Object({
          name: Type.String({ description: "Unique member name (e.g. dev-1, reviewer-1)." }),
          preset: Type.Optional(Type.String({ description: "Optional role preset name or id from team_role_preset_list. Fills default title and prompt; explicit title/prompt override it." })),
          title: Type.Optional(Type.String({ description: "Role title (e.g. 前端开发, 代码审核). Defaults to preset name when preset is given." })),
          prompt: Type.Optional(Type.String({ description: "Member-specific system prompt defining their responsibilities. Defaults to preset prompt when preset is given." })),
          cwd: Type.Optional(Type.String({ description: "Working directory path. Defaults to leader's cwd." })),
          provider: Type.Optional(Type.String({ description: "Optional model provider id (must be passed together with model_id)." })),
          model_id: Type.Optional(Type.String({ description: "Optional model id (must be passed together with provider)." })),
          thinking_level: Type.Optional(Type.String({ description: "Optional thinking level: off, minimal, low, medium, high, xhigh, max." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          try {
            const { team } = requireLeader(ctx.sessionManager.getSessionId());
            if ((params.provider && !params.model_id) || (!params.provider && params.model_id)) {
              return text("provider 和 model_id 必须同时提供。", true);
            }
            if (params.thinking_level !== undefined && !isThinkingLevel(params.thinking_level)) {
              return text(`无效的 thinking_level: ${params.thinking_level}`, true);
            }
            let resolvedTitle = params.title;
            let resolvedPrompt = params.prompt;
            if (params.preset !== undefined && params.preset.trim()) {
              const preset = getTeamRolePreset(params.preset);
              if (!preset) {
                return text(`找不到角色预设「${params.preset}」，请先调用 team_role_preset_list 查看可用预设或直接填写 prompt。`, true);
              }
              if (resolvedTitle === undefined) resolvedTitle = preset.name;
              if (resolvedPrompt === undefined) resolvedPrompt = preset.prompt;
            }
            const created = await provisionTeamMember({
              teamId: team.id,
              name: params.name,
              title: resolvedTitle,
              prompt: resolvedPrompt,
              cwd: params.cwd,
              ...(params.provider && params.model_id ? { model: { provider: params.provider, modelId: params.model_id } } : {}),
              ...(params.thinking_level ? { thinkingLevel: params.thinking_level } : {}),
            });
            return text(`已添加成员 ${created.name}（${created.title || "成员"}），工作目录：${created.cwd}，会话 ID：${created.sessionId}。`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "team_member_update",
        label: "Update team member",
        description: "Leader only: update a team member's name, role title, or definition prompt.",
        parameters: Type.Object({
          member: Type.String({ description: "Current member name or id." }),
          name: Type.Optional(Type.String({ description: "New unique name." })),
          title: Type.Optional(Type.String({ description: "New role title." })),
          prompt: Type.Optional(Type.String({ description: "New member definition prompt." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          try {
            const { team } = requireLeader(ctx.sessionManager.getSessionId());
            const target = resolveMember(team, params.member);
            if (!target) return text(`找不到成员 "${params.member}"`, true);
            const updated = await updateTeamMemberWithPrompt(team.id, target.id, {
              name: params.name,
              title: params.title,
              prompt: params.prompt,
            });
            return text(`已更新成员 ${updated.name}（${updated.title || updated.role}）。`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "team_member_remove",
        label: "Remove team member",
        description: "Leader only: remove a non-leader member from the team. Their session history is preserved as a normal session.",
        parameters: Type.Object({
          member: Type.String({ description: "Member name or id to remove." }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          try {
            const { team } = requireLeader(ctx.sessionManager.getSessionId());
            const target = resolveMember(team, params.member);
            if (!target) return text(`找不到成员 "${params.member}"`, true);
            const removed = await removeTeamMemberWithCleanup(team.id, target.id);
            return text(`已将 ${removed.name} 移出团队。`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "team_role_preset_list",
        label: "List role presets",
        description: "Leader only: list saved global role presets (id and name). Pass `preset` (name or id) to inspect its full prompt.",
        parameters: Type.Object({
          preset: Type.Optional(Type.String({ description: "Optional preset name or id to read its full prompt." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          try {
            requireLeader(ctx.sessionManager.getSessionId());
            if (params.preset && params.preset.trim()) {
              const target = getTeamRolePreset(params.preset);
              if (!target) return text(`找不到角色预设「${params.preset}」`, true);
              return text(`[${target.id}] ${target.name}\n\n${target.prompt || "（空）"}`);
            }
            const presets = listTeamRolePresets();
            if (presets.length === 0) return text("暂无角色预设，可用 team_role_preset_create 新建。");
            const lines = presets.map((preset) => {
              const firstLine = preset.prompt.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
              const preview = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
              return `- [${preset.id}] ${preset.name}${preview ? ` · ${preview}` : ""}`;
            });
            return text(`共有 ${presets.length} 个角色预设（传 preset 参数可查看完整提示词）：\n${lines.join("\n")}`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "team_role_preset_create",
        label: "Create role preset",
        description: "Leader only: create a reusable global role preset (name + role prompt).",
        parameters: Type.Object({
          name: Type.String({ description: "Unique preset role name (e.g. 后端开发, 代码审核)." }),
          prompt: Type.String({ description: "Role prompt text for members created from this preset." }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          try {
            requireLeader(ctx.sessionManager.getSessionId());
            const preset = await createTeamRolePreset({ name: params.name, prompt: params.prompt });
            return text(`已创建角色预设 [${preset.id}]「${preset.name}」。`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "team_role_preset_update",
        label: "Update role preset",
        description: "Leader only: update an existing global role preset's name or prompt.",
        parameters: Type.Object({
          preset: Type.String({ description: "Current preset name or id." }),
          name: Type.Optional(Type.String({ description: "New unique preset name." })),
          prompt: Type.Optional(Type.String({ description: "New role prompt text." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          try {
            requireLeader(ctx.sessionManager.getSessionId());
            const updated = await updateTeamRolePreset(params.preset, {
              name: params.name,
              prompt: params.prompt,
            });
            return text(`已更新角色预设 [${updated.id}]「${updated.name}」。`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "team_role_preset_delete",
        label: "Delete role preset",
        description: "Leader only: delete a global role preset by name or id.",
        parameters: Type.Object({
          preset: Type.String({ description: "Preset name or id to delete." }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          try {
            requireLeader(ctx.sessionManager.getSessionId());
            const removed = await deleteTeamRolePreset(params.preset);
            if (!removed) return text(`找不到角色预设「${params.preset}」`, true);
            return text(`已删除角色预设「${removed.name}」。`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "board_create",
        label: "Create board card",
        description: "Leader only: create a task card on the team board and optionally assign an owner and reviewer.",
        parameters: Type.Object({
          title: Type.String({ description: "Short task title." }),
          description: Type.Optional(Type.String({ description: "Task details and acceptance criteria." })),
          status: Type.Optional(cardStatusSchema),
          assignee: Type.Optional(Type.String({ description: "Teammate name responsible for the task." })),
          reviewer: Type.Optional(Type.String({ description: "Teammate name who will review when moved to review." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          try {
            const { team, member } = requireLeader(ctx.sessionManager.getSessionId());
            const card = await createTeamCard(team.id, {
              title: params.title,
              description: params.description,
              status: params.status,
              assignee: params.assignee,
              reviewer: params.reviewer,
            }, member.id);
            let notifySuffix = "";
            if (card.status === "review" && card.reviewerId) {
              const latestTeam = getTeam(team.id) ?? team;
              const hop = readCurrentTurnHop(ctx.sessionManager.getBranch());
              const notified = await notifyCardReviewer({
                team: latestTeam,
                card,
                actorName: member.name,
                actorId: member.id,
                currentHop: hop,
              });
              if (notified.notified && notified.reviewerName) {
                notifySuffix = `，已自动通知审核人 ${notified.reviewerName}`;
              }
            }
            return text(`已创建看板卡片 [${card.id}]「${card.title}」（${STATUS_LABELS[card.status]}）${notifySuffix}。`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));

      pi.registerTool(defineTool({
        name: "board_delete",
        label: "Delete board card",
        description: "Leader only: remove a card from the team board.",
        parameters: Type.Object({
          card_id: Type.String({ description: "Card id to delete." }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          try {
            const { team } = requireLeader(ctx.sessionManager.getSessionId());
            await deleteTeamCard(team.id, params.card_id);
            return text(`已删除卡片 ${params.card_id}。`);
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      }));
    },
  };
}
