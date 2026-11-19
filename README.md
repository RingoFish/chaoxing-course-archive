# 超星智播课堂课程归档

从本人有权限访问的超星「智播课堂」回放中获取平台字幕和电脑录屏，自动整理为两份文件：

- **PPTX 课件**：按首次出现顺序整理课件画面，每张独立一页。
- **DOCX 图文讲义**：嵌入课件图片，并将对应时间段的平台字幕归集到图片下方。

如果回放已发布、平台暂时没有字幕，先生成或发送 PPTX。项目记录待补状态，48 小时后在下一轮归档中自动复查字幕。字幕可用后生成 DOCX，已经发过 PPTX 的渠道只补发 Word。定时任务开启后会自动复查，也可以到期后手动运行。

项目不调用语音识别模型、OCR 模型、LLM 或 AI API。PPTX 中的文字和图形来自录屏截图，不会自动转换成可编辑的 PowerPoint 对象。

## 功能与适用范围

- 自动发现当前账号在智播课堂课程列表中可访问的课程。
- 按课程 ID 订阅整门课程，自动发现并处理其中的回放。
- 只处理符合平台发布条件、存在可用回放链接的课节。
- 自动提取电脑录屏中的课件页面，保留回翻页的时间顺序。
- 每节回放生成 PPTX 和 DOCX；支持邮件、本机 QQ 发送，或由已配置的本机微信取件转发。
- 支持 GitHub Actions 定时增量处理，也支持 Windows、macOS 和 Linux 本地运行。

课程发现范围取决于超星账号当前能访问的智播课堂课程列表。它不等于学校所有课程，也不保证自动枚举账号历史上所有学期的课程。不同学校的登录方式和平台部署可能存在差异。

## GitHub Actions 快速开始

### 1. Fork 并启用 Actions

1. 点击右上角 **Fork**，将项目复制到自己的 GitHub 账号。
2. 后续配置都在自己的 Fork 中进行，不要把账号凭据提交到代码或 Issues。
3. 打开 **Actions**，按 GitHub 提示启用工作流。
4. 进入 **Settings → Actions → General → Workflow permissions**，允许工作流读写仓库内容（Read and write permissions）。项目需要在自己的仓库中创建和更新 `data` 分支。

### 2. 配置 Secrets

进入 **Settings → Secrets and variables → Actions → Secrets → New repository secret**，按需添加：

| Secret | 必需性 | 内容 |
| --- | --- | --- |
| `COURSE_ACCOUNT` | 登录必需 | 本人的超星账号；具体可以是手机号、邮箱或学校支持的账号形式 |
| `COURSE_PASSWORD` | 登录必需 | 对应的超星登录密码 |
| `COURSE_FID` | 默认单位有误时填写 | 学校或机构编号。浙江财经大学使用 `2128` |
| `COURSE_ENTRY_URL` | 可选 | 留空使用标准入口。学校有专用入口时，可填本人可访问的智播课堂课程列表链接 |
| `SMTP_EMAIL` | 邮件发送必需 | 发件邮箱完整地址 |
| `SMTP_PASSWORD` | 邮件发送必需 | 邮箱生成的 SMTP 授权码，不是邮箱网页登录密码 |
| `RECEIVER_EMAIL` | 邮件发送必需 | 收件邮箱；可以与发件邮箱相同，多个地址用英文逗号分隔 |
| `STATE_KEY` | 建议 | 独立、长期保留的随机字符串，用于加密发送记录 |

可选邮件参数：`SMTP_HOST`、`SMTP_PORT`。默认使用 QQ 邮箱的 `smtp.qq.com:465`。其他邮箱请填写服务商提供的 SMTP 地址和端口。

首次 `discover` 先填写 `COURSE_ACCOUNT` 和 `COURSE_PASSWORD`。如果手机号绑定了多个单位，或出现「当前单位未开通服务」，请从学校的官方入口确认机构编号并填写 `COURSE_FID`。例如，浙财学堂的「我的智播课堂」对应 `2128`，可直接用超星手机号和密码登录，`COURSE_ENTRY_URL` 留空。

部分学校使用校园统一认证、验证码或二次验证。云端账号密码登录不能保证兼容所有学校；遇到此类限制时，请使用本机浏览器登录方式，或确认学校允许的登录流程。

### 3. 先运行 `discover` 查课程名称与 ID

1. 在自己的 Fork 打开 **Actions → 课程订阅与邮件 → Run workflow**。运行分支选 **`main`**，`operation` 保持默认的 **`discover`**。
2. 点击 **Run workflow**，打开新生成的「手动运行：discover」。完成后，在左侧点 **Summary（运行摘要）**，找到「课程名称与订阅 ID」表格。也可在「查找课程名称和 ID」步骤的日志里查看。
3. 按课程名找到目标课，复制同一行的 **`courseinfoid`**。例如，下面的数字仅作格式演示：

   | 课程名称 | 课程 ID（`courseinfoid`） |
   | --- | --- |
   | 中国古代文学（示例） | `10001` |
   | 微积分（示例） | `10002` |

