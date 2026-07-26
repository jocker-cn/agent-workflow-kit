# example-service

这里保存稳定的业务知识，不保存页面实现细节。

- Jenkins job 名称通常包含 `example-service`。
- 生产变更必须使用 `main` 的成功构建。
- 控制台输出中的镜像版本通常含 `image` 或 `container image`。
- Sonar 和 FOSS 报告必须都存在；未找到时不可创建可提交的 CR。
- 生产变更窗口、风险等级和回退方案必须由用户提供或由当前 CR 页面明确显示，不能猜测。
