# dsh-session-rotate

DeepSeek Harness 会话自动轮换插件：**上下文过大时自动生成交接清单 → 新建会话 → 注入清单 → 归档旧会话**，并输出 **Token 消耗审计报告（TOP 3 原因）**。专治长对话 token 爆炸。

## 为什么需要它

DSH 长会话的 token 大头是**上下文累积**：每轮模型请求都要重新发送整个历史，会话越长单轮越贵。主会话曾膨胀到 13.3MB、单次请求 43 万 token。

本插件的方案是**勤轮换**：会话文本达到阈值（默认 200 万字符）时，自动触发一次"交接班"——把当前会话的要点沉淀成清单，开一个新会话带着清单继续，旧会话归档（历史仍在，可查）。

## 功能

### 1. 会话自动轮换
- **检测**：实时累计每个会话的用户/助手消息文本字符数（基线用 `tokenMeter` 估算存量）
- **触发**：达到阈值（`2,000,000` 字符，可改源码常量）→ 向该会话注入一条提醒
- **交接**：agent 收到提醒后生成交接清单文件（项目目标/进度/决策/待办），调用 `session_rotate` 工具
- **轮换**：插件自动完成 —— 新建会话（继承工作区 + agent 预设）→ 清单注入为新会话首条消息 → 标题标记 `🔄 轮换自…` → 约 1 分钟后归档旧会话（等总结回复可见）
- **防抖**：同一会话 24 小时内不重复提醒

### 2. Token 审计（每个 2M 对话结束时）
轮换时自动分析旧会话事件流，输出 **TOP 3 token 消耗原因**（估算 token = 字符数 ÷ 2）：
1. **工具调用与结果**（含 `tool/result` 事件，读文件/grep/目录列举的大输出）
2. **思考链 reasoning**
3. **记忆/系统上下文注入**（MNEMON、运行时上下文等自动注入）
4. 助手回复正文 / 用户输入
- 附 **上下文重发成本** 警告：`轮数 × 当前上下文 ≈ 累计 token`（这是最大开销，轮换后清零）
- 审计报告写入 `D:\DeepSeek harness\handoff\audit-<时间>.md`，并随工具返回值展示给用户

## 安装

```bash
# 1. 克隆/构建插件包，然后运行时注入（免重启）
dsh inject /path/to/dsh-session-rotate

# 2. 持久化：在 profile 的 cordis.patch.yml 追加
# - id: session-rotate
#   name: '@dsh-local/session-rotate'
```

## 使用

无需手动操作，达到阈值自动触发。也可随时让 agent 执行：**"轮换会话"**（agent 会先写清单再调 `session_rotate` 工具）。

### session_rotate 工具参数
| 参数 | 必填 | 说明 |
|---|---|---|
| `handoffPath` | ✅ | 交接清单文件绝对路径（须已由 write 工具写入） |
| `newTitle` | ❌ | 新会话标题（默认 `🔄 轮换自<旧标题>`） |

### 状态端点
```
GET /session-rotate/status
```
返回各会话当前字符数、是否超阈值、轮换历史（含审计统计）。

## 原理

```
阈值检测(事件流累计) → 注入提醒 → agent 写清单 → session_rotate 工具
  → sessions.create(继承 cwd/preset) → 清单注入新会话 → sessionTitle.rename
  → 延迟 archiveSession(旧) → 审计报告(TOP3 token 消耗原因)
```

关键 API（均已实测）：
- `tokenMeter.measure(session)` — 上下文 token 估算
- `apiProxy.events.mux` — 消息事件流（累计字符）
- `ctx.sessions.create(id?, {meta})` — 新建会话（`session/created` 自动广播到 UI/手机壳）
- `apiProxy.sessions.prompt` — 注入清单消息
- `ctx.workspaceRegistry.archiveSession(id)` — 归档旧会话（jsonl 保留可恢复）
- `ctx.sessionQuery.readSession(id)` — 全量事件（审计统计源）

## 审计统计口径（真实事件结构）

| 事件 | 计入 |
|---|---|
| `user/message` content 块 | 用户输入（系统注入前缀 → 记忆/系统注入） |
| `assistant/message` content 块 | 回复正文 / 思考链 / 工具调用参数 |
| `tool/result` → `data.message.content` 块 | 工具结果（独立事件，大输出大头） |

## 已知限制
- 阈值目前是源码常量（`THRESHOLD_CHARS`），未做设置页；改源码后 `dev_reload_package` 热重载生效
- 审计为字符启发式估算，非 API 真实计费（真实用量看 token-meter 的 usage 字段）
- 归档延迟 60s（等 agent 总结回复被看到）
- 冷会话（未加载）不监控增量，只在内存活动会话上累计

## 开发

```bash
# 改动 lib/index.js 后热重载
dsh reload dsh-session-rotate
```

## License

MIT
