# 邮箱与课程订阅配置

本文以 QQ 邮箱为例，说明 GitHub Actions 的邮箱配置、课程发现和订阅管理。所有设置都应在使用者自己的 Fork 中完成。

## 1. 获取 SMTP 授权码

1. 登录自己的 QQ 邮箱网页版。
2. 打开 **设置 → 账户** 或 **账号与安全**。
3. 找到 **POP3/IMAP/SMTP**、**SMTP 服务** 或第三方客户端设置。
4. 按邮箱提示开启 SMTP 并完成安全验证。
5. 生成并保存 SMTP 授权码。

`SMTP_PASSWORD` 必须填写邮箱生成的授权码，不是 QQ 登录密码或邮箱网页登录密码。不要把授权码提交到代码、Issues 或聊天记录中。

## 2. Fork 项目并启用 Actions

1. 在 GitHub 项目页点击 **Fork**，复制到自己的账号。
2. 进入自己的 Fork，打开 **Actions** 并启用工作流。
3. 打开 **Settings → Actions → General → Workflow permissions**，允许工作流读写仓库内容（Read and write permissions）。

## 3. 配置邮箱 Secrets

打开 **Settings → Secrets and variables → Actions → Secrets → New repository secret**，逐个添加：

| Name | Secret 内容 |
| --- | --- |
| `SMTP_EMAIL` | 发件邮箱完整地址，例如自己的 QQ 邮箱 |
| `SMTP_PASSWORD` | 第 1 步生成的 SMTP 授权码 |
| `RECEIVER_EMAIL` | 收件邮箱；可与发件邮箱相同，多个地址用英文逗号分隔 |

QQ 邮箱通常不需要额外设置服务器参数，默认值为 `SMTP_HOST=smtp.qq.com`、`SMTP_PORT=465`。其他邮箱请填写其官方 SMTP SSL 地址和端口。

## 4. 配置超星账号和课程入口

仍在 **New repository secret** 中添加：

| Name | 填写内容 |
| --- | --- |
| `COURSE_ACCOUNT` | 本人的超星账号；按学校实际登录方式填写手机号、邮箱或账号名 |
| `COURSE_PASSWORD` | 对应的超星登录密码 |
| `COURSE_FID` | 默认单位有误时，填学校机构编号。浙江财经大学填 `2128` |
| `COURSE_ENTRY_URL` | 可选。留空使用标准课程列表。学校有专用入口时，可填本人可访问的课程列表链接 |
| `STATE_KEY` | 建议设置为密码管理器生成的长期随机字符串 |

浙江财经大学用户在 Secrets 填写超星手机号 `COURSE_ACCOUNT`、对应的 `COURSE_PASSWORD`，以及 `COURSE_FID=2128`，然后运行 `discover`。无需从浏览器复制带会话参数的网址。

有些学校使用校园统一认证、验证码或二次验证，云端账号密码登录不一定适用。遇到此类情况，可在本机使用浏览器登录模式；不要把学校登录凭据交给他人代配置。

## 5. 先用 `discover` 获取课程名称和 ID

进入自己的 Fork，打开 **Actions → 课程订阅与邮件 → Run workflow**，运行分支选 `main`，`operation` 选 `discover`。打开「手动运行：discover」并查看 **Summary（运行摘要）**。课程名称和对应的 `courseinfoid` 会并排列出，例如「微积分（示例）｜`10002`」。同样的信息也在「查找课程名称和 ID」步骤的日志中。这一步不会下载视频或发送邮件。

