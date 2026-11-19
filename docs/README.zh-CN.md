# Pi Web

[English](../README.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

[pi 编程智能体](https://github.com/badlogic/pi-mono) 的本地网页界面。它会读取本机的 pi 会话文件，在浏览器里提供会话管理、实时对话、模型配置、技能管理和项目文件预览。

中文微信群：请查看 [GitHub Discussions 帖子](https://github.com/agegr/pi-web/discussions/271)。

![Pi Web 展示包含结构化 Markdown、工具调用和项目导航的 pi 会话](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## 功能

- **会话工作区**：按项目查找、继续、重命名、导出和删除对话，并查看运行状态、上下文占用、花费和压缩信息。
- **两种分支方式**：**新会话**会从较早的消息创建独立会话文件；**从此处编辑**会在当前会话内创建分支。
- **项目文件工具**：浏览和上传文件、查看 Git Diff，并预览源码、Markdown、图片、音频、PDF 和 DOCX；文件变化后会自动刷新。
- **Git worktree**：从侧边栏切换 checkout，同时把同一仓库不同 worktree 的会话归在一起。
- **网页配置**：无需离开 Pi Web，即可管理 Provider 登录和 API Key、模型、模型测试、插件包及技能。
- **英文、简体中文和繁体中文界面**：Pi Web 首次打开时跟随浏览器语言，也可在「设置 → 常规 → 语言」中切换语言。
## 快速开始

Pi Web 要求 Node.js 22.19.0 或更高版本。可通过 `node --version` 检查当前版本。

**无需安装，直接运行：**

```bash
npx @agegr/pi-web@latest
```

**或全局安装后使用：**

```bash
npm install -g @agegr/pi-web
pi-web
```

启动后打开 [http://127.0.0.1:30141](http://127.0.0.1:30141)。命令行版本会在服务就绪后尝试自动打开浏览器。Pi Web 默认仅监听 `127.0.0.1`。

**可选参数：**

```bash
pi-web --port 8080              # 自定义端口
pi-web --hostname 0.0.0.0       # 在可信网络中开放访问
pi-web -p 8080 -H 0.0.0.0       # 组合使用
pi-web --no-open                # 不自动打开浏览器

PORT=8080 pi-web                # 也支持环境变量
PI_WEB_HOSTNAME=0.0.0.0 pi-web  # 显式开放网络访问
PI_WEB_ALLOWED_HOSTS=pi-web.internal pi-web  # 允许指定的代理或自定义主机名
PI_WEB_PASSWORD='足够长的随机密码' pi-web  # 启用登录页（用户名：pi）
PI_WEB_NO_OPEN=1 pi-web         # 适用于后台服务或开机自启
```

设置 `PI_WEB_PASSWORD` 后，登录页会保护 Web 界面和全部 API，用户名固定为 `pi`；未设置或值为空时关闭认证。登录成功后使用 `HttpOnly` 会话 Cookie；勾选“保持登录 30 天”时持久保存，否则仅在当前浏览器会话中有效。签名密钥保存在权限仅限当前用户的 `~/.pi/agent/pi-web-session.json`。跨网络使用时应保持访问域名不变，因为浏览器按主机隔离 Cookie。Pi Web 可以调用高权限智能体，请勿直接暴露到互联网；远程访问应使用可信反向代理提供的 HTTPS 或可信 VPN。
API 请求仅接受 loopback 名称、IP 字面量、当前监听主机名，以及 `PI_WEB_ALLOWED_HOSTS` 中以逗号分隔的精确主机名。可信反向代理使用不同的外部主机名时，请配置该变量。

## 本 fork 的预构建 Release

`sleepinginsummer/pi-web` 通过 `.github/workflows/release-package.yml` 发布包含 `.next` 的 npm `.tgz`。手动触发工作流或推送与包版本一致的 `v*-merge.*` 标签后，依次执行检查、构建、打包和独立安装验证，成功后才发布 Release。无需 npm registry 发布权限。
端口和主机名以命令行参数为准，优先于对应的环境变量。`--no-open` 与 `PI_WEB_NO_OPEN=1` 中任意一个都会关闭自动打开浏览器。运行 `pi-web --help`（或 `-h`）可打印启动选项并以退出码 0 结束，不会启动服务；未知参数会报错并以退出码 1 结束。

| 参数或环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `--help`、`-h` | 打印启动选项并退出 | — |
| `--port <端口>`、`-p <端口>` 或 `PORT` | 服务端口 | `30141` |
| `--hostname <主机>`、`-H <主机>` 或 `PI_WEB_HOSTNAME` | 监听主机名 | `127.0.0.1` |
| `--no-open` 或 `PI_WEB_NO_OPEN=1` | 不自动打开浏览器 | 自动打开 |
| `PI_WEB_APP_NAME` | PWA manifest 的 `name` 和 `short_name`；去除首尾空白，空值使用默认值 | `Pi Web` |
| `PI_WEB_SKIP_VERSION_CHECK=1` | 关闭 Pi Web 的更新检查 | 未设置 |
| `PI_WEB_ALLOWED_HOSTS` | 额外允许的代理或自定义主机名，多个值用逗号分隔，必须精确匹配 | 未设置 |
| `PI_WEB_PASSWORD` | 启用浏览器密码登录；API 客户端可使用用户名为 `pi` 的 Basic Auth | 不启用认证 |
| `PI_WEB_IDLE_TIMEOUT_MS` | 会话空闲超时，单位毫秒，最大 `2147483647`；`0` 表示不因空闲关闭会话；无效或超出范围的值使用默认值 | `600000`（10 分钟） |
| `PI_WEB_SHUTDOWN_DEADLINE_MS` | 关闭会话时留给扩展处理 `session_shutdown` 的时间，到时仍会释放会话；单位毫秒，最大 `2147483647`；`0`、无效或超出范围的值使用默认值 | `5000`（5 秒） |
| `PI_CODEMODE_MAX_WORKERS` | pi 同时运行 codemode 脚本的上限，由服务器里所有会话和 subagent 共用；pi 自身默认是 `2`，变量未设置或为空时 pi-web 设为 `8`。每个脚本最多可用 256 MB | `8` |

在启动服务前设置 `PI_WEB_APP_NAME`，例如 `PI_WEB_APP_NAME='工作 Pi' pi-web`。修改后重启服务即可提供新的 manifest，无需重新构建。已安装 PWA 的名称更新由浏览器管理，不保证立即生效；此设置不改变页面标题或图标。

例如：

```bash
gh workflow run release-package.yml --repo sleepinginsummer/pi-web --ref main
```

从 [GitHub Release](https://github.com/sleepinginsummer/pi-web/releases) 复制 `.tgz` 附件地址，在独立运行目录使用 `npm install --omit=dev <附件地址>`，再运行 `./node_modules/.bin/pi-web -H 0.0.0.0 -p 8081 --no-open`。登录和代理配置继续由环境变量提供。

macOS 安装包附带 `scripts/macos-service.sh start|stop|restart|status`，使用 `launchctl` 托管 8081 服务。默认配置文件为 `~/.local/share/pi-web-runtime/service.env`；必填 `PI_WEB_PASSWORD`，可选 `PI_WEB_ALLOWED_HOSTS` 与代理环境变量。每个版本安装到独立目录；脚本固定使用实际版本路径，避免更新覆盖正在读取的 chunk。

安装包同样提供 `pi-web version|status|stop|open` 子命令；`pi-web update` 在本 fork 中已禁用（npm 上的 `@agegr/pi-web` 是上游包），只会提示从上面的 Release 安装新版本并用 `scripts/macos-service.sh restart` 切换。


## HTTP 代理
同时开着很多活跃的会话、终端或文件预览时，明文 HTTP 下浏览器最多只有六个连接，请求会开始排队；见 [Serving Pi Web over HTTP/2](./http2.md)。

### Docker

每个版本都会向 `ghcr.io/agegr/pi-web` 发布镜像。镜像用法、Compose 示例以及需要保留哪些卷，见 [Running Pi Web in Docker](./docker.md)。

### HTTP 代理

Pi Web 的服务端模型请求和 API 请求会读取标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 环境变量。

macOS 或 Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## 功能介绍

- **把历史工作接回来**：打开网页就能按项目找到以前的 pi 对话，不必在终端里翻文件或记住会话路径。
- **放心试不同方向**：可以从某条历史消息重新开始，也可以复制出一条独立的新路线，探索方案时不怕弄乱原来的对话。
- **跨分支工作**：在侧边栏切换 Git worktree，让新会话和 Explorer 跟随你选择的 checkout。
- **边聊边看项目文件**：左侧浏览项目文件，右侧打开源码、文档、图片、音频和 PDF；文件变化会自动刷新，适合边让 agent 改边检查结果。
- **随时掌握会话状态**：在顶部就能看到上下文占用、花费、压缩结果和系统提示，长会话不再像黑箱。
- **少离开当前界面**：模型、登录/API key、模型测试和技能开关都能在网页里处理，配置 agent 时不用在多个工具之间来回切换。

## 注意事项

- **智能体数据**：Pi Web 默认读取 `~/.pi/agent` 下的 pi 数据，包括 `sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl` 中的会话文件。可通过 `PI_CODING_AGENT_DIR` 指定其他 pi agent 目录。
- **文件系统访问**：Pi Web 必须能读取智能体数据目录及会话记录中的工作目录。与现有 pi 会话共用数据时，请让 Pi Web 运行在与 pi 相同的文件系统环境中。
- **共享配置**：模型面板使用 pi 的模型、设置和凭据存储，因此两种界面都能看到相关更改。已打开的会话要再次选择该模型，才会应用保存后的模型修改。
- **文件访问边界**：文件浏览器仅能访问在 Pi Web 中选择过的工作目录，以及它已识别的项目或会话根目录；它不是通用的文件系统浏览器。
- **Git worktree**：切换器何时显示、如何创建 worktree，以及删除会产生什么影响，见 [Pi Web 里的 Worktree](./worktrees.zh-CN.md)。
- **集成接口**：嵌入 Pi Web 的应用可以替换会话行的右键菜单，服务端的 pi 扩展可以让会话不因空闲被关闭；见 [Integration Hooks](./integrations.md)。

## 开发

```bash
npm install
npm run dev
```

本地开发端口为 [http://127.0.0.1:30141](http://127.0.0.1:30141)。

常用检查：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

开发时不要运行 `next build` / `npm run build`，它会写入 `.next/`，容易影响正在运行的 dev server。发布流程再执行构建。

开始做新功能之前，请先阅读[参与贡献](./CONTRIBUTING.zh-CN.md)，了解哪些改动在范围内以及提交 PR 前的检查项。

贡献者文档：[国际化](./i18n.md)和[发布流程](./release.md)。

```

架构说明、API 路由和专题笔记见 [AGENTS.md](../AGENTS.md)。

## 许可证

[MIT](../LICENSE)
