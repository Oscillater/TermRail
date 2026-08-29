# TermRail

[English](README.md)

<p align="center">
  <img src="web/public/assets/termrail-icon.png" alt="TermRail logo" width="160" />
</p>

TermRail 是一个本地终端会话管理工具。它在浏览器里提供界面，后端通过 PTY 启动真实的 shell。

在使用 Coding Agent 并行推进多个项目时，开发者通常需要为不同项目维持多条长期运行的 shell 命令，例如项目 shell、开发服务器、Codex、Claude Code 或测试命令。TermRail 将这些命令组织为可保存、可切换的会话，并在本地浏览器中统一管理它们的启动、交互和输出查看。

当前版本主要面向本地开发环境使用。

![TermRail 截图](web/public/assets/termrail-screenshot.png)

## 功能

- 管理多个终端会话（项目）。
- 每个会话可以有多个终端标签页。
- 支持交互式终端输入和输出。
- 切换会话后，当前运行期间的终端输出会保留。
- 后台会话有新输出时，会显示 `Working`、`Quiet` 或 `Stopped` 状态。
- 内置 prompt library，支持复制、插入到终端、直接发送。
- 可以从界面里选择本地工作目录。
- 左右侧栏可以收起。
- 可以通过 auth token 保护本地 HTTP API 和 WebSocket。

## 环境要求

- Windows、macOS 或 Linux。
- Node.js `18.x`、`20.x` 或 `22+`。
- npm。
- Windows 上如果 `node-pty` 没有可用的预构建包，可能需要安装 Visual Studio C++ build tools。

## 快速开始

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

脚本会检查 Node.js 和 npm。如果还没有安装依赖，它会先安装依赖，然后启动后端和 Vite UI，并打开浏览器。

### 手动启动

```powershell
npm install
npm start
```

开发模式会启动两个本地服务：

| 服务                     | 地址                    |
| ------------------------ | ----------------------- |
| UI                       | `http://127.0.0.1:5173` |
| Backend API 和 WebSocket | `http://127.0.0.1:8787` |

开发环境下，Vite 会把 `/api` 和 `/ws` 转发到后端。

## 会话配置

打开 UI 后点击 **Add**，创建一个会话。

| 字段        | 说明                                                    |
| ----------- | ------------------------------------------------------- |
| `id`        | 稳定的会话 id，API 和 WebSocket 都会用到。              |
| `name`      | 界面里显示的名称。                                      |
| `cwd`       | 命令运行时使用的工作目录。                              |
| `command`   | 默认命令；旧 start 接口和新建标签页都会使用它。         |
| `terminals` | 这个会话下的终端标签页，每个标签页都有 id、名称和命令。 |
| `prompts`   | 为兼容旧配置保留；当前界面使用全局 prompt library。     |

示例：

```json
{
  "id": "my-project-codex",
  "name": "My Project Codex",
  "cwd": "D:\\Project\\my-project",
  "command": "codex resume",
  "terminals": [
    {
      "id": "main",
      "name": "Main",
      "command": "codex resume"
    },
    {
      "id": "server",
      "name": "Dev Server",
      "command": "npm run dev"
    }
  ],
  "prompts": []
}
```

`cwd` 可以是绝对路径，也可以是相对于仓库根目录的路径。

## 配置文件

运行时配置保存在 `data/config.json`。这个文件会被 Git 忽略，因为里面通常会包含本机路径和个人命令。

没有配置文件时，应用会自动创建空配置：

```json
{
  "prompts": [],
  "sessions": []
}
```

仓库里的 `data/config.example.json` 是安全示例，也会被 smoke test 使用。可以复制它来快速试运行：

```powershell
Copy-Item data/config.example.json data/config.json
```

## 环境变量

| 变量              | 默认值                        | 说明                                 |
| ----------------- | ----------------------------- | ------------------------------------ |
| `HOST`            | `127.0.0.1`                   | 后端监听地址。                       |
| `PORT`            | `8787`                        | 后端端口。                           |
| `AUTH_TOKEN`      | 空                            | HTTP API 和 WebSocket 使用的 token。 |
| `CONFIG_PATH`     | `data/config.json`            | 自定义运行时配置文件路径。           |
| `TERMRAIL_SHELL`  | Windows 上为 `powershell.exe` | 后端启动 PTY 时使用的 shell。        |
| `VITE_AUTH_TOKEN` | 空                            | 手动启动 Vite 时前端使用的 token。   |

