#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { existsSync, realpathSync } from 'node:fs';
import { appendFile, readFile, mkdir, open, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover } from './discover.mjs';
import { saveJson } from './platform.mjs';
import { sendEmail, sendQQ } from './delivery.mjs';
import { loadRemoteState, saveRemoteState, statePassword } from './state.mjs';
import { resolveCourseSelection } from './subscriptions.mjs';
import { safeMessage } from './logging.mjs';
import { RELAY_DIR, relayFilename, relayKey, stageRelay } from './relay-envelope.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const catalogPath = join(root, 'local-data/catalog.private.json');
const ledger = join(root, 'local-data/state/delivery.json');
const TRANSCRIPT_RETRY_MS = 48 * 60 * 60 * 1000;
try { process.loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }

export function deliveryChannels(value) {
  const mode = value || 'none';
  if (!['none', 'email', 'qq', 'both', 'relay'].includes(mode)) throw new Error('DELIVERY 需为 none、email、qq、both 或 relay。');
  return mode === 'both' ? ['email', 'qq'] : mode === 'none' ? [] : [mode];
}

export function pendingReplays(replays, state, channels, now = Date.now()) {
  const due = replay => {
    const retryAt = Date.parse(state.completed?.[String(replay.speechId)]?.transcriptRetryAt);
    return retryAt <= now ? retryAt : Infinity;
  };
  return replays.filter(replay => {
    const done = state.completed?.[String(replay.speechId)] || {};
    const remaining = channels.filter(channel => !done[channel]);
    if (channels.length ? !remaining.length : done.built) return false;
    if (!(Date.parse(done.transcriptRetryAt) > now)) return true;
    return channels.length ? remaining.some(channel => !done[`${channel}Pptx`]) : !done.pptxBuilt;
  }).sort((a, b) => {
    const aDue = due(a), bDue = due(b);
    if (aDue !== bDue) return aDue < bDue ? -1 : 1;
    return String(b.date || '').localeCompare(String(a.date || '')) || Number(b.speechId) - Number(a.speechId);
  });
}

export function deliveryFiles(files, done, channel) {
  if (done[channel]) return [];
  return [done[`${channel}Pptx`] ? null : files.pptx, files.docx].filter(Boolean);
}

function displayName(name) {
  return String(name || '').replace(/[\r\n\t]+/g, ' ').trim() || '未命名课程';
}

export function courseDiscoverySummary(courses, repository) {
  const edit = `https://github.com/${repository}/edit/data/data/subscriptions.json`;
  const rows = courses.map(course => {
    const name = displayName(course.name).replace(/[&<>|`*_~\[\]\\]/g, c => `&#${c.charCodeAt(0)};`);
    return `| ${name} | \`${course.id}\` |`;
  });
  return ['## 课程名称与订阅 ID', '', '| 课程名称 | 课程 ID（courseinfoid） |', '| --- | --- |', ...rows, '',
    `1. 复制目标课程右侧的数字，打开[编辑订阅清单](${edit})。`,
    '2. 将数字加上英文双引号，填入 `course_ids` 数组。多门课程用英文逗号分隔，提交到 `data` 分支。',
    '3. 配好发送方式后运行 `run` 处理已订阅课程；使用邮箱时可先跑 `mail-test`。', '', ''].join('\n');
}

export function recordRelayUploads(state, wasUploaded, timestamp) {
  let count = 0;
  for (const [id, done] of Object.entries(state.completed)) {
    for (const [kind, receipt] of [['pptx', 'relayPptx'], ['docx', 'relay']]) {
      if (!wasUploaded(id, kind)) continue;
      done[receipt] = timestamp;
      count++;
    }
  }
  return count;
}

async function commitRelay() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.DELIVERY !== 'relay' || !process.env.GITHUB_TOKEN) {
    throw new Error('仅在 Actions 完成加密产物上传后记录交接。');
  }
  const key = relayKey(process.env.RELAY_KEY);
  const state = JSON.parse(await readFile(ledger, 'utf8'));
  const count = recordRelayUploads(state, (id, kind) => existsSync(join(root, RELAY_DIR, relayFilename(key, id, kind))),
    new Date().toISOString());
  if (!count) throw new Error('没有与本轮处理记录对应的加密附件。');
  await saveJson(ledger, state);
  await saveRemoteState(ledger);
  console.log(`已记录 ${count} 个上传成功的加密附件；微信发送状态保存在转发电脑。`);
}

