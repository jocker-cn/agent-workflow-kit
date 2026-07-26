# Agent Workflow Kit

让 Copilot Agent 直接执行用户用自然语言描述的浏览器流程。

用户不需要新增项目目录、业务 Skill、YAML、selector 或脚本。项目只提供：

- 项目本地的官方 Playwright CLI Skill，负责观察页面和操作浏览器；
- `AGENTS.md`，负责通用执行规则、安全边界和人工步骤衔接；
- 按 Prompt 隔离的流程定义与页面操作缓存；
- 面向跨 Copilot 会话恢复的通用执行状态。

## 一次性准备

```bash
pnpm install
pnpm browser install --skills agents
```

然后在项目目录中打开 Copilot Agent，直接描述任务。例如：

```text
打开 B 站，使用短信登录。手机号从环境变量 BILIBILI_PHONE 读取，
验证码由我在浏览器中手动输入；检测到登录成功后自动继续。
选择热搜第三项进行搜索，打开第一个实际视频，
返回视频链接、点赞、投币、收藏、分享和评论数量。
整个过程只读取信息，不要点赞、投币、收藏、分享或评论。
```

或者：

```text
为 payment-service 的 main 分支执行发布 CR 流程：
先在 Jenkins 打包，记录镜像版本、Sonar 和 FOSS 报告；
再创建 CR、填写打包信息并创建 pipeline。
提交审批前展示汇总并等待我确认。
```

Agent 会自行把 Prompt 转成动态执行步骤、读取当前页面、判断条件分支并选择合适命令。流程变化时直接修改 Prompt，不需要同步修改代码。

## 目录职责

```text
.agents/skills/playwright-cli/  官方 Playwright CLI Skill
.github/prompts/                用户维护的自然语言流程
.workflow-cache/                Agent 自动学习的 Prompt 专属缓存
.workflow-runs/                 每次执行的状态与断点
AGENTS.md                       所有流程共用的 Agent 规则
src/                            通用运行时工具
docs/                           安装与排障说明
```

流程步骤、业务事实、策略、输出要求和限制都来自用户当前的 Prompt；新增流程不需要修改项目目录。

## 执行状态与断点恢复

对于跨 Web 系统流程，Agent 会在后台维护一个独立 run。用户不需要在 Prompt 中编排下面的命令；这里展示它们只是为了说明恢复机制。

```bash
# 保存一个可恢复的运行记录
pnpm workflow init \
  --summary "处理订单 A" \
  --intent "读取订单类型；实物订单走仓储流程，虚拟订单走许可证流程；更新订单前等待确认" \
  --prompt-key <prompt-key> \
  --name order-processing \
  --input order.id=A

# Agent 从 Prompt 生成初始计划
pnpm workflow plan-add --run <run-id> \
  --id inspect-order --title "读取订单类型"

# 页面显示订单 A 是实物订单
pnpm workflow fact --run <run-id> \
  --key order.type --value physical --source "订单详情页"
pnpm workflow decision --run <run-id> \
  --name order-route --selected warehouse \
  --condition "order.type is physical" \
  --reason "订单详情页显示为实物订单"

# Agent 动态加入当前分支的步骤并保存恢复位置
pnpm workflow plan-add --run <run-id> \
  --id check-inventory --title "检查库存" --after inspect-order
pnpm workflow checkpoint --run <run-id> \
  --step check-inventory \
  --next "在仓储系统查询订单 A 的库存" \
  --system warehouse \
  --url "https://warehouse.example/..."

# 使用同一个 run id 操作可见浏览器
pnpm browser -s=<run-id> open <url> --headed

# 新会话根据业务变量精确找回未完成的 run
pnpm workflow latest --name order-processing --input order.id=A
pnpm workflow context --run <run-id>
```

`context` 会为新的 Copilot 会话输出恢复所需的目标、输入、计划、事实、分支决策、当前步骤、下一动作、等待状态、结果和确认记录。新的 Agent 随后重新观察浏览器页面并继续；不会复用已经失效的 element ref。

同一套流程处理订单 A 和订单 B 时，Agent 会创建两个相互隔离的 run。Prompt 中随每次执行变化的订单号、服务、分支、环境等保存为该 run 的输入；运行过程中从 Web 系统取得的编号、版本和报告结果保存为该 run 的数据，不会从其他 run 继承。

状态采用类似 n8n Execution 的思想，但没有固定节点图：Prompt 是流程定义，Agent 动态维护 `plan`；页面发现的业务属性进入 `facts`；条件分支进入 `decisions`；跨系统结果进入 `outputs`；`cursor` 保存断点。

运行记录位于 `.workflow-runs/`，默认不会提交到 Git。密码、验证码和人工步骤如何处理，由对应业务 Prompt 决定；项目不提供统一业务策略或浏览器命令包装脚本。

## Prompt 专属缓存

每个 Prompt 文件根据“文件身份 + 内容哈希”获得独立缓存：

```text
.workflow-cache/
├── definitions/
│   └── <prompt-key>/
│       └── <prompt-hash>.json
└── pages/
    └── <prompt-key>/
        └── <prompt-hash>/
            └── <page-id>.json
```

- 同一个 Prompt、不同订单或资源变量：共享缓存，run 相互隔离；
- 不同 Prompt：缓存完全隔离；
- Prompt 内容改变：自动创建新版本，不复用旧版本；
- 缓存由 Agent 自动生成，用户只维护自然语言 Prompt；
- snapshot ref、凭据、验证码和本次业务变量不会写入缓存。

首次执行时，Agent 解析 Prompt、探索页面并学习稳定操作：

```bash
pnpm cachectl list
pnpm cachectl prepare --prompt-key <prompt-key>
pnpm cachectl definition-step --prompt-key <prompt-key> \
  --id inspect-order --title "读取订单类型"
pnpm cachectl page-init --prompt-key <prompt-key> \
  --page order-details --origin "https://orders.example" \
  --route "/orders/*" --title "订单详情" --anchor "订单类型"
pnpm cachectl action-learn --prompt-key <prompt-key> \
  --page order-details --name open-order \
  --strategy locator --target "getByRole('link', { name: '订单详情' })" \
  --postcondition "订单详情标题可见"
```

后续执行先验证页面指纹，再通过 `--raw` 使用缓存 locator，并验证后置条件。缓存失败时，Agent 先截图，再按需读取局部 snapshot，学习新的 locator 并回写缓存；成功路径不再反复读取完整页面结构。

使用 `prompt-key` 是为了避免 Windows shell 对包含中文、空格的 Prompt 路径进行错误拆分。Prompt 文件名和正文不需要因此修改。

浏览器安装、会话和排障细节见 [docs/playwright-cli.md](docs/playwright-cli.md)。

## 验证

```bash
pnpm test
pnpm check
```
