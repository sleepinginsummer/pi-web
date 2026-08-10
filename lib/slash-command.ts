export interface SlashQuery {
  query: string;
  start: number;
  inline: boolean;
}

/** 识别输入末尾的斜杠命令；已有正文时仅用于选择 skill。 */
export function findSlashQuery(value: string): SlashQuery | null {
  let queryStart = value.length;
  while (queryStart > 0 && !/[/\s]/.test(value[queryStart - 1])) queryStart--;
  if (queryStart === 0 || value[queryStart - 1] !== "/") return null;

  let start = queryStart - 1;
  while (start > 0 && value[start - 1] === "/") start--;

  let tokenStart = start;
  while (tokenStart > 0 && !/\s/.test(value[tokenStart - 1])) tokenStart--;
  if (value.slice(tokenStart, start).includes("/")) return null;

  let inline = start > 0;
  if (inline) {
    let previous = start - 1;
    while (previous >= 0 && /\s/.test(value[previous])) previous--;
    inline = previous >= 0;
  }
  return {
    query: value.slice(queryStart).toLowerCase(),
    start,
    inline,
  };
}

/** 替换当前斜杠查询，保留 skill 在用户输入中的原位置。发送时再由服务端整理为 Pi 可识别的前缀。 */
export function applySlashSelection(value: string, slash: SlashQuery, commandName: string): string {
  if (!slash.inline) return `/${commandName} `;
  const selectionEnd = slash.start + 1 + slash.query.length;
  return `${value.slice(0, slash.start)}/${commandName} ${value.slice(selectionEnd)}`;
}
