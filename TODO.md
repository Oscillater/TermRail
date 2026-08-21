# TermRail TODO

## 进度

- [x] Session 1：项目骨架 + 后端基础能力。
- [x] Session 2：最小浏览器 terminal UI，接上 session 列表、启动/停止、WebSocket 输入输出。
- [x] Session 3：session 编辑 UI + prompt examples 的增删改、Copy / Insert / Send。
- [x] Session 4：输出活动状态、停止提示、交互打磨和第一版可用性验证。
- [ ] Session 5：一键启动、README、发布到 GitHub 的基础整理。
- [ ] Session 6：首次配置向导，让不熟 npm 的用户也能创建可用 session。
- [ ] Session 7：Transcript / Log 视图，补齐 terminal 历史回看、搜索、复制和导出。

第一版本地自用已经可用。下一阶段目标是把它从“开发者本机能跑”推进到“别人 clone 后也能稳定使用”，预计还需要 **3 个 sessions**。

## 目标

做一个极简的本地 Web 工具，用来在多个 Codex session 之间切换，而不是做项目管理。

它要替代一堆散落的 PowerShell 窗口，提供一个浏览器界面来完成：

- 启动已配置的 Codex session
- 在多个 live terminal 之间切换
- 显示 agent 输出活动和停止提示
- 保存全局 prompt examples，并在多个 sessions 之间共享
- 复制、插入或直接发送 prompt examples

## 非目标

- 不做看板
- 不追踪项目状态
- 不做任务管理
- 不做 Git UI
- 不做文件浏览器
- 不接 MCP
- 不接 Codex app-server
- 不做 multi-agent 编排
- 不自动理解项目进度
- 不做云同步

## 技术栈

- 前端：Vite + React + TypeScript
- 终端 UI：xterm.js
- 后端：Node.js + TypeScript
- HTTP server：Fastify 或 Express
- 实时通信：WebSocket
- PTY runner：node-pty
- 存储：先用 JSON 文件；除非后面真的需要，否则不上 SQLite

## 数据模型

### Session

```ts
type SessionConfig = {
  id: string;
  name: string;
  cwd: string;
  command: string;
  prompts: PromptExample[];
};
```

说明：`session.prompts` 保留为兼容旧配置；当前 UI 使用顶层全局 prompt library。

### App Config

```ts
type AppConfig = {
  sessions: SessionConfig[];
  prompts: PromptExample[];
};
```

### Prompt Example

```ts
type PromptExample = {
  id: string;
  title: string;
  text: string;
};
```

## MVP

### 1. 项目初始化

- [x] 建一个简单的两目录结构：
  - [x] `server/`
  - [x] `web/`
- [x] 配好 TypeScript。
- [x] 添加 lint 和 format 脚本。
- [x] 添加一个 dev 脚本，同时启动后端和前端。

### 2. 配置存储

- [x] 把 session 配置存到 `data/config.json`。
- [x] server 启动时读取配置。
- [x] session 或 prompt 编辑后保存配置。
- [x] 校验必要字段：
  - [x] `id`
  - [x] `name`
  - [x] `cwd`
  - [x] `command`
  - [x] `prompts`

### 3. Session 管理

- [x] API：列出已配置的 sessions。
- [x] API：创建、编辑、删除 session 配置。
- [x] API：启动 session。
- [x] API：停止 session。
- [x] 每个 active session 最多保留一个 PTY 进程。
- [x] 防止同一个 session 重复启动多个 PTY。
- [x] 每个 session command 都在它自己的 `cwd` 中运行。

### 4. Terminal 流式通信

- [x] 用 `node-pty` 启动配置好的 command。
- [x] 用 WebSocket 把 PTY 输出流式传给前端。
- [x] 把前端输入写回 PTY。
- [x] 浏览器 terminal resize 时，同步 resize PTY。
- [x] 启动 PTY 时使用浏览器当前 terminal 尺寸，减少 TUI 首屏错乱。
- [x] 为 Codex resume / TUI 场景提供手动 Fit 尺寸重算操作。
- [x] terminal 有选区时 `Ctrl+C` 复制文本；无选区时仍发送中断。
- [x] terminal 聚焦时 `Ctrl+V` 粘贴剪贴板内容。
- [x] 多个 running session 输出时，左侧 activity / session 列表保持稳定，不随输出包频繁跳动。
- [x] 未点开的 running session 也在 Activity 中显示稳定状态。
- [x] server 运行期间，为每个 active session 保留 terminal buffer。
- [x] 增大前端 scrollback 和后端 terminal buffer，改善历史回看。

### 5. 前端布局

- [x] 左侧：session 列表。
- [x] 中间：xterm.js terminal。
- [x] 右侧：prompt examples。
- [x] 添加 session 按钮。
- [x] 编辑 session 按钮。
- [x] session 表单支持浏览并选择本机文件夹作为 `cwd`。
- [x] 启动/停止状态指示。
- [x] session 的输出活动状态 badge。
- [x] 保持桌面三列固定窗口布局，窄窗口下允许页面滚动，不恢复移动端深度打磨。
- [x] 放大页面时 session / prompt 卡片不被 flex 压扁。

