# 本地运行库来源

Octop 通过 `pyproject.toml` 和 `uv.lock` 固定使用本目录的自定义 `octop-harness` wheel。运行库行为的修改保留在 `octop-harness` 源码仓库，本仓库附带补丁以便审查和重新构建。

当前版本为 `1.0.11+mxiao.3`：

- wheel：`octop_harness-1.0.11+mxiao.3-py3-none-any.whl`。
- SHA-256：`9edc6ea361f8c23c9795a51a8fa51ca142ba5625e61f39fd604e8b2dfd678fea`。
- 完整源码补丁：`octop-harness-mxiao.3.patch`，包含媒体适配器、模型响应重试、并发知识库审批修复、有效上下文快照接口及对应测试。
- 上游仓库：`TencentCloud/octop-harness`。基准提交：`562c8a399f632692046da20ee0a016673f6e9f1a`。

在上游基准提交的干净工作树中直接应用 `octop-harness-mxiao.3.patch`，然后运行该运行库的 `make all` 和 `uv build --wheel`。该补丁已验证可以向基准正向应用，也可以在当前源码中反向应用。

`octop-harness-openai-images.patch` 与 `1.0.11+mxiao.1` wheel 保留为历史版本。当前完整补丁已经包含其中的改动，不应叠加应用旧补丁。
