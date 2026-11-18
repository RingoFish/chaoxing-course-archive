# GitHub 生成课件，本机微信发送

GitHub Actions 登录超星、识别课件、生成 PPTX 和 Word，再把加密附件放入本次运行的 **Artifacts**。Windows 电脑只下载、解密、发送。Windows 无需安装 FFmpeg 或语音模型，也无需填超星账号密码。

## 在 GitHub 设置

1. 在自己的 Fork 完成 `discover` 和课程订阅。先完成本机配置，再切换发送方式。
2. 生成独立随机密钥：`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`。把相同的 64 位十六进制值保存到 Fork 的 **Settings → Secrets and variables → Actions → Secrets** 中，名称为 `RELAY_KEY`，并另存到本机私有配置。请勿把它提交到仓库。
3. 同一页面切换到 **Variables → New repository variable**，设 `DELIVERY` 为 `relay`。邮箱 Secrets 可以保留，但 `relay` 不会尝试邮件发送。
4. 打开 **Actions → 课程订阅与邮件 → Run workflow**，选 `main`、`operation=run`，第一次建议 `max_lectures=1`。如要每天自动归档，在同一 **Variables** 页面设 `RUN_SCHEDULED=true`；可用 `MAX_LECTURES` 限制每次处理节数。开启后也会逐步处理仍未通过此渠道交接的旧回放。

## 在 Windows 配置一次

需要 Node.js 22 或更新版、Windows 的 `tar.exe`、以及已登录并启用发送的本机微信服务。转发脚本使用 Akasha 兼容接口（`GET /api/status`、`GET /api/contacts`、`POST /api/upload`）；端口默认 `18766`，仅连接本机 `127.0.0.1`。

在 GitHub 头像 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** 下，选择拥有 Fork 的账号为 **Resource owner**，仓库只选自己的归档 Fork，权限选 **Repository permissions → Actions → Read-only**（GitHub 也会自动加上只读 Metadata）。GitHub 的产物下载要求登录，即使 Fork 是公开仓库。令牌只保存在 Windows，过期后替换本机配置里的 `githubToken`。

在项目目录创建 `local-data/wechat-relay/config.json`（UTF-8），替换下面的示例值：

```json
{
  "repository": "your-github-account/chaoxing-course-archive",
  "branch": "main",
  "githubToken": "本机使用的 GitHub 只读令牌",
  "relayKey": "与 Actions 的 RELAY_KEY 相同的值",
  "wechatPort": 18766,
  "contact": "微信中显示的完整联系人名称"
}
```

在项目目录运行以下命令。`--check` 只核对微信联系人和 GitHub 读权限，并保存唯一匹配的会话；不会发送文件。

```powershell
node scripts/wechat-relay.mjs --check
./scripts/install-wechat-relay.ps1 -Config ./local-data/wechat-relay/config.json
```

计划任务在当前 Windows 用户登录后每 15 分钟取件，无需保持终端打开。Windows 注销、睡眠或本机微信不可用时不会发送；恢复后下次运行继续。也可在机器上手动运行 `node scripts/wechat-relay.mjs` 立即取件。

## 补发、确认和限制

- GitHub 与 Windows 分别记账。GitHub 只在加密包上传成功后记录已交接；本机按「回放 ID + PPTX / Word」分别记录微信发送。重新运行不会重复发送已确认的附件。
- 字幕未生成时可以先发 PPTX。平台字幕出现后，下一次到期复查只交接 Word。
- 文件最多 100 MiB／份。Actions 的加密产物保留 30 天；下载到本机的加密包可继续处理。要保留已发送记录，请勿删除本机 `state.json`。本机下载的压缩包在发送完成后清理。
- 本机 `latest.stderr.log` 和 `previous-error.log` 可用于检查发送失败。若日志写明结果不确定，先在微信确认该文件，再执行 `node scripts/wechat-relay.mjs --resolve 1234:pptx --sent`（已经发出）或 `node scripts/wechat-relay.mjs --resolve 1234:pptx --retry`（确定没发出）。Word 用 `1234:docx`。微信拒绝发送草稿尚未清空的聊天；先处理草稿再重试。
- 若上次突然中断且留下 `run.lock`，确认计划任务和手动脚本都已停止后再移除它。此前开始但没有确认的附件仍需核对。
