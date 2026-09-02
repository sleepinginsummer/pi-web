/**
 * Tool-name predicates shared by the chat views.
 *
 * Pi's built-in names are plain `write` / `edit`, but MCP servers expose the
 * same operations under prefixed or namespaced names, so each predicate also
 * accepts the common decorated forms.
 */

export function isWriteToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "write" ||
    name.startsWith("write_") ||
    name.endsWith(".write") ||
    name.endsWith("_write");
}

export function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "edit" ||
    name === "replace" ||
    name.startsWith("edit_") ||
    name.startsWith("replace_") ||
    name.endsWith(".edit") ||
    name.endsWith(".replace") ||
    name.endsWith("_edit") ||
    name.endsWith("_replace") ||
    name.includes("str_replace") ||
    name.includes("replace_editor");
}