`discover` 只需要超星登录配置。它不会发送邮件或下载视频，首次成功发现课程后会在当前 Fork 创建 `data` 分支和空订阅清单。

如果 Fork 是公开仓库，运行摘要和日志中的课程名称与 ID 也是公开的。想在本机查看，可用[本地课程发现](docs/local.md#查找课程名称与-id)；本地查看后仍想用 Actions 归档，可[手动创建订阅文件](docs/email-setup.md#6-把课程-id-写入订阅文件)。

### 4. 把 ID 填进订阅清单

1. 点击运行摘要里的 **编辑订阅清单**。也可以手动进入自己 Fork 的 **Code → 分支菜单 → `data` → `data/subscriptions.json` → 铅笔图标**。
2. 把从课程表复制的数字用英文双引号包起来，放进 `course_ids`；多门课程用英文逗号分隔。例如：

   ```json
   {
     "course_ids": ["10001", "10002"]
   }
   ```

3. 点击 **Commit changes**，提交到 **`data`** 分支。以后增删订阅，编辑同一个文件即可。`course_ids` 不填课程名称，也不填观看回放链接里的 `speechid`。

GitHub Actions 从这个文件读取订阅，**不用设置 `COURSE_IDS` Secret**，也不用在每次运行时重新填 ID。

### 5. 用 `mail-test` 确认能收信

如果使用本机微信发送，跳过邮箱配置和 `mail-test`，按[本机微信转发说明](docs/wechat-relay.md)设置，然后运行同一个工作流的 `run`。

按[邮箱配置说明](docs/email-setup.md)填好邮箱 Secrets。回到同一个 **课程订阅与邮件** 工作流，选择 `mail-test`，运行后确认收件箱里有测试邮件。这一步只验证邮箱。

### 6. 用 `run` 归档订阅课程

再次运行 **课程订阅与邮件**，选择 `run`。手动和定时运行都从订阅清单查找已发布回放，先复查已到期的待补字幕，再处理较新的回放。

### 7. 启用每日自动检查

确认手动运行成功后，进入 **Settings → Secrets and variables → Actions → Variables → New repository variable**：

- Name：`RUN_SCHEDULED`
- Value：`true`

默认定时点为每天 **UTC 04:30（北京时间 12:30）**。处理所有待归档回放，不限制课节数。GitHub 定时任务可能延迟，启用后请观察一次实际运行。

## 分支与数据安全

每个 Fork 有自己的 `data` 分支，与程序所在的 `main` 分支分离：

| 路径 | 内容 |
| --- | --- |
| `main` | 程序、测试、文档和 GitHub Actions 工作流 |
| `data/subscriptions.json`（`data` 分支） | 用户选择的课程 ID，明文 JSON |
| `data/delivery-state.enc`（`data` 分支） | 已处理/已发送记录，加密保存 |

`data` 分支和空订阅清单由当前 Fork 首次成功执行 `discover` 时自动初始化。已有清单会保留。

如果仓库是公开的，`data/subscriptions.json` 中的课程 ID 也是公开的。不要在其中填写账号、密码、邮箱授权码或其他秘密。超星凭据和邮箱授权码必须保存在 GitHub Secrets 中。建议设置独立 `STATE_KEY` 并长期保留；如果未设置，发送记录密钥会从超星账号和密码派生，修改密码后可能无法解密旧记录。

旧版本曾将加密发送记录保存在 `archive-state` 分支。升级后的程序会读取旧记录，并在后续成功发送时迁移写入 `data` 分支；旧分支不会被自动删除。

课程视频、字幕、生成文档和浏览器登录目录不会提交到公开仓库，也不会上传为公开 Actions Artifact。它们只保存在被 Git 忽略的 `local-data/` 中，或通过配置的私有发送渠道交付。

## 本地运行

Windows、macOS 和 Linux 均可使用[本地运行说明](docs/local.md)。配置 `.env` 后，运行 `node src/run.mjs --discover` 查看课程名称与 ID，把要订阅的 ID 填入 `.env` 的 `COURSE_IDS`，再运行 `node src/run.mjs`。本地可以只生成文件，也可以通过 SMTP 或 OneBot/NapCat 发送。遇到校园统一认证或验证码时，可用本地浏览器登录。

## 验证与开发

```bash
npm test
uv run --locked python -m unittest discover -s test -p "test_*.py" -v
node test/smoke.mjs
```

本地已用真实智播课堂回放验证课件提取和 Office 文档生成；账号登录、SMTP 实际收件以及具体学校的访问权限仍需使用者自己的账号和网络环境验收。

## 使用边界

请遵守学校平台使用规范和适用的著作权要求，仅处理本人获授权访问的课程内容，用于个人学习。不要未经许可传播课程录屏、字幕、课件或生成文档。请妥善管理账号凭据、GitHub Token、SMTP 授权码和加密密钥。
