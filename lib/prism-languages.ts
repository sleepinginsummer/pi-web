// 代码高亮按需加载。
//
// 背景：react-syntax-highlighter 的主入口会静态引入 Prism 全量语言表（数百 KB），
// 而实际会话里只会用到少数几种语言。这里改用 PrismLight（只带 refractor 核心，
// 不含任何语言定义）+ 按语言动态 import，webpack 会为每种语言拆分独立 chunk，
// 首次遇到某语言时才下载对应定义，从而显著减小主 bundle。
//
// 注：@types/react-syntax-highlighter 已用 declare module 覆盖全部子路径类型，
// 因此子路径导入（PrismLight / 语言模块）可直接获得类型。

import PrismLight from "react-syntax-highlighter/dist/esm/prism-light";

// 常用语言 → prism 语言模块的映射（key 为 markdown 代码围栏中的小写语言名，
// 含常见别名归一化；value 为按需加载器）。
const LANGUAGE_LOADERS: Record<string, () => Promise<unknown>> = {
  // 前端
  javascript: () => import("react-syntax-highlighter/dist/esm/languages/prism/javascript"),
  js: () => import("react-syntax-highlighter/dist/esm/languages/prism/javascript"),
  jsx: () => import("react-syntax-highlighter/dist/esm/languages/prism/jsx"),
  typescript: () => import("react-syntax-highlighter/dist/esm/languages/prism/typescript"),
  ts: () => import("react-syntax-highlighter/dist/esm/languages/prism/typescript"),
  tsx: () => import("react-syntax-highlighter/dist/esm/languages/prism/tsx"),
  css: () => import("react-syntax-highlighter/dist/esm/languages/prism/css"),
  scss: () => import("react-syntax-highlighter/dist/esm/languages/prism/scss"),
  less: () => import("react-syntax-highlighter/dist/esm/languages/prism/less"),
  html: () => import("react-syntax-highlighter/dist/esm/languages/prism/markup"),
  xml: () => import("react-syntax-highlighter/dist/esm/languages/prism/markup"),
  svg: () => import("react-syntax-highlighter/dist/esm/languages/prism/markup"),
  // 后端
  python: () => import("react-syntax-highlighter/dist/esm/languages/prism/python"),
  py: () => import("react-syntax-highlighter/dist/esm/languages/prism/python"),
  go: () => import("react-syntax-highlighter/dist/esm/languages/prism/go"),
  rust: () => import("react-syntax-highlighter/dist/esm/languages/prism/rust"),
  rs: () => import("react-syntax-highlighter/dist/esm/languages/prism/rust"),
  java: () => import("react-syntax-highlighter/dist/esm/languages/prism/java"),
  kotlin: () => import("react-syntax-highlighter/dist/esm/languages/prism/kotlin"),
  kt: () => import("react-syntax-highlighter/dist/esm/languages/prism/kotlin"),
  swift: () => import("react-syntax-highlighter/dist/esm/languages/prism/swift"),
  c: () => import("react-syntax-highlighter/dist/esm/languages/prism/c"),
  cpp: () => import("react-syntax-highlighter/dist/esm/languages/prism/cpp"),
  "c++": () => import("react-syntax-highlighter/dist/esm/languages/prism/cpp"),
  csharp: () => import("react-syntax-highlighter/dist/esm/languages/prism/csharp"),
  cs: () => import("react-syntax-highlighter/dist/esm/languages/prism/csharp"),
  ruby: () => import("react-syntax-highlighter/dist/esm/languages/prism/ruby"),
  rb: () => import("react-syntax-highlighter/dist/esm/languages/prism/ruby"),
  php: () => import("react-syntax-highlighter/dist/esm/languages/prism/php"),
  // 数据 / 配置
  json: () => import("react-syntax-highlighter/dist/esm/languages/prism/json"),
  yaml: () => import("react-syntax-highlighter/dist/esm/languages/prism/yaml"),
  yml: () => import("react-syntax-highlighter/dist/esm/languages/prism/yaml"),
  toml: () => import("react-syntax-highlighter/dist/esm/languages/prism/toml"),
  ini: () => import("react-syntax-highlighter/dist/esm/languages/prism/ini"),
  sql: () => import("react-syntax-highlighter/dist/esm/languages/prism/sql"),
  graphql: () => import("react-syntax-highlighter/dist/esm/languages/prism/graphql"),
  gql: () => import("react-syntax-highlighter/dist/esm/languages/prism/graphql"),
  // 脚本 / 运维
  bash: () => import("react-syntax-highlighter/dist/esm/languages/prism/bash"),
  sh: () => import("react-syntax-highlighter/dist/esm/languages/prism/bash"),
  shell: () => import("react-syntax-highlighter/dist/esm/languages/prism/bash"),
  zsh: () => import("react-syntax-highlighter/dist/esm/languages/prism/bash"),
  powershell: () => import("react-syntax-highlighter/dist/esm/languages/prism/powershell"),
  docker: () => import("react-syntax-highlighter/dist/esm/languages/prism/docker"),
  dockerfile: () => import("react-syntax-highlighter/dist/esm/languages/prism/docker"),
  diff: () => import("react-syntax-highlighter/dist/esm/languages/prism/diff"),
  markdown: () => import("react-syntax-highlighter/dist/esm/languages/prism/markdown"),
  md: () => import("react-syntax-highlighter/dist/esm/languages/prism/markdown"),
  hcl: () => import("react-syntax-highlighter/dist/esm/languages/prism/hcl"),
  terraform: () => import("react-syntax-highlighter/dist/esm/languages/prism/hcl"),
  git: () => import("react-syntax-highlighter/dist/esm/languages/prism/git"),
};

// 已注册语言（refractor 按 displayName 注册，注册后同名/别名均可识别）
const registered = new Set<string>();
// 加载中的去重表（避免同一语言并发重复加载）
const loading = new Map<string, Promise<boolean>>();

/**
 * 确保某语言的高亮定义已加载。
 *
 * @returns 该语言是否可高亮（false = 未知语言或加载失败，调用方应回退纯文本）。
 */
export function loadPrismLanguage(lang: string): Promise<boolean> {
  const loader = LANGUAGE_LOADERS[lang];
  if (!loader) return Promise.resolve(false);
  if (registered.has(lang)) return Promise.resolve(true);

  const inFlight = loading.get(lang);
  if (inFlight) return inFlight;

  const promise = loader()
    .then((mod) => {
      const language = (mod as { default?: unknown }).default;
      if (typeof language !== "function") return false;
      // refractor 5 的语言模块是注册函数，自带 displayName/aliases，
      // PrismLight.registerLanguage 内部按 displayName 注册。
      PrismLight.registerLanguage(lang, language as never);
      registered.add(lang);
      return true;
    })
    .catch(() => false) // 加载失败回退纯文本，允许下次重试
    .finally(() => {
      loading.delete(lang);
    });
  loading.set(lang, promise);
  return promise;
}
