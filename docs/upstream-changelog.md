# 上游变更追踪

本文档记录 fork 之后原仓库 (`lidge-jun/opencodex`) 的功能变化，增量维护。
每次 `git fetch upstream` 后只需补充新增部分，不必全量重查。

- fork 基线: `b9b73f71` (2026-07-21 08:59 +0800)
- 上游指针: `9e68ed67` (截至 2026-07-23 检查)
- 查看新增提交: `git log 9e68ed67..upstream/main --oneline`

---

## v2.7.28 → v2.7.33 (2026-07-20 ~ 2026-07-22)

上游在 fork 基线后推送了 132 个提交，覆盖以下版本。

### 新提供方与模型

- **Cloudflare Workers AI** 提供方 (#191)
- **OrcaRouter** — OpenAI 兼容自适应路由器，含 reasoning/temperature 修正和自命名路由修复
- **alibaba-token-plan-intl** — 阿里国际版令牌套餐，补充 qwen3.8-max-preview 等模型
- **Gemini 3.6 Flash** — 多档位上线，含价格清单和能力感知注入
- **gemini-3.5-flash-lite** 加入 catalog
- **Antigravity (Gemini) effort routing** — 把 effort 变体折叠为基础模型 ID，通过 thinkingConfig 控制推理强度
- **Claude Sonnet 4.6** — 通过 Anthropic adaptive thinking 接入 effort 控制
- **自定义模型管理** — `ocx models add/remove/list-custom`，合并进 catalog，GUI 有 chip 标签和 hover 弹窗
- **OpenRouter 可配置提供方路由** (#235)

### CLI 账号管理 (#180 系列)

- 新增 `ocx account list|current|use|refresh|auto-switch|remove|add-key` 子命令，实现 GUI 和 CLI 凭证对等
- 加密标签脱敏、错误传播拆分 API 层、help 文面与实际一致化

### GUI 与信息架构

- **Combo → Models**: Combo 从侧栏移除，在 Models 页面内嵌摘要区 (`1d8f03e2`)
- **Debug → Logs**: Debug 从侧栏移除，改为 Logs 页面的 tab，hash `#logs/debug` (`e5c5169c`)
- 提供方 Usage 页面新增每个模型的费用拆解
- 提供方错误展示和费用预估优化 (#181, #198)
- Accounts 标签移除不可操作的 API-key 行 (#231)
- Codex-auth modal 修复渲染期 ref 访问

### OAuth 与认证修复

- Anthropic OAuth 刷新生成安全化、结构化 token 错误、防 stale-lock replay (#209)
- 无头环境手动粘贴 redirect-URL/code 添加 Codex 账号 (#183)
- Kiro 登录流程优先于 manual paste 阻塞 (#232)
- 中途连接重置重新归类为瞬态错误，加入账号冷却和亲和度诊断 (#186)
- 软避免池亲和度语义终端状态重做 (#205)

### Cursor 相关

- Cursor 序列化工具目录体积限制 (#190)
- Cursor context-usage 在工具轮次间携带和加固 (#274)
- Cursor effort metadata 不变量修复 (#202)

### 可靠性修复

- 启动端口 hard-pin、保留 port=0 临时端口 (#193)
- `ocx stop/start` 后恢复 GUI 请求日志 (#195)
- Windows 服务生命周期三态守卫和 locale 安全检测 (#216, #199)
- 更新回退: 服务重装失败时直接启动 proxy (#227)
- 迁移备份不再无条件删除，改为保留有效回滚快照
- Combo 子请求去除 content-encoding 后再序列化 (#230)
- v1 compact 端点 reasoning content 净化 (#248)
- Kimi / Antigravity 工具 schema 去重 required 字段 (#250, #251)
- prompt_cache_key 透传至 openai-chat adapter (#217, #224)
- 配置迁移备份替换而非崩溃 (#258)
- Reasoning effort clamp 到已安装二进制的梯度

### 国际化

- 新增 **俄语 (ru)** 全量本地化 (#207)，含后续 13 个缺失 key 补全
- 新增 **日语 (ja)** 全量本地化 (#244)
- RU parity 补全与 dev en.ts 对齐 (#211)

### 治理与 CI

- CodeRabbit 配置、AGENTS.md 和分支策略文档
- PR 必须以 dev 为目标分支 (#204)
- issue 最小质量检查、错误分支重定向后 ping 作者 (#229)
- 隐私扫描允许 test-fixture sk- 哨兵值

### 其他

- Devlog 工作流归档整理
- 文档维护者与审查归属 (#264)
- ocx init 提示语改进、默认提供方选择 UX (#262)
- 提供方未配置时路由错误信息改进

---

## 维护说明

每次 `git fetch upstream` 后：

1. 运行 `git log 9e68ed67..upstream/main --oneline`（用文档顶部记录的指针替换哈希）
2. 将新增提交按上述分类追加到对应版本段落
3. 更新文档顶部的上游指针哈希
4. 标记哪些功能值得选择性 cherry-pick，哪些与 fork 方向无关可忽略
