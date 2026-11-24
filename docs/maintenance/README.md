# 超星课件归档维护说明

GitHub Actions 登录超星、生成 PPTX 和 Word，并上传加密交接包。Windows 转发电脑读取交接包，解密并按大小拆成可独立解压的 ZIP，再通过微信发送。

## 日常操作

- **改订阅**：在自己的 Fork 运行「课程订阅与邮件」的 `discover`，从 Summary 查课程名称和 `courseinfoid`。编辑该 Fork 的 `data` 分支上的 `data/subscriptions.json`，修改 `course_ids`。暂时不可见的课程只会警告并跳过，明确退订才删除对应 ID。
- **手动归档**：同一个工作流选择 `main`，操作选 `run`。定时和手动都处理待归档回放；遇到运行时限或交接包大小上限，会先上传已做好的文件，下轮续跑。
- **手动取件**：在 Windows 任务计划程序找到已配置的转发任务，点「运行」。已有发送记录的课件不会重发。定时取件早于上传时，可用这一步提前补发。
- **续期令牌**：在 GitHub 创建只允许读取本 Fork 的 **Actions → Read-only** 细粒度令牌，替换 Windows 私有配置 `local-data/wechat-relay/config.json` 中的 `githubToken`。不修改 `relayKey` 或联系人。详见[微信转发设置](../wechat-relay.md)。

## 没收到文件怎么查

| 看到的情况 | 去哪里查、怎么处理 |
| --- | --- |
| GitHub 显示成功或失败，但微信没有新附件 | 先确认打开的是「课程订阅与邮件」的 `run`，不是代码测试或 `discover`。看这轮 **Artifacts** 是否有 `course-relay-*`；有些回放失败也可能留下已成功上传的包。 |
| 有加密包，Windows 没取到 | 比较上传时间与 Windows 上次运行时间。上传更晚就手动运行取件任务，或等下一次。 |
| 任务已经运行，仍没收到 | 在转发电脑查看 `local-data/wechat-relay/latest.log` 与 `latest.stderr.log`；检查 Windows 是否已登录、微信是否可发送、GitHub 令牌是否过期，以及任务所用代理是否正常。 |
| 下载大包约 15 分钟后失败，日志出现 `23` 或 `TimeoutError` | 更新转发脚本到下载上限 2 小时的版本，并将现有任务总运行时限调到 4 小时；保留触发时间、代理启动方式和发送记录。 |
| 日志说发送结果未确认 | 先在微信会话里查 ZIP 是否实际发出，再按[补发说明](../wechat-relay.md#补发确认和限制)处理记录。不要先清空发送记录或盲目重发。 |
| 只有 PPTX，没有 Word | 检查本轮是否拿到了平台字幕。空字幕只表示这次没拿到，约 48 小时后到期复查；以后有字幕时只补 Word。发出 PPTX 后满 7 天仍无字幕即停止复查。 |
| 某节一直失败（如“没有电脑录屏”） | 单节失败只在 Summary 留警告，整轮仍显示成功；从首次失败起满 7 天后不再重试，日志只统计数量。需要强制重试时，在加密发送记录里清除该节的 `failedSince`。 |

GitHub 的交接记录和 Windows 的发送记录分开保存。维护时保留 `data/delivery-state.enc` 和 Windows 的 `local-data/wechat-relay/state.json`。不要把令牌、密钥、课程内容或带签名的地址提交到仓库。