### 6. Prompt Examples

- [x] 全局 prompt list 初始为空。
- [x] UI 支持添加、编辑、删除 prompt examples。
- [x] 未保存的 prompt 表单草稿缓存在浏览器本地 JSON 中。
- [x] 每条 prompt 支持三个操作：
  - [x] `Copy`：复制到剪贴板。
  - [x] `Insert`：插入到当前 terminal 输入区。
  - [x] `Send`：发送文本并追加换行到当前 Codex session。

### 7. 输出活动状态

- [x] 前端记录当前选中的 active session。
- [x] session 收到输出时标记为 `Working`。
- [x] 输出安静一小段时间后标记为 `Quiet`。
- [x] 进程从 running 变 stopped 时标记为 `Stopped`。
- [x] 切换到该 session 时清空活动提示。

### 8. 面板内活动提示

- [x] 不请求浏览器通知权限。
- [x] Activity 区域列出 `Working` / `Quiet` / `Stopped` sessions。
- [x] `Working` 保持低调，`Quiet` / `Stopped` 作为回看提示。
- [x] 不弹出系统/浏览器通知。

### 9. 安全边界

- [x] 后端默认只监听 `127.0.0.1`。
- [x] 为远程访问添加可选 auth token。
- [x] 不提供任意 shell command 执行 API。
- [x] 只运行 session config 中保存的 command。
- [x] 如果 bind address 不是 localhost，在 UI 或日志里给出警告。
- [x] 推荐用 Tailscale 或局域网访问，不建议直接暴露到公网。

## 第一版可用标准

- [x] 我可以手动添加三个 Codex sessions。
- [x] 我可以从浏览器启动每个 session。
- [x] 我可以在 live terminals 之间切换。
- [x] 我可以向当前 Codex session 输入内容。
- [x] 我可以手动添加 prompt examples。
- [x] 我可以把保存的 prompt 发送给当前 session。
- [x] agent 有输出时，我能看到低调的 `Working` 状态。
- [x] agent 输出停止或进程停止时，我能在面板里看到轻量提示。

## 下一阶段：可分发的桌面产品体验

### Session 5：一键启动和 README

- [x] 定正式项目名，替换 README / package / UI 中仍偏实验性的命名。
- [x] 写清楚项目定位：本地 session switcher，不是任务管理器，不暴露任意命令执行 API。
- [ ] 更新 README：
  - [ ] 功能截图（等界面继续稳定后再补）。
  - [x] 安装要求。
  - [x] 快速启动。
  - [x] 配置示例。
  - [x] 安全边界。
  - [x] 常见问题。
- [x] 提供 Windows 一键启动脚本：
  - [x] 检查 Node.js / npm 是否可用。
  - [x] 缺少依赖时自动 `npm install`。
  - [x] 启动 server 和 web。
  - [x] 自动打开浏览器。
  - [x] 失败时输出可读错误。
- [x] 提供普通用户可理解的 `data/config.example.json`。
- [x] 补充 GitHub 发布前检查：
  - [x] `.gitignore` 确认不会提交本地私有 config。
  - [x] README 说明 `data/config.json` 是本机私有配置。
  - [x] 确认默认只监听 localhost。

### Session 6：首次配置向导

- [ ] 首次无 sessions 时显示配置向导，而不是空列表。
- [ ] 支持从 UI 创建常见 session 模板：
  - [ ] Codex resume。
  - [ ] Claude Code。
  - [ ] 普通 shell command。
- [ ] 支持选择项目目录作为 `cwd`。
- [ ] 对 command / cwd / id 做即时校验。
- [ ] 保存后自动选中新 session。
- [ ] 给出“创建后可直接 Start”的清晰流程。
- [ ] 避免用户必须手写 JSON 才能开始使用。

### Session 7：Transcript / Log 视图

- [ ] 为每个 session 保留纯文本 transcript。
- [ ] terminal 保持交互；transcript 专门用于回看历史。
- [ ] UI 支持：
  - [ ] 搜索。
  - [ ] 复制选中片段。
  - [ ] 清空当前 transcript。
  - [ ] 导出为 `.txt` 或 `.md`。
- [ ] session 切换后 transcript 能恢复。
- [ ] 长输出下 transcript 不明显拖慢 terminal 渲染。
- [ ] 明确说明 TUI alternate screen 和普通 scrollback 的区别。

## 后续想法

- 应用启动时自动启动指定 sessions。
- session 分组或标签。
- prompt examples 分组、搜索和导入/导出。
- 配置导入/导出。
- 更好的手机端布局。
- PWA install 支持。
- 接入 ntfy、Telegram 或 Bark 通知。
- 需要时换成 SQLite 存储。
- 从 terminal 输出中粗略识别“等待输入”状态。
- 用启发式规则识别“任务完成”状态。
- 扫描已有 Codex sessions。
- 一键 `codex resume --last` 辅助入口。
