# Codex Switchboard TODO

## 进度

- [x] Session 1：项目骨架 + 后端基础能力。
- [ ] Session 2：最小浏览器 terminal UI，接上 session 列表、启动/停止、WebSocket 输入输出。
- [ ] Session 3：session 编辑 UI + prompt examples 的增删改、Copy / Insert / Send。
- [ ] Session 4：未读 badge、浏览器通知、交互打磨和第一版可用性验证。

估计还需要 **3 个 session** 做到第一版可用；如果想把交互、错误状态、移动端和真实 Codex CLI 场景打磨得更稳，按 **4 个 session** 预留更合理。

## 目标

做一个极简的本地 Web 工具，用来在多个 Codex session 之间切换，而不是做项目管理。

它要替代一堆散落的 PowerShell 窗口，提供一个浏览器界面来完成：

- 启动已配置的 Codex session
- 在多个 live terminal 之间切换
- 显示未读输出
- 保存每个 session 自己的 prompt examples
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
- [x] server 运行期间，为每个 active session 保留 terminal buffer。

### 5. 前端布局

- [ ] 左侧：session 列表。
- [ ] 中间：xterm.js terminal。
- [ ] 右侧：prompt examples。
- [ ] 添加 session 按钮。
- [ ] 编辑 session 按钮。
- [ ] 启动/停止状态指示。
- [ ] inactive session 的未读 badge。

### 6. Prompt Examples

- [x] 每个 session 的 prompt list 初始为空。
- [ ] UI 支持添加、编辑、删除 prompt examples。
- [ ] 每条 prompt 支持三个操作：
  - [ ] `Copy`：复制到剪贴板。
  - [ ] `Insert`：插入到当前 terminal 输入区。
  - [ ] `Send`：发送文本并追加换行到当前 Codex session。

### 7. 未读输出

- [ ] 前端记录当前选中的 active session。
- [ ] inactive session 收到输出时：
  - [ ] 未读数加一
  - [ ] 在左侧 sidebar 显示 badge
- [ ] 切换到该 session 时清空未读数。

### 8. 通知

- [ ] 请求浏览器通知权限。
- [ ] inactive session 收到输出时：
  - [ ] 显示浏览器通知
- [ ] 添加开关：启用/关闭通知。
- [ ] 通知文案保持极简：
  - [ ] `<session name> has new output`

### 9. 安全边界

- [x] 后端默认只监听 `127.0.0.1`。
- [x] 为远程访问添加可选 auth token。
- [x] 不提供任意 shell command 执行 API。
- [x] 只运行 session config 中保存的 command。
- [x] 如果 bind address 不是 localhost，在 UI 或日志里给出警告。
- [ ] 推荐用 Tailscale 或局域网访问，不建议直接暴露到公网。

## 第一版可用标准

- [x] 我可以手动添加三个 Codex sessions。
- [ ] 我可以从浏览器启动每个 session。
- [ ] 我可以在 live terminals 之间切换。
- [ ] 我可以向当前 Codex session 输入内容。
- [ ] 我可以手动添加 prompt examples。
- [ ] 我可以把保存的 prompt 发送给当前 session。
- [ ] 其他 session 有输出时，我能看到未读 badge。
- [ ] inactive session 有输出时，我能收到浏览器通知。

## 后续想法

- 应用启动时自动启动指定 sessions。
- session 分组或标签。
- 全局 prompt examples，在多个 sessions 之间共享。
- 配置导入/导出。
- 更好的手机端布局。
- PWA install 支持。
- 接入 ntfy、Telegram 或 Bark 通知。
- 需要时换成 SQLite 存储。
- 从 terminal 输出中粗略识别“等待输入”状态。
- 用启发式规则识别“任务完成”状态。
- 扫描已有 Codex sessions。
- 一键 `codex resume --last` 辅助入口。
