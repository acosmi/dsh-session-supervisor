# Compatibility matrix（dsh-session-supervisor）

本插件是外部 community bundle。兼容承诺 = 实测组合，不裸依赖 `latest`。

| 维度 | 基线值（P0/P2 实测） | 备注 |
|---|---|---|
| Harness 源码 | `deepseek-ai/deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`（rc.5） | 本仓实跑基线 |
| npm 钉版（实测结论） | **全系列 `0.1.0-rc.6`**：`dsh`/`dsh-agent`/`dsh-session`/`dsh-llm`/`dsh-tools`/`dsh-home-paths`/`dsh-app-boot`/`dsh-base` + `cordis@4.0.1` + `schemastery@3.18.1` | **dist-tags 误导**：`dsh-session` latest 指向 `0.0.1-rc.1`，其 peer 引用未发布的 `dsh-type-meta` —— 安装必须钉 `0.1.0-rc.6` 精确版本 |
| Node | `^22.19.0 \|\| >=24.0.0`（实测 v24.18.0） | Node 24 原生 TS strip 不支持参数属性 —— 本包源码已规避 |
| pnpm | ≥10（实测 10.29.1/11.7.0） | 仅安装期工具 |
| 目标 profile | `dsh-base`（web/headless 模板皆含） | `timer`/`agents`/`sessions`/`tools`/`sessionPersistence` 五项注入依赖，缺任一即 load 期 fail loud |
| peer 声明 | `cordis@^4.0.1`、`dsh-session/agent/llm/tools@^0.1.0-rc.6` | P4 发布候选按此钉版 |
| runtime deps | `schemastery@3.18.1`、`dsh-home-paths@^0.1.0-rc.6` | — |
| 禁止依赖 | headless 专属服务（`cmdlineArgs`/`headlessStartup`）、`storageDomain`、任何 `dsh-schedule` 内部 seam | base/headless 不保证提供 |
| HMR | 发布版 `cordis-plugin-hmr` 需 `--expose-internals` | profile 中按 headless 惯例 disable `hmr` 行（loader fixture 已演示） |

## 上游破坏性变更应对

- developer preview：每次上游 rc 发布重跑 `spike/p0-spike.mjs` + `test:profile-install` smoke + 本矩阵更新。
- 官方提供 ignorable 写入口 / 事件注册 seam 后：评估 `guardian/change` 迁回会话日志（v2 候选），迁移必须保留旧 store 兼容读取。
