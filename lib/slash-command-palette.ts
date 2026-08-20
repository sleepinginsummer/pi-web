export interface SlashCommandPaletteItem {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill";
}

export type SlashCommandSource = SlashCommandPaletteItem["source"];

export interface SlashCommandGroup {
  source: SlashCommandSource;
  items: Array<{ command: SlashCommandPaletteItem; index: number }>;
}

export const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill"];

export const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  builtin: "chat.builtIn",
  extension: "chat.extensions",
  prompt: "chat.prompts",
  skill: "chat.skills",
};

export const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
};

export function getSlashDescription(command: SlashCommandPaletteItem, translate: (key: string) => string): string {
  return command.source === "builtin" ? translate(command.description ?? "") : command.description ?? "";
}

export function isDormantSkillCommand(command: SlashCommandPaletteItem, dormancy: Record<string, boolean>): boolean {
  return command.source === "skill"
    && command.name.startsWith("skill:")
    && dormancy[command.name.slice("skill:".length)] === true;
}

export function buildSlashCommandLayout(
  commands: SlashCommandPaletteItem[],
  dormancy: Record<string, boolean>,
): { commands: SlashCommandPaletteItem[]; groups: SlashCommandGroup[] } {
  let index = 0;
  const groups = SLASH_SOURCES
    .map((source) => {
      const sourceCommands = commands.filter((command) => command.source === source);
      const orderedCommands = source === "skill"
        ? [
            ...sourceCommands.filter((command) => !isDormantSkillCommand(command, dormancy)),
            ...sourceCommands.filter((command) => isDormantSkillCommand(command, dormancy)),
          ]
        : sourceCommands;
      return {
        source,
        items: orderedCommands.map((command) => ({ command, index: index++ })),
      };
    })
    .filter((group) => group.items.length > 0);

  return {
    commands: groups.flatMap((group) => group.items.map(({ command }) => command)),
    groups,
  };
}
