import { readFileSync } from "fs";

interface LoadedSkill {
  name: string;
  filePath: string;
  baseDir: string;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

export interface ExpandedMultiSkillCommand {
  text: string;
  expanded: boolean;
}
/** 将输入中的已知 skill 命令直接展开在原位置，避免改变用户消息的排版。 */
export function expandMultiSkillCommand(text: string, loadedSkills: LoadedSkill[]): ExpandedMultiSkillCommand {
  const skillsByName = new Map(loadedSkills.map((skill) => [skill.name, skill]));
  let expanded = false;
  const expandedText = text.replace(/\/skill:([^\s]+)/g, (command, name: string) => {
    const skill = skillsByName.get(name);
    if (!skill) return command;
    expanded = true;
    const body = stripFrontmatter(readFileSync(skill.filePath, "utf-8"));
    return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  });
  return { text: expandedText, expanded };
}
