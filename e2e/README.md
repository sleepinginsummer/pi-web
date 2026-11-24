# 浏览器回归测试

```sh
npm ci
npx playwright install chromium
npm run test:e2e
npm run test:e2e:layout  # 单独运行多分辨率交互与高度回归
E2E_LAYOUT_SCREENSHOTS=1 npm run test:e2e:layout  # 按需保存成功路径截图
npm run test:terminal
```

`test:e2e` 和 `test:terminal` 均在空闲的当前 checkout 启动独立 Turbopack 测试服务，并使用临时 `PI_CODING_AGENT_DIR`，不读取用户模型凭据或已有会话。两者须依次运行，不能与同一 checkout 的 `next dev` 竞争 `.next/dev/lock`；其它 worktree 的开发服务不受影响。Git 用于工作目录测试，终端测试还需要可用的 node-pty。

CI 在独立 checkout 构建后，以 `E2E_SERVER_MODE=start npm run test:e2e` 验证生产页面。在开发 checkout 不要运行 `next build`。正式部署使用 `npm start`、`npm run start:lan` 或 `bin/pi-web.js`，先轮换构建包中的 preview 密钥；测试的 `start` 模式只读取本次 CI 独立构建产物。

主入口在开发模式先请求页面和只读状态路由，让 Turbopack 冷编译在浏览器断言前完成；外置盘上曾测得首次状态路由 14.7s，超过客户端 10s 的请求期限。布局用例在开发模式还会预热首个会话的事件流至 `connected` 后关闭预热连接，避免 SSE 路由冷编译触发客户端连接期限。预热复用 broker 的增量解析器，按完整 SSE 帧处理，`startup_error` 报告保留会话 ID 和服务端 `errorMessage`。生产模式不预热，浏览器控制台错误仍全部检查。

主套件覆盖：

- 5000 条消息的分页、消息顺序、分支、压缩导航、阅读位置恢复和有界响应。
- 外部 JSONL 追加、无效会话与项目外文件访问拒绝。
- Markdown、代码、Mermaid、长表格以及主题切换后的背景。
- 桌面和 390px 移动端的文件面板、预览表单和滚动状态、隐藏期间同大小文件修改、整文件 `@` 提及。
- 扩展弹窗键盘操作、取消、草稿保留、服务端过期及宽度限制。
- 字体、字号、聊天宽度、跨标签页同步及设置面板布局。
- `responsive-layout.mjs` 覆盖 320×568、360×640、390×844、430×932、640×640、641×640、768×1024、844×390、1024×768、1366×768、1920×1080：斜杠命令展开/过滤/无结果/Tab/Escape，长短草稿与窗口调整，模拟软键盘，真实 SSE 流式期间打字、后续排队、Stop 取回以及正常结束，select/confirm/input/editor/代码/自定义弹窗和设置面板。对输入卡片位置、高度、裁切、焦点和选区做断言；失败保存对应尺寸的截图与 trace。可用 `npm run test:e2e:layout` 单独运行。
- 模型发现和上下文窗口编辑、保存、重开、校验、失败重试与清除；模型上下文场景通过 `e2e/model-context.mjs` 接入主入口。
- 布局套件额外验证：模拟键盘下的长草稿实际点选文件补全、连续点选目录与目录内文件；`@src/` 仅显示文件菜单且不加载斜杠命令或技能，移出 token 后斜杠菜单和资源加载恢复；Escape 后不露出斜杠菜单；点选/关闭/键盘收起后恢复草稿高度；移除 `dvh` 条件规则后验证 `vh` 回退、键盘高度变量与长历史不撑开整页。默认不新增成功路径截图，`E2E_LAYOUT_SCREENSHOTS=1` 开启原有 77 张布局成功截图；失败时分别尝试保存截图和 trace，采集失败单独记录且保留原始用例错误。

- `lib/e2e-layout-diagnostics.test.mjs` 随默认 `npm test` 运行，覆盖采样中途节点消失、测量异常和持续跳变，以及截图、trace、上下文关闭失败时的原始错误保留。

终端套件覆盖桌面和 390px 移动端的面板开关、字体与主题、刷新和断网重连、进程状态保持、重启/关闭及跨工作目录切换。关闭按钮按 fork 的可见控件定位：桌面在顶部栏，移动端在面板内，不依赖上游布局或 `aria-expanded`。

fork 保留自己的侧栏，未恢复依赖上游侧栏重设计的 `session-navigation`、`project-navigation`、`sidebar.mjs` 场景。

主套件失败时在 `test-results/e2e/` 保存截图、Playwright trace 和服务端日志；使用 `npx playwright show-trace test-results/e2e/trace.zip` 查看。终端套件启动时打印独立的临时产物目录。布局套件使用本地 OpenAI 兼容假服务，走真实模型传输、SSE、队列和 Stop，不请求外部模型。布局自动化目前只运行 Chromium；软键盘仅模拟 visualViewport 收缩，Safari/Firefox 差异、系统输入法与 iOS/Android 键盘仍需真机核对。流式渲染边界另由 `components/ChatWindow.streaming.test.mjs` 使用真实 React 组件和 Profiler 验证。
