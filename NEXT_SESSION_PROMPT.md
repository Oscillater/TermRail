# Next Session Prompt

我们要继续实现 Codex Switchboard。请先阅读 `TODO.md`、`README.md` 和现有代码，严格延续当前范围，不要实现看板、Git UI、文件浏览器、MCP、Codex app-server、多 agent、项目状态管理等非目标功能。

本 session 的目标：实现最小浏览器 terminal UI，把现有后端 API 和 WebSocket 接起来，让浏览器里可以启动、停止、切换并操作已配置的 session。

## 范围

1. 前端基础 UI
   - 使用现有 `web/` Vite + React + TypeScript。
   - 加入 xterm.js。
   - 页面分三块：
     - 左侧 session 列表。
     - 中间 terminal。
     - 右侧 prompt examples 占位区。
   - 不做复杂设计系统，不引入重型状态管理。

2. Session 列表
   - 调用 `GET /api/sessions`。
   - 显示 session name、running / stopped 状态。
   - 支持选择当前 session。
   - 支持启动和停止当前 session：
     - `POST /api/sessions/:id/start`
     - `POST /api/sessions/:id/stop`
   - 暂时不实现新增/编辑 session 表单；如果需要测试，可手动改 `data/config.json`。

3. Terminal
   - 当前 session 选中后，通过 WebSocket 发送：
     - `{ "type": "subscribe", "sessionId": "<id>" }`
   - 收到 `subscribed` 时，把返回的 `buffer` 写入 terminal。
   - 收到 `terminal.output` 时写入 xterm。
   - 用户在 xterm 输入时，通过 WebSocket 发送：
     - `{ "type": "input", "sessionId": "<id>", "data": "<data>" }`
   - 支持 resize：
     - 使用 xterm fit addon。
     - resize 后发送 `{ "type": "resize", "sessionId": "<id>", "cols": n, "rows": n }`。

4. WebSocket
   - 连接默认 `ws://127.0.0.1:8787/ws`。
   - HTTP API 默认 `http://127.0.0.1:8787`。
   - 为未来 `AUTH_TOKEN` 预留简单配置入口即可，不需要做完整登录 UI。
   - 连接断开时显示明确状态，不要静默失败。

5. Prompt examples
   - 右侧只显示当前 session 的 prompts。
   - 本 session 暂时只做只读展示和占位按钮状态。
   - 不实现 prompt 增删改、Copy / Insert / Send；留到下一 session。

6. 验证
   - 用 `data/config.example.json` 或手动复制到 `data/config.json` 验证。
   - 至少验证 `test-node-version` 能从浏览器启动，并在 terminal 中看到输出。
   - 运行：
     - `npm run check`
     - `npm run build`
   - 如果启动 dev server，请给出浏览器访问地址。

## 明确不要做

- 不实现 session 新增/编辑 UI。
- 不实现 prompt examples 编辑或发送。
- 不实现未读 badge。
- 不实现浏览器通知。
- 不接真实 Codex 特殊 API；只通过 PTY 运行 session config 里的 command。
- 不新增后端任意命令执行接口。

完成后更新 `TODO.md` 的勾选状态，并总结：

- 实现了哪些 UI 和协议连接。
- 如何启动后端和前端。
- 如何手动准备测试 config。
- 下一 session 应该做什么。
