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

Agent 会在首次运行时把 Prompt 学习成参数化流程图；后续把本次变量注入流程，根据已知条件选择缓存分支，并以业务步骤为单位批量操作页面。流程变化时直接修改 Prompt，不需要同步修改业务代码。

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
pnpm run workflow -- init \
  --summary "处理订单 A" \
  --intent "读取订单类型；实物订单走仓储流程，虚拟订单走许可证流程；更新订单前等待确认" \
  --prompt-key <prompt-key> \
  --workflow-name order-processing \
  --input order.id=A

# Agent 在一个业务边界完成后，一次性提交步骤、facts、decision、
# outputs、断点、缓存路由和耗时；用户不需要手工编写这个 JSON。
pnpm run workflow -- commit --run <run-id> \
  --file .workflow-runs/<run-id>/last-boundary.json

# 使用同一个 run id 操作可见浏览器
pnpm browser -s=<run-id> open <url> --headed

# 新会话根据业务变量精确找回未完成的 run
pnpm run workflow -- latest --workflow-name order-processing --input order.id=A
pnpm run workflow -- context --run <run-id>
```

`context` 会为新的 Copilot 会话输出恢复所需的目标、输入、计划、事实、分支决策、当前步骤、下一动作、等待状态、结果和确认记录。新的 Agent 随后重新观察浏览器页面并继续；不会复用已经失效的 element ref。

同一套流程处理订单 A 和订单 B 时，Agent 会创建两个相互隔离的 run。Prompt 中随每次执行变化的订单号、服务、分支、环境等保存为该 run 的输入；运行过程中从 Web 系统取得的编号、版本和报告结果保存为该 run 的数据，不会从其他 run 继承。

状态采用类似 n8n Execution 的思想：Prompt 是用户维护的源定义；首次运行后生成参数化 Workflow Recipe；页面发现的业务属性进入 `facts`；选中的缓存路线进入 `recipe.selections`；跨系统结果进入 `outputs`；`cursor` 保存断点。

运行记录位于 `.workflow-runs/`，默认不会提交到 Git。密码、验证码和人工步骤如何处理，由对应业务 Prompt 决定；项目不提供业务专属脚本，通用 Recipe Runner 只负责执行已学习并通过边界校验的页面动作。

## Prompt 专属缓存

每个 Prompt 文件根据“文件身份 + 内容哈希”获得独立缓存。逻辑上分成两层：

```text
.workflow-cache/
├── definitions/
│   └── <prompt-key>/
│       └── <prompt-hash>.json        参数化流程节点与条件路线
└── pages/
    └── <prompt-key>/
        └── <prompt-hash>/
            └── <page-id>.json        页面变体、语义动作与 locator 候选
```

- 同一个 Prompt、不同订单或资源变量：共享缓存，run 相互隔离；
- 不同 Prompt：缓存完全隔离；
- Prompt 内容改变：自动创建新版本，不复用旧版本；
- 订单号、资源名称等实例变量只进入 run，不作为缓存分支；
- 订单类型、环境等真正改变步骤的变量用于选择局部路线；
- 角色、租户、语言和 UI 版本用于选择页面变体；
- 缓存由 Agent 自动生成和修复，用户只维护自然语言 Prompt；
- snapshot ref、凭据、验证码和本次业务变量不会写入缓存。

首次执行时，Agent 解析 Prompt、探索页面，并学习业务节点、局部路线和稳定操作：

```bash
pnpm run cachectl -- list
pnpm run cachectl -- prepare --prompt-key <prompt-key>
pnpm run cachectl -- recipe-node --prompt-key <prompt-key> \
  --id process-order --title "按订单类型处理" \
  --depends-on order.type

pnpm run cachectl -- page-init --prompt-key <prompt-key> \
  --page order-details --origin "https://orders.example" \
  --route "/orders/*" --title "订单详情" --anchor "订单类型"

pnpm run cachectl -- action-learn --prompt-key <prompt-key> \
  --page order-details --name normal-approval \
  --strategy locator --locator-kind role --role button \
  --target "普通审批" --operation click \
  --postcondition "普通审批面板可见"

pnpm run cachectl -- recipe-route --prompt-key <prompt-key> \
  --node process-order --id type-a --when order.type=A \
  --action order-details/normal-approval \
  --expect-text "普通审批"
```

同一节点可以拥有 Type A、Type B 等多条路线。`order.id` 不参与路线选择，`order.type` 才参与：

```bash
pnpm run cachectl -- recipe-resolve --prompt-key <prompt-key> \
  --value order.type=A
```

结果状态可能是：

- `ready`：直接执行选中的缓存路线；
- `needs-facts`：只读取缺少的路由事实；
- `needs-learning`：首次遇到新类型，只探索这个节点；
- `ambiguous`：路线规则冲突，需要 Agent 修复定义。

缓存命中后，一个业务节点由一条命令完成：

```bash
pnpm run recipe -- --run <run-id> --node process-order
pnpm run workflow -- commit --run <run-id> \
  --file .workflow-runs/<run-id>/last-boundary.json
```

`pnpm run recipe --` 会把该节点的多个安全动作编译进官方 Playwright CLI 的一次 `run-code` 调用，在进程内完成页面变体校验、操作、提取和业务边界验证，并自动记录每个动作耗时。成功路径不再把每次点击、find、eval 和 cache 写入分别交回 Agent。

Recipe 中跨页面的动作会按连续 Page Variant 分组。对于 SPA 跳转，Runner 会等待下一组页面的 URL、标题和锚点稳定后再继续；重试时如果浏览器已经位于后面的页面组，会从当前匹配组恢复，不会再次要求回到 Recipe 的起始页面。

当批次与预期不一致时才返回 Agent：临时加载问题只重试；locator 变化只修复页面动作；角色、租户或 UI 版本不同则学习新的页面变体；新订单类型学习新的 guarded route；业务顺序改变才升级对应 recipe 节点。

使用 `prompt-key` 是为了避免 Windows shell 对包含中文、空格的 Prompt 路径进行错误拆分。Prompt 文件名和正文不需要因此修改。

浏览器安装、会话和排障细节见 [docs/playwright-cli.md](docs/playwright-cli.md)。

## 验证

```bash
pnpm test
pnpm check
```
