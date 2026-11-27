# 本地运行库来源

本目录提供 Octop 的定制 octop-harness wheel 和完整源码补丁。运行时行为归 octop-harness 库所有；根项目依赖与锁文件固定采用下述定制版本。

## 1.0.13+mxiao.1

- wheel：[octop_harness-1.0.13+mxiao.1-py3-none-any.whl](octop_harness-1.0.13+mxiao.1-py3-none-any.whl)，1,265,371 字节。
- wheel SHA-256：`4bd2000655ac6f5a0c32333fa792910e799854936c865d8ed7eb94865485d3d9`。
- 完整源码补丁：[octop-harness-mxiao.1.patch](octop-harness-mxiao.1.patch)，17 个文件、1,431 行，相对原版 **1.0.13**；新版本的 mxiao 编号从 1 重新计数。
- patch SHA-256：`98ab5440b9890ee68374f289016db41f47f7a7b12623359a2f5ff62544df9609`。
- 轻量重打包器：[repack_harness.py](repack_harness.py)，只使用 Python 标准库，无依赖安装或 build backend。
- 上游：[TencentCloud/octop-harness v1.0.13](https://github.com/TencentCloud/octop-harness/tree/v1.0.13)；发布源：[PyPI octop-harness 1.0.13](https://pypi.org/project/octop-harness/1.0.13/)。

上游来源的 SHA-256：

| 输入 | SHA-256 |
|---|---|
| PyPI 1.0.13 wheel | `96d55c25e77e6ff25755d611021ff600c2a53f50a8e5ebe9c9eb3453c36501f9` |
| PyPI 1.0.13 sdist | `5b9262c0054d94b458b3e03c833cd870bb85d16521a19ee63b33f9d513cdafd8` |
| GitHub v1.0.13 tag 源码归档 | `19166f78f394c7726e07a508c1efb5d890b92f23a265dfb94ec9e48f19283adb` |

GitHub tag 中的 388 个包文件已经与 PyPI wheel 逐字节比对，完全一致。PyPI sdist 不含测试，所以完整补丁以 GitHub tag 的目录布局为基准；运行时代码的实际基准仍是原版 PyPI wheel。

### 逐项迁移

| 既有定制 | 迁移结果与保留行为 |
|---|---|
| OpenAI Images 适配器 | 保留生成 JSON /images/generations；有参考图时 multipart /images/edits，单张字段 image、多张 image[]，最多 16 张；支持 data URL、远程参考图、PNG/JPEG/WebP、base64 或 URL 输出。远程参考图下载不带 API Bearer；无 video/poll 能力。 |
| 媒体配置与注册 | 保留 openai_images 注册、导出，以及旧式/具名配置的 OPENAI_API_KEY、OpenAI v1、gpt-image-2 默认值；自动关闭该适配器视频能力，不影响其他视频 provider。 |
| HTTP multipart | 保留 data/files 请求参数；multipart 去掉手动 JSON Content-Type，让 httpx 设置 boundary；原错误分类、认证、JSON 路径不变。 |
| 模型响应重试 | 保留空正文、仅思考内容、error finish/stop reason 的失败判定；有效工具调用、无效工具调用、拒绝、多模态、音频、结构化 False/空字典等仍正常通过。同步与异步沿用上游重试策略和预算。 |
| 并行 HITL | 保留图运行结束后合并审批、以 checkpoint 顺序展示、按 interrupt.id 分发恢复决定；多 action 分组及数量校验保留；校验失败不继续执行图。 |
| checkpoint 活动保护 | 保留协议图读取、执行与事件投影的活动租约，以及恢复/取消期间避免宿主裁剪的行为。 |
| 有效上下文快照 | 保留 HarnessAgent.aget_effective_messages(thread_id)：取当前压缩后上下文、深拷贝消息、过滤非消息数据；活动、待恢复/HITL、pending 图状态拒绝分叉。 |
| 回归测试与文档 | 保留原 patch 的 5 个测试文件改动：有效历史、响应重试、Images、并行 HITL，以及旧协议测试的 AsyncMock 调整；README 定制说明与版本、CHANGELOG 一并迁移。 |

相对 1.0.11+mxiao.3，9 个运行时文件的所有增删片段逐项精确一致。1.0.13 的 388 个上游包文件中，380 个逐字节保持不变，8 个仅叠加既有定制，另增加 1 个 OpenAI Images 文件；未回退任何上游文件。

完整补丁包含 CHANGELOG、README、源码 pyproject 版本、9 个运行时文件和 5 个测试文件。不要再叠加历史 mxiao.3 或 openai-images 补丁。

### 保留的上游新功能

1.0.12/1.0.13 的文件写入前后捕获及恢复、按回合 allowed_tools 强制限制、召回候选只读接口、CubeSandbox 与工作区恢复、托管 ACP checkpointer、MCP 动态可见性、带图记忆文本过滤、SQLite 退出关闭修复、记忆提取保留/跳过规则与 2,000 字限制全部保留。尤其 agent/config 两个双方都改过的文件，只在非重叠位置叠加旧定制。

所有 METADATA 头字段除 Version 外保持原版不变，包括 Requires-Python、Requires-Dist、Provides-Extra；octop-memory>=1.0.7 及上游其他依赖/extra 不回退。WHEEL、entry_points.txt 和 LICENSE 内容完全不变，METADATA 描述同步到定制 README。

### 复现：轻量 zip 重打包

要求 Python 3.12+、curl、tar、patch。以下命令从 Octop 仓库根目录运行；工作目录使用尚不存在的新路径，避免覆盖现有迁移现场。无需安装本项目依赖。

```bash
task_work="$PWD/generated/harness-upgrade/reproduce"
mkdir -p "$task_work"
python3 - "$task_work" <<'PY'
import hashlib, json, pathlib, sys, urllib.request
out = pathlib.Path(sys.argv[1])
metadata = json.load(urllib.request.urlopen("https://pypi.org/pypi/octop-harness/1.0.13/json"))
item = next(x for x in metadata["urls"] if x["filename"] == "octop_harness-1.0.13-py3-none-any.whl")
data = urllib.request.urlopen(item["url"]).read()
assert hashlib.sha256(data).hexdigest() == "96d55c25e77e6ff25755d611021ff600c2a53f50a8e5ebe9c9eb3453c36501f9"
(out / item["filename"]).write_bytes(data)
PY
curl --fail --location https://codeload.github.com/TencentCloud/octop-harness/tar.gz/refs/tags/v1.0.13 -o "$task_work/source.tar.gz"
python3 - "$task_work/source.tar.gz" <<'PY'
import hashlib, pathlib, sys
assert hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest() == "19166f78f394c7726e07a508c1efb5d890b92f23a265dfb94ec9e48f19283adb"
PY
tar -xzf "$task_work/source.tar.gz" -C "$task_work"
patch --batch --fuzz=0 --no-backup-if-mismatch -p1 -d "$task_work/octop-harness-1.0.13" -i "$PWD/vendor/octop-harness-mxiao.1.patch"
python3 vendor/repack_harness.py "$task_work/octop_harness-1.0.13-py3-none-any.whl" "$task_work/octop-harness-1.0.13" "$task_work/octop_harness-1.0.13+mxiao.1-py3-none-any.whl"
```

最终一行输出应为上方定制 wheel SHA-256。重打包器锁定上游 wheel 哈希、定制版本和输出文件名，更新 dist-info 路径/Version/README，重算全部 RECORD 哈希与长度；排序、时间戳、权限和压缩参数固定。在当前 Python 3.12.3 环境，重复打包逐字节一致；不同 zlib 版本可能改变压缩后的整体哈希，包内内容与 RECORD 应仍一致。

### 已执行验收及边界

- 完整补丁的文件集合与旧 patch 完全相同；9 个旧运行时差异逐项原样迁移。
- 完整 patch 从干净上游零 fuzz、零 offset 正向应用后，与定制源码逐字节一致；反向还原后，与干净上游逐字节一致。
- 394 个 wheel 条目的 RECORD 集合、SHA-256、大小全部通过，ZIP CRC 通过，包内内容与定制源码一致，无 .orig/.pyc 等临时文件。
- METADATA 除 Version 与描述外的全部字段、上游资源/CLI 入口/许可证通过一致性检查。
- 所有 14 个改动 Python 文件和重打包器通过 py_compile；确定性二次重打包通过。
- 标准库隔离行为自检直接执行生产 AST，以假图/假 HTTP 验证：Images JSON/multipart/header/参考图与返回值；配置往返及视频默认值；15 个有效、6 个无效模型响应；快照与压缩摘要/活动拒绝；乱序并行审批合并、重建协议按 id 恢复、多 action、4 种数量不符不执行图。

本次现场报告：[verification.json](../generated/harness-upgrade/verification.json)、[behavior-checks.json](../generated/harness-upgrade/behavior-checks.json)；检查脚本：[verify_upgrade.py](../generated/harness-upgrade/verify_upgrade.py)、[check_behaviors.py](../generated/harness-upgrade/check_behaviors.py)。它们位于忽略的 generated 工作区，未作为运行时依赖。前一脚本的 roundtrip-source 必须是新目录；行为自检可重复直接运行。

安装新 wheel 后，已串行运行补丁内的 effective messages、model response retry、OpenAI Images、parallel HITL 和 LangGraph 回归测试，全部通过；HTTP 调用使用测试替身，未调用真实 LLM。有效快照仍依赖 deepagents 私有摘要应用方法，并行审批仍依赖 LangGraph 的 interrupt.id 与快照结构；这些是原定制依赖，迁移未引入额外协议假设。

新 wheel 已由根目录 .gitignore 明确放行；pyproject.toml 与 uv.lock 同步固定为 1.0.13+mxiao.1，部署时无需从网络获取未固定的 harness。

## 历史版本

[octop_harness-1.0.11+mxiao.3-py3-none-any.whl](octop_harness-1.0.11+mxiao.3-py3-none-any.whl) 和 [octop-harness-mxiao.3.patch](octop-harness-mxiao.3.patch) 保留用于回滚与审查。旧 wheel SHA-256：`9edc6ea361f8c23c9795a51a8fa51ca142ba5625e61f39fd604e8b2dfd678fea`；旧基准提交：`562c8a399f632692046da20ee0a016673f6e9f1a`。

[octop-harness-openai-images.patch](octop-harness-openai-images.patch) 与 [octop_harness-1.0.11+mxiao.1-py3-none-any.whl](octop_harness-1.0.11+mxiao.1-py3-none-any.whl) 同样只作历史记录。
