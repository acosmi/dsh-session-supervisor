# dsh-session-supervisor

面向活跃 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 会话的、可持久、有预算的生命周期监督插件。

> **开发者预览 · 社区插件。** DeepSeek Harness 尚在预发布，兼容性可能随时破坏。
> 本项目**不是** DeepSeek 官方产品：不存在官方背书、审核或商店收录。
> 兼容版本按发布逐个锁定于 [docs/compatibility.md](docs/compatibility.md)；**不要裸装 `latest`**。

## 它做什么

用户对一个 root Agent 会话声明明确的监督契约：

- `lifecycle_silence` —— 连续 N 秒没有任何符合定义的 durable 生命周期事件；
- `deadline_unclosed` —— 绝对 RFC 3339 截止时间已过、Guard 仍未关闭；
- `abnormal_turn_streak` —— 连续 K 个 `turn/end` 以
  `error` / `blocked` / `max-tokens` / `interrupted` 结束。

当策略首次越界并在确认窗口内持续成立时，插件形成一个可持久 **incident**，
记录有界证据，并在配置允许时向 owner 会话排队**至多一次** follow-up。
`completed` 轮次与新鲜活动是恢复证据；acknowledge 与 resolve 是显式且可审计的。

插件**只观察、只通知**：不执行 shell、不发网络请求、不重试你的工具、不 cancel
你的 Agent。「时间到了」不构成任何授权。

## 硬限制（安装前必读）

- **宿主生命周期**：计时只在 harness 进程存活期间进行；插件无法监督冷会话，也不会唤醒机器。
- **冷会话**：resume 时 silence 重新锚定；已逾期的 deadline 在 resume 时合并为单个 incident。
- **at-least-once 投递**：在「排队 follow-up」与「持久化收据」之间崩溃，可能重复一次通知；
  每条通知携带同一个稳定 incident id，模型与 UI 可据此去重。
- **挂死的 Agent 无法被本插件救回**：owner 永久不结束则 follow-up 排队而无人消费；
  插件不会 cancel Agent（未来若要自动取消，须另行立项做独立安全 RFC 与显式 opt-in）。
- **会话日志零污染**：v1 不向会话日志写任何事件；插件状态位于
  `$DSH_HOME/plugins/session-supervisor/`，随时可卸载，不影响会话恢复。
- **单宿主、单进程**：无多宿主协调或选主。

## 安装

预构建 tarball（推荐，无安装期脚本）：

```bash
dsh plugin --profile <name> add <tarball路径.tgz>
# 验证：
dsh --profile <name> --dump-config
```

npm 发布后：

```bash
dsh plugin --profile <name> add @<publisher>/dsh-session-supervisor@0.1.0-beta.1
```

bundle 贡献 `dsh-session-supervisor` 行。后层 profile 会**整对象替换**其
`config`（不做深合并）——请复制下面的完整示例。

## 配置

```yaml
# 写入 profile 的 cordis.patch.yml（完整对象，非合并）：
- id: dsh-session-supervisor
  config:
    enabled: true
    minSilenceSeconds: 60
    maxGuardsPerSession: 16
    maxPoliciesPerGuard: 8
    maxLabelBytes: 240
    confirmationSeconds: 60
    recoveryConfirmationSeconds: 30
    deliveryRetryDelaysMs: [1000, 5000, 15000]
    maxDeliveryAttempts: 3
    maxEvidenceItems: 20
    maxEvidenceBytes: 4096
    logLevel: warn
```

## 工具

| 工具 | 职责 |
|---|---|
| `guardian_create` | 在当前 root 会话创建 Guard |
| `guardian_list` | 列出 Guard、控制状态与策略阶段（有界） |
| `guardian_update` | `edit` / `pause` / `resume` / `acknowledge` / `close` |
| `guardian_check_now` | 单次评估；只记录真实发生的状态转换 |

工具在非 root Agent 会话中拒绝运行（`OWNER_MISSING`），不泄漏堆栈或路径，
返回稳定错误码（`BAD_REQUEST`、`GUARD_NOT_FOUND`、`TOO_MANY_GUARDS`、
`STORE_UNAVAILABLE` 等）。

## 隐私与安全

- 无 shell、HTTP、webhook 或端口监听。
- 除插件自有 store 外不读文件与环境变量。
- 证据有界、UTF-8 截断显式标记，并以「不可信数据」framing 呈现——绝不当指令。
- 详见 [SECURITY.md](SECURITY.md) 与 [docs/threat-model.md](docs/threat-model.md)。

## 许可证

[MIT](LICENSE)