如果使用 `start.ps1`，只需要设置 `AUTH_TOKEN`。脚本会在启动 UI 前把它同步到 `VITE_AUTH_TOKEN`。

## 安全说明

TermRail 会按保存的配置启动本地命令。能访问 TermRail，基本就等于能操作你的本地 shell。

- 后端默认只监听 `127.0.0.1`。
- 运行时配置保存在本地 `data/config.json`。
- `data/config.json`、`.env` 和日志文件都会被 Git 忽略。
- 目录浏览接口只按可信本地环境设计。
- 如果要监听 localhost 以外的地址，请先设置 `AUTH_TOKEN`。
- 远程访问建议放在 Tailscale 或其他 VPN 后面。

## API

设置 `AUTH_TOKEN` 后，可以用以下任一方式认证：

- `Authorization: Bearer <token>`
- `x-auth-token: <token>`
- `?token=<token>`

常用 HTTP 接口：

| Method   | Path                                            |
| -------- | ----------------------------------------------- |
| `GET`    | `/api/sessions`                                 |
| `POST`   | `/api/sessions`                                 |
| `PATCH`  | `/api/sessions/:id`                             |
| `DELETE` | `/api/sessions/:id`                             |
| `POST`   | `/api/sessions/:id/start`                       |
| `POST`   | `/api/sessions/:id/stop`                        |
| `GET`    | `/api/sessions/:id/terminals`                   |
| `POST`   | `/api/sessions/:id/terminals`                   |
| `POST`   | `/api/sessions/:id/terminals/:terminalId/start` |
| `POST`   | `/api/sessions/:id/terminals/:terminalId/stop`  |
| `DELETE` | `/api/sessions/:id/terminals/:terminalId`       |
| `GET`    | `/api/status`                                   |
| `GET`    | `/api/filesystem/roots`                         |
| `GET`    | `/api/filesystem/directories?path=<folder>`     |

WebSocket 连接地址是 `/ws`。

客户端消息示例：

```json
{
  "type": "subscribe",
  "sessionId": "my-project-codex",
  "terminalId": "main",
  "includeBuffer": true
}
```

```json
{
  "type": "input",
  "sessionId": "my-project-codex",
  "terminalId": "main",
  "data": "hello\r"
}
```

```json
{
  "type": "resize",
  "sessionId": "my-project-codex",
  "terminalId": "main",
  "cols": 120,
  "rows": 32
}
```

服务端消息包括 `subscribed`、`unsubscribed`、`terminal.output`、`terminal.status`、`session.status` 和 `error`。

## 开发

```powershell
npm run dev
```

常用检查：

```powershell
npm run check
npm run format:check
npm run smoke --workspace server
```

Smoke test 会在 `127.0.0.1:8797` 启动一个临时后端，加载 `data/config.example.json`，通过 WebSocket 订阅终端，启动 `node -v` 会话，并检查 PTY 输出。

项目结构：

```text
server/   Express API, WebSocket server, PTY session manager
shared/   Shared TypeScript types and constants
web/      Vite, React, xterm.js terminal UI
data/     Example config and local runtime config location
```

## 已知问题

- 还没有首次配置向导。没有会话时，可以在 UI 里点 **Add**，也可以把 `data/config.example.json` 复制成 `data/config.json`。
- 终端 buffer 只在后端进程运行期间保留；持久化 transcript、搜索和导出还没有实现。

## 故障排查

- UI 能打开，但会话加载失败：确认后端是否运行在 `127.0.0.1:8787`。
- `node-pty` 安装失败：Windows 上安装 Visual Studio C++ build tools，或换用受支持的 Node.js 版本。
- 手动启动且开启了认证：运行 `npm start` 前，同时设置 `AUTH_TOKEN` 和 `VITE_AUTH_TOKEN`。
- TUI 尺寸不对：点击终端标题栏里的 **Fit**。

## 后续计划

- 评估桌面端打包或安装包分发，让 TermRail 不依赖手动启动本地开发服务。
- 根据实际使用情况继续改进会话创建、历史输出和导出能力。
