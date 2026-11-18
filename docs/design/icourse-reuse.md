# 课程订阅与持久化设计

本项目复用了成熟的个人课程归档系统中的订阅管理思路，但不复用其他教学平台的课程 ID 或登录接口。

## 订阅模型

| 设计 | 本项目实现 |
| --- | --- |
| 程序与个人数据分离 | `main` 保存代码；每个 Fork 自己创建 `data` 分支 |
| 持久订阅清单 | `data/subscriptions.json` 保存 `course_ids` 数组 |
| 运行时课程输入 | GitHub Actions 从订阅清单读取；本地从 `.env` 的 `COURSE_IDS` 读取 |
| 发现与初始化 | `discover` 输出课程名称和 ID，首次成功时创建 `data` 分支和空订阅清单 |
| 增量状态 | `data/delivery-state.enc` 保存加密回放处理与渠道发送记录 |

课程 ID 必须使用超星智播课堂课程列表接口返回的 `courseinfoid`。回放 ID 使用 `speechid`。这两个标识分别对应课程和课节，不可混用，也不能直接拿其他平台的课程 ID 替代。

## 与平台 API 的边界

订阅清单只保存稳定的课程 ID，不保存课程名称、登录凭据、课程入口 URL 或回放签名链接。每次运行仍通过当前登录账号重新发现可访问课程，并将订阅 ID 与当前课程列表匹配；如果某个 ID 已不在当前账号可访问列表中，程序会明确报错，不会猜测或退回到名称匹配。

超星智播课堂与其他教学平台的登录和课程 API 不同。本项目只复用按课程订阅、增量检查和持久化状态这些架构，不复用其他平台的 WebVPN/CAS、课程发现 API 或 ID 命名空间。

## 持久状态与迁移

`data` 分支同时保存明文订阅配置和加密发送状态：

- `data/subscriptions.json`：只包含课程 ID 数组，供用户自行编辑。
- `data/delivery-state.enc`：使用与现有实现兼容的 `Salted__` AES-256-CBC + PBKDF2 封装保存完成记录。

旧版本曾将加密发送记录保存在 `archive-state/delivery-state.enc`。新版本优先读取 `data/delivery-state.enc`；如果不存在，则读取旧分支作为迁移来源，并在下一次成功发送时写入 `data` 分支。不会强制覆盖或删除旧分支。

Contents API 用来定位文件及其 SHA，密文从同一个 SHA 对应的 Git Blob API 读取。实际遇到过 Contents 内联内容和文件大小、SHA 所指向的文件不一致，用 SHA 读取可以避免把保存完好的记录当成损坏文件。

每个发送渠道成功后单独记账。重跑时只继续未完成渠道；SMTP 服务器接受邮件不等于收件箱最终投递，因此仍需区分发送确认和实际收件。

## 仍然保留的平台专用实现

- 超星账号登录与登录态：`src/auth.mjs`。
- 课程列表、课程详情和回放分页：`src/discover.mjs`。
- 回放元数据、字幕时间轴和视频下载：`src/platform.mjs`。
- 课件帧提取与 Office 文档生成：`src/media.mjs`、`src/automatic.mjs`、`src/export.mjs`。

## 设计约束

- 每个 Fork 的 `data` 分支只服务于该 Fork，不读取原作者或其他用户的订阅配置。
- 不将课程 ID 放入 GitHub Secrets；Secrets 只保存登录、邮件和加密密钥等凭据。
- 不将明文视频、字幕或生成文档写入公开 Git 分支或公开 Actions Artifact。
- 课程 ID 可能在不同学校、学期或平台部署中具有不同含义；以当前账号实际发现的 `courseinfoid` 为准。