公开 Fork 的运行摘要和日志可被他人查看。只想在自己电脑上查看课程清单时，使用[本地发现命令](local.md#查找课程名称与-id)。

## 6. 把课程 ID 写入订阅文件

运行摘要里点击 **编辑订阅清单**，或在 **Code → `data` 分支 → `data/subscriptions.json`** 点铅笔图标。首次成功运行 `discover` 会创建该文件。将想订阅的课程对应的 ID 填入 `course_ids`，保留每个数字的英文双引号，多门课用英文逗号分隔。下面是示例，请换成自己查到的数字：

```json
{
  "course_ids": ["10001", "10002"]
}
```

点击 **Commit changes**，提交到 `data` 分支。课程 ID 填在这里，邮箱和登录凭据仍填在 Secrets 中。以后修改订阅时继续编辑这个文件。

如果通过本地命令查到了 ID，且没有在 Actions 运行 `discover`，可以在自己 Fork 的 **Code** 页面用分支菜单从 `main` 创建 `data` 分支（已有就直接选它），再通过 **Add file → Create new file** 创建 `data/subscriptions.json`，填上面的 JSON 并提交。如果 Fork 公开，这个文件里的课程 ID 仍是公开的。

## 7. 发送测试邮件

1. 打开 **Actions → 课程订阅与邮件**。
2. 点击 **Run workflow**，运行分支选择 `main`。
3. `operation` 选择 `mail-test`，然后运行。
4. 等待 「发送邮箱测试邮件」 步骤完成，并检查收件箱和垃圾邮件夹。

该操作只测试 SMTP，不会登录超星、读取课程或下载视频。步骤变绿表示 SMTP 服务器接受了邮件；仍应检查收件箱确认实际投递。

## 8. 运行课程归档

测试邮件到达后，从 `main` 再次运行 **课程订阅与邮件**：

- `operation` 选择 `run`，处理长期订阅课程。

平台暂时没有字幕时先发 PPTX，48 小时后在下一轮 `run` 中优先复查。字幕可用后生成 Word，接收过 PPTX 的渠道只收到补发的 DOCX。

## 9. 启用定时检查

确认手动归档成功后，打开 **Settings → Secrets and variables → Actions → Variables → New repository variable**：

- Name：`RUN_SCHEDULED`
- Value：`true`

默认每天 UTC 04:30（北京时间 12:30）运行，不限制每轮课节数。定时任务可能延迟，可随时手动运行。

## 10. 数据分支与安全

每个 Fork 独立维护 `data` 分支：

- `data/subscriptions.json`：明文课程 ID 列表。
- `data/delivery-state.enc`：加密的回放处理和发送记录。

如果仓库是公开的，课程 ID 列表也是公开的。不要把账号、密码、邮箱授权码、GitHub Token 或其他秘密写入该分支。建议设置并长期保留 `STATE_KEY`；如果未设置，发送记录密钥会从超星账号和密码派生，修改密码后可能无法解密旧记录。

旧版本使用 `archive-state` 分支保存加密发送记录。升级后的程序会读取旧记录，并在后续成功发送时迁移写入 `data` 分支；旧分支不会自动删除。

## 常见问题

| 现象 | 处理方法 |
| --- | --- |
| SMTP 认证失败 | 检查是否填写授权码、SMTP 是否已开启、发件邮箱地址是否正确 |
| 测试邮件显示成功但未收到 | 检查收件地址、垃圾邮件夹和邮箱拦截设置 |
| 当前单位未开通智播课堂 | 检查超星个人空间当前选中的单位。账号密码模式请将 `COURSE_FID` 设为学校官方入口对应的机构编号 |
| 课程发现提示未进入课程列表 | 在浏览器确认该账号和单位能进入智播课堂。有专用入口时，可用 `COURSE_ENTRY_URL` 覆盖标准链接 |
| 登录要求验证码或二次验证 | 使用本机浏览器登录模式；云端账号密码登录不保证支持学校统一认证 |
| 课程 ID 不在可访问列表 | 确认 ID 来自当前账号、当前课程列表和正确学期；检查是否已失去课程访问权限 |
| 没有找到可处理回放 | 该课节可能尚未发布回放，或平台未提供可用的观看回放链接 |
| 视频下载超时 | 学校视频域名可能只允许校内网络访问；改用能访问该地址的本地网络运行 |
| 发送记录无法解密 | 使用最初设置的 `STATE_KEY`；不要删除加密状态后直接重跑 |

请遵守学校平台使用规范，仅处理本人获授权访问的课程内容，并妥善管理账号凭据和加密密钥。
