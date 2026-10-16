"use client";

// 代码高亮渲染组件（React.lazy 懒加载目标）。
// 与 lib/prism-languages.ts 配合：语言定义按需加载，加载完成前渲染纯文本
// 占位（样式与高亮结果接近，避免布局跳动）。未知语言或加载失败也回退纯文本。

import { useEffect, useState } from "react";
import PrismLight from "react-syntax-highlighter/dist/esm/prism-light";
import vs from "react-syntax-highlighter/dist/esm/styles/prism/vs";
import vscDarkPlus from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";
import { loadPrismLanguage } from "@/lib/prism-languages";
import { takeHighlightBudget, waitForHighlight } from "@/lib/highlight-queue";


// 暗色主题使用 background 简写，交由 customStyle 统一管理以免切换主题时重置背景。
const codeBlockDarkTheme = { ...vscDarkPlus, 'pre[class*="language-"]': { ...vscDarkPlus['pre[class*="language-"]'] } };
delete codeBlockDarkTheme['pre[class*="language-"]'].background;
interface CodeHighlightProps {
  code: string;
  lang: string;
  isDark: boolean;
}

export default function CodeHighlight({ code, lang, isDark }: CodeHighlightProps) {
  // null = 语言加载中；true = 可高亮；false = 未知语言/加载失败（回退纯文本）
  const [highlightable, setHighlightable] = useState<boolean | null>(null);

  // 同一任务里一次挂载大量代码块（打开长会话、回复结束）时，超出预算的先以纯文本显示，
  // 空闲时段逐个补上高亮，最新的优先（lib/highlight-queue.ts）。
  const [budgetGranted, setBudgetGranted] = useState(false);

  useEffect(() => {
    if (highlightable !== true || budgetGranted) return;
    if (takeHighlightBudget(code.length)) {
      setBudgetGranted(true);
      return;
    }
    return waitForHighlight(() => setBudgetGranted(true));
  }, [budgetGranted, code.length, highlightable]);

  useEffect(() => {
    let cancelled = false;
    setHighlightable(null);
    loadPrismLanguage(lang).then((ok) => {
      if (!cancelled) setHighlightable(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  if (highlightable !== true || !budgetGranted) {
    return (
      <pre className="markdown-code-plain" style={{ margin: 0, padding: "11px 13px", fontSize: "calc(12.5px + var(--chat-font-size-offset, 0px))", lineHeight: 1.62, fontWeight: "var(--font-mono-weight)", borderRadius: 0, overflow: "auto", backgroundColor: "color-mix(in srgb, var(--bg) 92%, var(--bg-panel))" }}>
        <code style={{ fontFamily: "var(--font-mono)", fontWeight: "var(--font-mono-weight)", background: "none" }}>{code}</code>
      </pre>
    );
  }

  return (
    <PrismLight
      language={lang || "text"}
      style={isDark ? codeBlockDarkTheme : vs}
      showLineNumbers
      lineNumberStyle={{ color: "var(--text-dim)", fontStyle: "normal" }}
      customStyle={{
        margin: 0,
        padding: "11px 13px",
        fontSize: "calc(12.5px + var(--chat-font-size-offset, 0px))",
        lineHeight: 1.62,
        fontWeight: "var(--font-mono-weight)",
        // 浅色 vs 主题自带 1px #ddd 边框，边框由外层 .markdown-code-block 负责。
        border: "none",
        borderRadius: 0,
        // 只能用 backgroundColor：Prism 浅色主题用 background-color、暗色主题用 background 简写，
        // 混用会让 React 的样式 diff 在切换主题时互相覆盖，导致背景丢失。
        backgroundColor: "color-mix(in srgb, var(--bg) 92%, var(--bg-panel))",
      }}
      codeTagProps={{ style: { fontFamily: "var(--font-mono)", fontWeight: "var(--font-mono-weight)" } }}
    >
      {code}
    </PrismLight>
  );
}
