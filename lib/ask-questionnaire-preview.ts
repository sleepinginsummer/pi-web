/** 剥离完整包裹多行预览的 Markdown 代码围栏，保留内部排版。 */
export function normalizeAskQuestionnairePreview(preview: string): string {
  const normalized = preview.replace(/\r\n?/g, "\n");
  const fenced = normalized.match(/^[ \t]*(`{1,3})[ \t]*[a-z0-9_-]*[ \t]*\n([\s\S]*?)\n\1[ \t]*$/i);
  return fenced?.[2] ?? normalized;
}
