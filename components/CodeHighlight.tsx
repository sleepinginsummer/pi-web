"use client";

// 代码高亮渲染组件（React.lazy 懒加载目标）。
// 与 lib/prism-languages.ts 配合：语言定义按需加载，加载完成前渲染纯文本
// 占位（样式与高亮结果接近，避免布局跳动）。未知语言或加载失败也回退纯文本。

import { useEffect, useState } from "react";
import PrismLight from "react-syntax-highlighter/dist/esm/prism-light";
import vs from "react-syntax-highlighter/dist/esm/styles/prism/vs";
import vscDarkPlus from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";
import { loadPrismLanguage } from "@/lib/prism-languages";


interface CodeHighlightProps {
  code: string;
  lang: string;
  isDark: boolean;
}

export default function CodeHighlight({ code, lang, isDark }: CodeHighlightProps) {
  // null = 语言加载中；true = 可高亮；false = 未知语言/加载失败（回退纯文本）
  const [highlightable, setHighlightable] = useState<boolean | null>(null);

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

  if (highlightable !== true) {
    return (
      <pre className="markdown-code-plain" style={{ margin: 0, padding: "11px 13px", fontSize: 12.5, lineHeight: 1.62, borderRadius: 0, overflow: "auto" }}>
        <code style={{ fontFamily: "var(--font-mono)", background: "none" }}>{code}</code>
      </pre>
    );
  }

  return (
    <PrismLight
      language={lang || "text"}
      style={isDark ? vscDarkPlus : vs}
      showLineNumbers
      lineNumberStyle={{ color: "var(--text-dim)", fontStyle: "normal" }}
      customStyle={{
        margin: 0,
        padding: "11px 13px",
        fontSize: 12.5,
        lineHeight: 1.62,
        borderRadius: 0,
        background: "color-mix(in srgb, var(--bg) 92%, var(--bg-panel))",
      }}
      codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
    >
      {code}
    </PrismLight>
  );
}
