# ADR-0001: P0 公开 API 与兼容性闸门（2026-08-13，GO）

状态：已通过（本地证据：`spike/p0-spike.mjs` 全绿 + 真实 CLI profile 安装 smoke）。

## 结论

- 基线组合：**源码 `deepseek-harness@47f9438`（rc.5，本仓实跑）**；npm `@deepseek-ai/dsh@0.1.0-rc.6` 仅作参考（发布前重核）。
- 判定：**GO**（v1 全部能力可由公开 API 实现；P0 停止条件不触发）。

## 逐条验证结果

| 计划项 | 结果 | 证据 |
|---|---|---|
| 真实 Loader 装载 named-export 函数插件 | ✅ | `boot()` 组合 dsh-base 78 行 + spike 行；`assertEntriesActivated` 通过 |
| 注入服务全部解析 | ✅ | `timer`/`agents`/`sessions`/`tools`/`sessionPersistence` 在 dsh-base 全部存在 |
| `agent/created`（插件 ctx 监听）、root 判别 | ✅ | 探针捕获 `agent/created` + `isRoot: true`（`parentSession === undefined`） |
| `agents.create()` / `runMaintenance()` / 忙时同步抛错 / `whenIdle()` | ✅ | 全项 PASS |
| `followup()` 唤醒 loop | ✅ | `agent/status: running → idle`（无 key 下 cancel 收场，未驱动模型请求） |
| `ctx.timeout()` 单发 + effect disposer 清理 | ✅ | fired exactly once；effect disposer 在树 dispose 时运行 |
| `dshHomePath('plugins', …)` 锚定 `$DSH_HOME` | ✅ | 解析到 spike 临时 HOME |
| 反向约束（A10） | ✅ | 追加 `guardian/change`（seq 11）后，真实 jsonl 后端 `load` 抛 `SessionFormatUnsupportedError: … unknown to this harness and not marked ignorable` |
| tarball 安装（无 allowBuilds）+ `--dump-config` | ✅ | `dsh plugin --profile spike-cli add <tgz>` 成功，dump 出现 bundle 行 |

## 两个额外 P0 级发现（已计入修订版方案）

1. **vendored Cordis 从不 emit `dispose` 事件** —— `ctx.on('dispose')` 是幻影钩子。一切清理必须走 `ctx.effect()`/注册 disposer（方案 §8.2 已有此条，现获实证背书；回归测试必须钉住）。
2. **`Session.append` 无 `ignorable` 写入口 + 加载侧 `KNOWN_SESSION_EVENT_TYPES` 守卫** —— v1 禁写自定义 SessionEvent（方案 §7.3 修订），store 自有持久化。

## 环境事实

- Node v24.18.0；pnpm 11.7.0；本机无 `DEEPSEEK_API_KEY`（模型相关 smoke 自跳过）。
- npm 版本偏移实录：`dsh@rc.6` / `dsh-agent@rc.6` / `dsh-session@0.0.1-rc.1` / `dsh-llm@0.0.1-rc.1` / `dsh-tools@0.0.1-rc.1` / `dsh-home-paths@0.0.1-rc.3` / `schemastery@3.18.1` / `cordis@4.0.1` —— peer 范围必须按实测锁定。
