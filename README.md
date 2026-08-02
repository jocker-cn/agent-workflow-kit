# Agent Workflow Kit

让 Copilot Agent 直接执行用户用自然语言描述的浏览器和 Windows 桌面流程。

用户不需要新增项目目录、业务 Skill、YAML、selector 或脚本。项目只提供：

- 项目本地的官方 Playwright CLI Skill，负责观察页面和操作浏览器；
- 项目本地的官方 WinAppCLI UI Automation Skill，负责观察和操作 Windows 应用；
- 项目本地的 Workflow Compiler Skill，负责把不规整的 Prompt 编译成页面事务；
- 项目本地的 Desktop Workflow Compiler Skill，负责把多步桌面操作编译成连续事务；
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

Agent 会在首次运行时读取完整 Prompt，先从最终输出反推所需事实，再按数据依赖和页面
归属生成参数化流程图。Prompt 中分散描述但来自同一页面的字段会被合并到一次页面事务；
后续运行由本地执行器连续跑完整个可执行浏览器段。流程变化时直接修改 Prompt，不需要同步
修改业务代码。

## 目录职责

```text
.agents/skills/playwright-cli/  官方 Playwright CLI Skill
.agents/skills/winapp-ui-automation/
                                官方 WinAppCLI UI Automation Skill（项目本地调用）
.agents/skills/compile-browser-workflows/
                                Prompt 到页面事务的通用编译规则
.agents/skills/compile-desktop-workflows/
                                Prompt 到 Windows 桌面事务的通用编译规则
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

每个 Prompt 文件根据“文件身份 + 内容哈希”获得独立缓存。逻辑上分成三层：

```text
.workflow-cache/
├── definitions/
│   └── <prompt-key>/
│       └── <prompt-hash>.json        参数化流程节点与条件路线
├── pages/
    └── <prompt-key>/
        └── shared/
            └── <page-id>.json        跨 Prompt 正文版本复用的页面动作
└── profiles/
    └── <prompt-key>/
        └── defaults.json             成功运行后记住的字段生成偏好