async function listCourses() {
  const catalog = await discover(process.env.COURSE_ENTRY_URL, {
    includeReplays: false,
    headless: process.env.COURSE_HEADLESS !== 'false',
    profile: join(root, 'local-data/browser-profile'),
    onProgress: console.log,
  });
  await resolveCourseSelection({ initialize: true });
  await saveJson(catalogPath, catalog);
  console.log('当前账号可访问的智播课堂课程：');
  for (const course of catalog.courses) {
    console.log(`- ${displayName(course.name)}：courseinfoid=${course.id}`);
  }
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log('在 data 分支的 data/subscriptions.json 中填写 course_ids；也可从本次运行的 Summary 直接进入编辑页。');
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, courseDiscoverySummary(catalog.courses, process.env.GITHUB_REPOSITORY));
    }
  } else {
    console.log('将上面的课程 ID 填入 .env 的 COURSE_IDS，多门用英文逗号分隔。');
  }
}

async function run() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, discover: { type: 'boolean' }, 'mail-test': { type: 'boolean' }, 'commit-relay': { type: 'boolean' } } });
  if (values['commit-relay']) return commitRelay();
  if (values.help) {
    console.log('课程订阅归档\n  node src/run.mjs --discover   列出课程名称和 courseinfoid\n  node src/run.mjs --mail-test  测试邮箱\n  node src/run.mjs              处理已订阅课程');
    return;
  }
  const operation = values['mail-test'] ? 'mail-test' : values.discover ? 'discover' : (process.env.COURSE_OPERATION || 'run');
  if (operation === 'mail-test') {
    await sendEmail([], { test: true });
    console.log('测试邮件已交给 SMTP 服务器。');
    return;
  }

  if (operation === 'discover') {
    await listCourses();
    return;
  }
  if (operation !== 'run') throw new Error('COURSE_OPERATION 只能是 discover、mail-test 或 run。');

  const hosted = process.env.GITHUB_ACTIONS === 'true';
  const courseIds = await resolveCourseSelection();
  if (!courseIds.length) throw new Error(hosted
    ? '尚无订阅课程。请先执行 discover，再编辑 data 分支的 data/subscriptions.json。'
    : '尚无订阅课程。请先运行 node src/run.mjs --discover，再在 .env 填写 COURSE_IDS。');
  const channels = deliveryChannels(process.env.DELIVERY);
  if (process.env.GITHUB_ACTIONS === 'true' && !channels.length) {
    throw new Error('Actions 请设置 DELIVERY=email 或 DELIVERY=relay。');
  }
  if (!hosted && channels.includes('relay')) throw new Error('DELIVERY=relay 由 GitHub Actions 运行；本机仅启动转发脚本。');
  const key = channels.includes('relay') ? relayKey(process.env.RELAY_KEY) : null;
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) statePassword();
  if (channels.includes('email') &&
      (!(process.env.SMTP_USERNAME || process.env.SMTP_EMAIL) ||
       !process.env.SMTP_PASSWORD ||
       !(process.env.MAIL_TO || process.env.RECEIVER_EMAIL))) {
    throw new Error('邮箱配置不完整，请先设置 SMTP_EMAIL、SMTP_PASSWORD、RECEIVER_EMAIL 并运行 mail-test。');
  }

  const max = Number(process.env.MAX_LECTURES || 3);
  if (!Number.isInteger(max) || max < 1 || max > 100) {
    throw new Error('MAX_LECTURES 需为 1 到 100 的整数。');
  }
  const work = resolve(root, process.env.COURSE_WORK || 'local-data/jobs');
  const runCatalogPath = join(work, 'subscriptions-run.private.json');
  const output = resolve(root, process.env.COURSE_OUTPUT || 'local-data/final');
  const lock = join(root, 'local-data/run.lock');
  await mkdir(join(root, 'local-data/state'), { recursive: true });

  let handle;
  try {
    handle = await open(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('另一轮抓取仍在运行，或上次异常退出留下 local-data/run.lock；确认无运行任务后删除该文件再试。');
    }
    throw error;
  }

  try {
    await handle.writeFile(String(process.pid));
    if (key) await rm(join(root, RELAY_DIR), { recursive: true, force: true });
    await loadRemoteState(ledger);
    let state = { completed: {} };
    try {
      state = JSON.parse(await readFile(ledger, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('发送状态文件损坏，已停止以避免重复发送。');
    }

    const manifest = await discover(process.env.COURSE_ENTRY_URL, {
      courseIds,
      headless: process.env.COURSE_HEADLESS !== 'false',
      profile: join(root, 'local-data/browser-profile'),
      onProgress: console.log,
    });

    await saveJson(runCatalogPath, manifest);
    const pending = pendingReplays(manifest.replays, state, channels).slice(0, max);
    console.log('发现 ' + manifest.replays.length + ' 节已发布回放，本轮处理 ' + pending.length + ' 节。');

    let failures = 0;
    for (const [index, replay] of pending.entries()) {
      const id = String(replay.speechId);
      if (!/^\d+$/.test(id)) throw new Error('回放编号无效。');
      console.log('开始第 ' + (index + 1) + '/' + pending.length + ' 节。');
      try {
        const dir = join(work, id);
        const out = join(output, id);
        const done = state.completed[id] || {};
        const pptxReady = channels.length ? channels.every(channel => done[channel] || done[`${channel}Pptx`]) : done.pptxBuilt;
        const args = [join(root, 'src/archive-lecture.mjs'), runCatalogPath, id, dir, out];
        if (pptxReady) args.push('--check-transcript');
        const child = exec(process.execPath,
          args,
          { cwd: root, maxBuffer: 8e6, timeout: 5 * 60 * 60 * 1000, env: process.env });
        child.child.stderr.on('data', chunk => process.stderr.write(chunk));
        const { stdout } = await child;
        const files = JSON.parse(stdout);
        const timestamp = new Date().toISOString();
        state.completed[id] = done;
        if (files.pptx) done.pptxBuilt = timestamp;
        if (files.docx) done.built = timestamp;
        done.transcriptRetryAt = files.transcriptPending ? new Date(Date.now() + TRANSCRIPT_RETRY_MS).toISOString() : null;
        await saveJson(ledger, state);
        if (files.transcriptPending) await saveRemoteState(ledger);
        for (const channel of channels) {
          const attachments = deliveryFiles(files, done, channel);
          if (!attachments.length) continue;
          if (channel === 'relay') {
            await stageRelay(join(root, RELAY_DIR), id, attachments, key);
            continue;
          }
          if (channel === 'email') await sendEmail(attachments);
          else await sendQQ(attachments, output);
          const receipt = files.docx ? channel : `${channel}Pptx`;
          done[receipt] = new Date().toISOString();
          await saveJson(ledger, state);
          await saveRemoteState(ledger);
        }
        if (files.transcriptPending) {
          console.log('第 ' + (index + 1) + ' 节' + (files.pptx ? '已生成 PPTX。' : '已复查字幕。') +
            '平台暂未提供讲解字幕，下次复查时间 ' + done.transcriptRetryAt + '。');
        } else console.log('第 ' + (index + 1) + ' 节完成：' + files.pages + ' 页课件，' + files.segments + ' 段讲解。');
      } catch (error) {
        failures++;
        // Avoid echoing subprocess command strings containing signed URLs.
        const message = error.stderr
          ? String(error.stderr).trim().split('\n').at(-1)
          : error.killed ? '处理子进程超时。' : error.message;
        console.error('第 ' + (index + 1) + ' 节失败：' + safeMessage(message));
      }
    }
    if (failures) {
      throw new Error(failures + ' 节处理或发送失败，成功记录已保存；重跑会继续未完成项。');
    }
    console.log('本轮完成。');
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => {
    console.error(safeMessage(error.stderr?.trim().split('\n').at(-1) || error.message));
    process.exitCode = 1;
  });
}
