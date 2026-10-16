"use client";

import { Children, cloneElement, createContext, isValidElement, memo, useCallback, useContext, useMemo, useRef, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps, type Options as ReactMarkdownOptions } from "react-markdown";
import { parsePdfPageFragment, resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { isExternalMarkdownHref, markdownAppUrlTransform, markdownDocumentRehypePlugins, markdownRehypePlugins, markdownRemarkPlugins, markdownUrlTransform, markdownUserRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { splitStreamingMarkdown } from "@/lib/streaming-markdown-blocks";
import { ImagePreview } from "./ImagePreview";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";

const MarkdownLinkContext = createContext(false);

type MarkdownRenderConfig = Pick<ReactMarkdownOptions, "remarkPlugins" | "rehypePlugins" | "urlTransform" | "components">;

/** 代码块渲染：已解析的围栏与流式中未闭合的围栏共用同一分支，避免样式与行为分叉。 */
function renderCodeBlock(raw: string, lang: string, isStreaming?: boolean) {
  const code = raw.replace(/\n$/, "");
  if (lang === "mermaid") return <MermaidBlock code={code} isStreaming={isStreaming} defaultPreview />;
  return <CodeBlock code={code} lang={lang} isStreaming={isStreaming} />;
}

/**
 * 流式前缀块。`source` 与 `config` 都按值稳定（同一段文本、父组件 memo 化的配置），
 * 块内容不再变化时 memo 会直接跳过，于是每帧只需要重新解析仍在增长的尾部。
 */
const StreamingMarkdownBlock = memo(function StreamingMarkdownBlock({ source, config }: { source: string; config: MarkdownRenderConfig }) {
  return (
    <ReactMarkdown
      remarkPlugins={config.remarkPlugins}
      rehypePlugins={config.rehypePlugins}
      urlTransform={config.urlTransform}
      components={config.components}
    >
      {source}
    </ReactMarkdown>
  );
});

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** A document reader's own links: relative paths and `#headings` stay in the reader. */
  onNavigateLink?: (href: string) => void;
  /** Render every line ending as a line break, for text the user typed. */
  keepLineBreaks?: boolean;
}

function MarkdownImage({
  src,
  alt,
  cwd,
  ...props
}: ComponentProps<"img"> & ExtraProps & { cwd?: string }) {
  const insideLink = useContext(MarkdownLinkContext);
  delete props.node;
  const href = typeof src === "string" ? src : undefined;
  const filePath = href ? resolveLocalFileHref(href, cwd) : null;
  const imageSrc = filePath
    ? `/api/files/${encodeFilePathForApi(filePath)}?type=read`
    : href;
  // Dynamic local paths are served directly by the file API.
  // eslint-disable-next-line @next/next/no-img-element
  const image = <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
  if (!imageSrc || insideLink) return image;
  return (
    <ImagePreview src={imageSrc} alt={alt ?? ""} className="markdown-image">
      {image}
    </ImagePreview>
  );
}

interface MarkdownListItemProps {
  children?: ReactNode;
  className?: string;
}

function renderListItems(children: ReactNode, ordered: boolean, start = 1) {
  let itemIndex = 0;
  return Children.map(children, (child) => {
    if (!isValidElement<MarkdownListItemProps>(child)) return child;

    const isTaskItem = child.props.className?.split(" ").includes("task-list-item") ?? false;
    const marker = isTaskItem ? null : ordered ? `${start + itemIndex}. ` : "• ";
    itemIndex += 1;
    return cloneElement(
      child,
      child.props,
      marker ? <span className="markdown-list-marker" aria-hidden="true">{marker}</span> : null,
      child.props.children,
    );
  });
}

// 整体 memo：父组件因无关状态重渲染时，相同正文不再重新解析。
export const MarkdownBody = memo(function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile, onNavigateLink, keepLineBreaks }: MarkdownBodyProps) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  // 回调和配置都通过 ref 读取，让 components 只随 cwd / 流式状态 / 是否有打开文件
  // 能力变化，块级 memo 才能在上游回调换身份时依然命中。
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const hasOnOpenFile = Boolean(onOpenFile);
  const openFile = useCallback((filePath: string, page?: number) => {
    onOpenFileRef.current?.(filePath, page);
  }, []);
  const onNavigateLinkRef = useRef(onNavigateLink);
  onNavigateLinkRef.current = onNavigateLink;
  const hasOnNavigateLink = Boolean(onNavigateLink);
  // Stable renderer identities keep stateful blocks mounted across message hover updates.
  const components = useMemo<Components>(() => ({
    code({ className, children, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) return renderCodeBlock(raw, lang, isStreaming);
      return (
        <code
          className="markdown-inline-code"
          {...props}
        >
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    ol({ children, start, style, node, ...props }) {
      const firstNumber = typeof start === "number" ? start : 1;
      // 序号画在左内边距里，"10." 以上会被 .markdown-body 的 overflow-x 裁掉，内边距随最大序号位数增长。
      const items = node?.children.filter((child) => child.type === "element" && child.tagName === "li").length ?? 0;
      const digits = String(Math.abs(firstNumber + Math.max(items, 1) - 1)).length;
      return (
        <ol start={start} style={{ ...style, ["--ol-marker-digits" as string]: Math.max(digits, 2) }} {...props}>
          {renderListItems(children, true, firstNumber)}
        </ol>
      );
    },
    ul({ children, ...props }) {
      delete props.node;
      return <ul {...props}>{renderListItems(children, false)}</ul>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      const navigateLink = hasOnNavigateLink && href && !isExternalMarkdownHref(href) ? href : null;
      if (navigateLink) {
        // 不设置 href：中键或「在新标签页打开」会把相对路径加载到应用自身 URL 上。
        const navigate = () => onNavigateLinkRef.current?.(navigateLink);
        return (
          <MarkdownLinkContext.Provider value={true}>
            <a {...props} role="link" tabIndex={0} onClick={navigate} onKeyDown={(event) => { if (event.key === "Enter") navigate(); }}>
              {children}
            </a>
          </MarkdownLinkContext.Provider>
        );
      }
      const filePath = hasOnOpenFile ? resolveLocalFileHref(href, cwd) : null;
      if (!filePath || !hasOnOpenFile) {
        return (
          <MarkdownLinkContext.Provider value={true}>
            <a href={href} {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          </MarkdownLinkContext.Provider>
        );
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (!shouldOpenLocalFileInApp(event)) return;
        const target = event.currentTarget.getAttribute("target");
        if (target && target !== "_self") return;
        event.preventDefault();
        openFile(filePath, parsePdfPageFragment(href) ?? undefined);
      };

      return (
        <MarkdownLinkContext.Provider value={true}>
          <a href={href} {...props} onClick={handleClick}>
            {children}
          </a>
        </MarkdownLinkContext.Provider>
      );
    },
    img(props) {
      return <MarkdownImage cwd={cwd} {...props} />;
    },
    table({ children }) {
      // The frame draws the border; the scroller inside it fades its scrolled
      // edges, which on the bordered box would fade the border too.
      return (
        <div className="markdown-table-frame">
          <div className="markdown-table-wrap">
            <table>{children}</table>
          </div>
        </div>
      );
    },
  }), [cwd, hasOnNavigateLink, hasOnOpenFile, isStreaming, openFile]);

  const renderConfig = useMemo<MarkdownRenderConfig>(() => ({
    remarkPlugins: keepLineBreaks ? markdownUserRemarkPlugins : markdownRemarkPlugins,
    rehypePlugins: hasOnNavigateLink ? markdownDocumentRehypePlugins : markdownRehypePlugins,
    // 没有文件打开回调时仍需保留 obsidian://、vscode:// 等桌面应用链接。
    urlTransform: hasOnOpenFile ? markdownUrlTransform : markdownAppUrlTransform,
    components,
  }), [components, hasOnNavigateLink, hasOnOpenFile, keepLineBreaks]);
  // 流式期间把累积文本切成可缓存前缀块，每帧只重新解析仍在增长的尾部。
  const streamingSplit = useMemo(
    () => (isStreaming ? splitStreamingMarkdown(normalizedMarkdown) : null),
    [isStreaming, normalizedMarkdown],
  );

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      {streamingSplit ? (
        <>
          {streamingSplit.blocks.map((block, index) => (
            <StreamingMarkdownBlock key={index} source={block} config={renderConfig} />
          ))}
          {streamingSplit.tail ? (
            <StreamingMarkdownBlock source={streamingSplit.tail} config={renderConfig} />
          ) : null}
          {/* 未闭合的代码围栏按纯文本渲染，闭合后它会成为普通块重新解析。 */}
          {streamingSplit.openFence ? renderCodeBlock(
            streamingSplit.openFence.code,
            streamingSplit.openFence.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "",
            isStreaming,
          ) : null}
        </>
      ) : (
        <ReactMarkdown
          remarkPlugins={renderConfig.remarkPlugins}
          rehypePlugins={renderConfig.rehypePlugins}
          urlTransform={renderConfig.urlTransform}
          components={renderConfig.components}
        >
          {normalizedMarkdown}
        </ReactMarkdown>
      )}
    </div>
  );
});