```

- 同一个 Prompt、不同订单或资源变量：共享缓存，run 相互隔离；
- 不同 Prompt：缓存完全隔离；
- Prompt 内容改变：Workflow Definition 自动创建新版本；
- 同一 Prompt 文件的稳定页面动作可以跨正文版本复用，不同 Prompt 文件仍完全隔离；
- 订单号、资源名称等实例变量只进入 run，不作为缓存分支；
- 订单类型、环境等真正改变步骤的变量用于选择局部路线；
- 角色、租户、语言和 UI 版本用于选择页面变体；
- 缓存由 Agent 自动生成和修复，用户只维护自然语言 Prompt；
- snapshot ref、凭据、验证码和本次业务变量不会写入缓存。

字段生成规则按三层解析：Workflow Definition 保存 Prompt 的稳定结构；Defaults Profile
保存同一 Prompt 上次成功运行后可复用的字段偏好；Run Overlay 保存本次任务明确提出的变化。
本次规则覆盖共享默认值，并在 run 创建时形成不可变快照。任务成功后默认回写本次变化；
用户说明“仅本次”时使用 `--remember-generation false`，不会污染后续任务。Profile 有独立
revision，因此不会改变 Recipe 版本，也不会把某次的 `num` 展开进缓存。

首次执行时，Agent 在内存中生成内部编译输入。业务说明保存在 Workflow、事实、策略、事务和
操作的 `description` 字段中；Skill 只保存所有业务共用的编译算法。编译输入通过 stdin
直接传给编译器，不会在 `.workflow-cache` 中留下临时 JSON：

```bash
<agent-generated-json> | pnpm compile -- --prompt-key <prompt-key> --stdin true
```

`--file <compiler-json>` 只用于诊断，并且文件必须位于 `.workflow-cache` 之外，编译后删除。
Cache 只允许保存正式 Definition、共享 Page Action 和 Defaults Profile；其他文件会被执行器拒绝。

编译器不会机械保留 Prompt 的句子顺序。它保留明确的前后关系、事实依赖、人工边界和高风险
操作，然后优先排列相同页面状态的任务，并融合兼容事务。之后 Agent 探索页面并学习局部路线
和稳定操作：

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

缓存命中后，正常路径使用一条命令连续执行多个页面事务：

```bash
pnpm execute -- --run <run-id>
```

执行器在进程内持续运行和提交断点，仅在人工/未确认风险边界、缺少路由事实、Cache
失配或浏览器段结束时返回 Agent。缓存决策和报告节点会在本地完成；新标签页按照 URL 和
tab role 在同一浏览器 Session 中切换。某个事务失败后，失败状态会先写入 Run，再返回 Agent，
只修复该事务并从失败点恢复：

```bash
pnpm execute -- --run <run-id> --from <failed-node-id>
```

“执行 N 次”不会被展开为 N 个节点、N 条路线或临时脚本。编译器生成一个参数化循环节点：

- `iteration.mode=repeat + countFrom` 从本次 run 的 `num` 等输入取得次数；
- `iteration.mode=foreach + itemsFrom` 直接遍历本次 run 提供的数组；
- `iteration.generate` 只生成所有路线共用的字段；
- `iteration.generateByRoute.<route-id>` 只生成当前业务路线需要的字段。

Runner 在第一轮不可逆提交前一次性生成、校验并持久化完整 batch，成功后逐轮推进
`nextIndex`。恢复时复用已经保存的 item，不会重新随机生成；字段间的 `copy` 和模板引用也
不依赖 JSON 属性书写顺序。价格范围、唯一性、候选项等业务规则只能来自 Prompt，框架不会
自行添加。选择字段支持 `random`、`cycle`、`balanced`、`shuffle-cycle` 和 `unique`；
循环完成后自动写入包含数量、耗时、字段分布和规则校验的 `executionSummary.<node-id>`。

Agent 可在创建 run 时把本次自然语言中的字段规则映射为 Run Overlay，例如：

```bash
pnpm workflow init --summary "新增 20 个微信资源" --prompt-key <prompt-key> \
  --input resourceType=微信资源 --input num=20 \
  --generation submit-resources.weixin.authType.selection=balanced \
  --generation submit-resources.weixin.name.unique=true
```

清理 Cache 时先预览准确目标：

```bash
# 预览全部非正式 Cache 文件，包括嵌套的遗留 compiler 草稿
pnpm cachectl clear --scope drafts

# 删除预览出的非正式文件
pnpm cachectl clear --scope drafts --apply true

# 预览已经删除 Prompt 文件留下的正式 Cache 目录
pnpm cachectl clear --scope orphans

# 只清当前 Prompt 正文版本的 Definition
pnpm cachectl clear --prompt-key <prompt-key> --scope current

# 清理该 Prompt 文件的所有 Definition、共享页面 Cache 和字段默认值
pnpm cachectl clear --prompt-key <prompt-key> --scope workflow

# 只清理该 Prompt 记住的字段默认值
pnpm cachectl clear --prompt-key <prompt-key> --scope profile

# 确认预览无误后执行
pnpm cachectl clear --prompt-key <prompt-key> --scope workflow --apply true
```

单节点命令保留用于学习、测试和修复：

```bash
pnpm run recipe -- --run <run-id> --node process-order
pnpm run workflow -- commit --run <run-id> \
  --file .workflow-runs/<run-id>/last-boundary.json
