# Agent Workflow Kit

一个由 Copilot Agent 通过 Prompt 驱动的企业工作流基础项目。当前内置的第一个 workflow 是 CR 自动化；后续可用相同模式扩展 Jira 变更、发布检查、报告收集、运维巡检或其他浏览器流程。

它不包含任何公司网址、账号或页面 selector。每一种 workflow 由 Skill 定义 Agent 操作方法，并由 `workflows/<id>/workflow.yaml` 定义阶段、必填事实、证据和确认 gate；Agent 使用 `playwright-cli` 观察当前页面并完成操作。`workflowctl` 负责保存可恢复的运行状态、证据和提交前摘要。

## 扩展新 workflow

新增一个流程时，不需要改动浏览器自动化模式：新增一个 Skill 与对应 workflow contract，定义该流程的阶段、必需证据和确认点；仅在确实存在跨 workflow 的新能力时才扩展 `src/`。

```text
skills/
  cr-automation/       # 当前：Jenkins → CR → pipeline
  bilibili-video-metrics/ # 示例：短信登录 → 热搜 → 视频指标
workflows/
  change-request/      # README + workflow.yaml
  bilibili-video-metrics/ # README + workflow.yaml
```

每个 Skill 都遵循同一工作循环：浏览器 snapshot → Agent 决策 → 基于当前 ref 操作 → 保存运行状态与证据。页面实现细节不应写入 Skill。

## 前置条件

- Node.js 20+
- 已通过项目本地依赖固定 Playwright CLI 版本；首次使用时初始化官方 Agent Skill：

  ```bash
  pnpm install
  pnpm browser install --skills agents
  ```

- 本地浏览器能够通过公司的 Windows / 浏览器集成自动登录 Jenkins 和 CR 系统。

浏览器命令一律通过 `pnpm browser ...` 调用，这样所有使用者都采用 `pnpm-lock.yaml` 中锁定的 CLI 版本。完整说明见 [docs/playwright-cli.md](docs/playwright-cli.md)。

官方 Skill 安装到 `.agents/skills/playwright-cli/`，负责通用的快照、ref、会话与标签页操作。`skills/` 下的文件只保留业务规则和 workflow 状态约束，避免每个新流程重复浏览器基础操作。

如果 CLI 启动的新浏览器不能复用登录态，先验证 `playwright-cli attach --cdp=chrome` 或浏览器扩展附着方式；不要把 Cookie、密码或 token 写入本仓库。

## 快速开始

```bash
cd D:/code/copilotkit/agent-workflow-kit
pnpm workflow init --workflow change-request --summary "修复支付回调重试问题" \
  --input service=payment-service --input environment=production --input branch=main
pnpm workflow show --run <run-id>
```

## Playwright CLI 使用

先在受管浏览器环境中做一次非生产验证：

```bash
# 打开浏览器（将 URL 改成公司允许测试的地址）
pnpm browser open https://example.com --headed

# 获取当前页面的可操作元素；Agent 根据当前 ref 决定下一步
pnpm browser snapshot

# 截图、查看会话、关闭会话
pnpm browser screenshot
pnpm browser list
pnpm browser close
```

不要将登录态、Cookie 或浏览器 profile 提交到 Git。若 CLI 启动的浏览器不能使用公司的自动登录机制，先验证附着到已登录浏览器的方式，再进行真实业务操作。

将本项目的 `skills/cr-automation/SKILL.md` 放到 Copilot 可读取的 Skill 目录，或将其内容纳入你们公司的 Agent Skill。之后可用类似 Prompt：

```text
为 payment-service 的 main 分支创建生产 CR。
变更内容：修复支付回调的重试问题。
按 CR Automation Skill 执行；创建 pipeline 后先展示预览，不要提交。
```

## 运行状态

每次运行的数据写入 `.workflow-runs/<run-id>/`，默认被 Git 忽略：

```text
.workflow-runs/<run-id>/
  state.json       # 当前阶段和结构化业务数据
  evidence.jsonl   # URL、截图、快照、控制台摘录等证据索引
  review.md        # 提交前可读摘要
```

常用命令：

```bash
# 查看状态
pnpm workflow show --run <run-id>

# 推进阶段（只能按流程前进）
pnpm workflow phase --run <run-id> --to BUILD

# 记录构建/报告/CR/pipeline 字段
pnpm workflow set --run <run-id> --key build.number --value 421
pnpm workflow set --run <run-id> --key build.image --value registry.example/payment-service:2026.07.24-421

# 记录截图、快照、URL 或文字证据
pnpm workflow evidence --run <run-id> --kind screenshot --value D:/safe/path/before-submit.png

# 生成提交前摘要；通过后写入明确确认标记
pnpm workflow review --run <run-id>
pnpm workflow confirm --run <run-id> --action submit --by "Joker"
```

对于短信验证码、人工检查等需要人完成的页面步骤，不要结束 Agent 再要求用户发送“已完成”。将 run 标记为等待状态，并由本地 Playwright CLI 轮询可见页面状态；检测到预期状态后在同一任务中继续：

```bash
pnpm workflow pause --run <run-id> --reason "等待短信验证"
pnpm browser:wait --session <run-id> --present "已登录后的可见标识" --absent "登录" --timeout-ms 600000
pnpm workflow resume --run <run-id>
```

若等待超时，run 会保留为 `waiting`，后续可恢复而不需要记住 run id：

```bash
pnpm workflow latest --workflow <workflow-id>
pnpm workflow show --run <run-id>
```

`confirm` 只记录用户已确认；它绝不会提交网页。真正点击 CR 的提交按钮仍由 Agent 在确认后用 `playwright-cli` 完成，并记录结果。

## 项目知识

在 `knowledge/` 下为每个服务保存稳定的业务知识，例如 Jenkins job 命名、报告常见术语和风险限制。不要保存 CSS selector、元素 ref、Cookie 或密码。可从 `knowledge/example-service.md` 复制。

## Bilibili 测试 workflow

`skills/bilibili-video-metrics/` 是一个独立 workflow 模块，不是独立项目。它会在用户手动完成短信验证码后，搜索当前热搜第一项并打印首个视频的公开指标。执行说明见 [workflows/bilibili-video-metrics/README.md](workflows/bilibili-video-metrics/README.md)。

## 验证

```bash
pnpm check
pnpm workflow init --workflow example --summary "验证状态文件" --input environment=test --input branch=main
```

第二条命令会创建一个本地 run；测试完成后可手动删除对应 `.workflow-runs/<run-id>` 目录。
