# Bilibili video metrics workflow

这是 `agent-workflow-kit` 的一个测试 workflow 模块，不是独立项目。执行逻辑位于 `skills/bilibili-video-metrics/SKILL.md`，它使用本项目已集成的 Playwright CLI。

## 准备

在 `agent-workflow-kit` 根目录执行一次：

```bash
pnpm install
pnpm browser install --skills agents
```

手机号只通过当前 shell 的环境变量提供，绝不写入文件或 Prompt：

```bash
# Git Bash
export BILIBILI_PHONE='你的手机号'
```

## 交给 Agent 的 Prompt

```text
按 bilibili-video-metrics Skill 执行测试。使用当前环境变量 BILIBILI_PHONE 登录；
验证码由我手动输入。登录成功后搜索 B 站热搜第一项，打开第一个视频，
并在终端输出视频链接、点赞、投币、收藏、分享、评论数量。
```

## 结果格式

由 Agent 直接在终端与最终回复中呈现视频 URL 和可见指标。workflow contract 定义必填字段，不规定格式化脚本。

如果当前页面没有展示某项指标，必须输出 `N/A`，而不是猜测或从隐藏网络数据中提取。