```

`pnpm run recipe --` 会把该节点的多个安全动作编译进官方 Playwright CLI 的一次 `run-code` 调用，在进程内完成页面变体校验、操作、提取和业务边界验证，并自动记录每个动作耗时。成功路径不再把每次点击、find、eval 和 cache 写入分别交回 Agent。

Recipe 中跨页面的动作会按连续 Page Variant 分组。对于 SPA 跳转，Runner 会等待下一组页面的 URL、标题和锚点稳定后再继续；重试时如果浏览器已经位于后面的页面组，会从当前匹配组恢复，不会再次要求回到 Recipe 的起始页面。

当批次与预期不一致时才返回 Agent：read/reversible 节点的临时加载问题可自动重试；
不可逆节点不会自动重试，以免“实际提交成功但结果提示超时”造成重复写入。locator 变化只修复
页面动作；角色、租户或 UI 版本不同则学习新的页面变体；新订单类型学习新的 guarded route；
业务顺序改变才升级对应 recipe 节点。

使用 `prompt-key` 是为了避免 Windows shell 对包含中文、空格的 Prompt 路径进行错误拆分。Prompt 文件名和正文不需要因此修改。

浏览器安装、会话和排障细节见 [docs/playwright-cli.md](docs/playwright-cli.md)。

## Windows 桌面 UI

WinAppCLI 是可选能力，不会改变已有 Playwright 命令和浏览器工作流。依赖与官方 Skill
固定在同一个 `0.5.0` 版本；无需 Winget、全局 npm 包或 MCP。Agent 在桌面任务中通过项目脚本调用：

```bash
pnpm desktop:help
pnpm desktop list-windows --json
pnpm desktop inspect -a notepad --interactive
pnpm desktop:window -- --hwnd <hwnd> --mode restore
```

WinAppCLI 使用 Windows UI Automation，可操作 WinUI、WPF、WinForms、Win32 和 Electron
应用。稳定操作优先使用 AutomationId、`invoke`、`set-value` 和 `wait-for`；只有 UIA
模式不可用时才使用真实鼠标或键盘注入。

多步桌面流程不需要让 Agent 每执行一次点击就重新规划。Agent 会把当前业务边界内的动作生成
为 `.workflow-runs/<run-id>/` 下的声明式事务，然后一次提交：

```bash
pnpm desktop:batch -- --run <run-id> \
  --file .workflow-runs/<run-id>/<transaction>.json
```

事务支持 UIA 语义操作、键盘导航、短等待、读值、滚动和窗口相对坐标回退。纯 UIA 事务可以
在后台执行；默认的 `activation.mode=auto` 只会在鼠标模拟、滚轮或 `send-input` 等依赖前台
的动作之前，通过 Node 调用 Win32 API 恢复和激活目标窗口，不会使用 `screenshot --focus`
管理窗口。默认保持窗口位置和大小不变；相对坐标会根据 UIA 返回的实时 Windows 窗口矩形转换，
不会把窗口截图坐标误当成屏幕绝对坐标。正常 Cache 路径只在事务边界截图一次，失败时停止在
准确的 action id 并补充失败截图。
属于可恢复 run 的事务还会生成一个聚合的 `last-boundary.json`，Agent 只提交一次 workflow
checkpoint，不会为每个桌面动作分别启动状态命令。

没有人工或风险边界的跨桌面应用步骤会合并成一个多窗口 batch。例如 SecureCRT 读取状态后，
可以在同一进程内读取窗口标题、用正则提取字段、渲染微信消息并切换到微信发送，不需要在两个
应用之间返回模型。正式截图只写入 `.workflow-runs/<run-id>/evidence/<transaction-id>/`；失败
诊断图写入 `diagnostics/<transaction-id>/`，修复成功后自动删除。PNG 不允许直接出现在 run 根目录。

对于名称明确的会话、记录、文档或菜单项，编译器优先使用应用内精确搜索，并区分本地结果、
功能入口和网络搜索等结果类型；滚动列表仅作为搜索不可用时的 fallback。没有暴露 UIA 的 Qt、
自绘界面仍可使用窗口相对坐标和单次边界截图，由模型只在业务边界做一次视觉确认。

事务 JSON 是 Agent 生成的运行状态，不是用户配置，也不会进入 `.workflow-cache`。密码等敏感
内容通过 `valueFrom: "env.NAME"` 读取，不会写入计划或执行结果。具体内部字段见项目 Skill：
[compile-desktop-workflows](.agents/skills/compile-desktop-workflows/SKILL.md)。

## 验证

```bash
pnpm test
pnpm check
```
