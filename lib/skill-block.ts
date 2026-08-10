export interface ParsedSkillBlock {
  name: string;
  location: string;
  content: string;
  userMessage?: string;
}

export interface ParsedSkillMessage {
  skills: ParsedSkillBlock[];
  userMessage?: string;
  /** 将已展开的 skill 还原为命令，保留它在原用户消息中的位置。 */
  displayText: string;
}

/** 解析会话中任意位置的 skill 展开块，并生成保留原位置的展示文本。 */
export function parseSkillMessage(text: string): ParsedSkillMessage | null {
  const skills: ParsedSkillBlock[] = [];
  const blockPattern = /<skill name="([^"]+)" location="([^"]+)">\r?\n([\s\S]*?)\r?\n<\/skill>/g;
  const displayText = text.replace(blockPattern, (_match, name: string, location: string, content: string) => {
    skills.push({ name, location, content });
    return `/skill:${name}`;
  });
  if (skills.length === 0) return null;

  const leadingCommandPattern = /^(?:\/skill:[^\s]+\s*)+/;
  const userMessage = displayText.replace(leadingCommandPattern, "").trim() || undefined;
  return { skills, userMessage, displayText };
}

/** 解析 pi 展开 /skill:name 后写入会话的用户消息。 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
  const message = parseSkillMessage(text);
  if (!message || message.skills.length !== 1) return null;
  return {
    ...message.skills[0],
    userMessage: message.userMessage,
  };
}
