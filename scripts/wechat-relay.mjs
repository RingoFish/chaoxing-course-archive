#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { MAX_ARCHIVE, MAX_ENVELOPE, openRelay, relayFilename, relayKey } from '../src/relay-envelope.mjs';

const exec = promisify(execFile);
const API = 'https://api.github.com';
const MESSAGE_ID = /^\d{1,24}:(pptx|docx)$/;
const EMPTY = () => ({ artifacts: {}, files: {} });

async function readJson(path, fallback) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT' && fallback) return fallback(); throw error; }
}

async function store(path, value) {
  const file = await open(path + '.tmp', 'w', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(path + '.tmp', path);
}

function time() { return new Date().toISOString(); }

function github(config, path) {
  return fetch(`${API}/repos/${config.repository}/actions/artifacts${path}`, {
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
}

async function getArtifacts(config) {
  const results = [];
  for (let page = 1; ; page++) {
    const response = await github(config, `?per_page=100&page=${page}`);
    if (!response.ok) throw new Error(`GitHub 产物列表请求失败（${response.status}）。`);
    const { artifacts } = await response.json();
    if (!Array.isArray(artifacts)) throw new Error('GitHub 产物列表格式异常。');
    for (const artifact of artifacts) {
      if (!artifact.expired && /^course-relay-\d+-\d+$/.test(artifact.name) &&
          Number.isSafeInteger(artifact.id) && artifact.workflow_run?.head_branch === (config.branch || 'main') &&
          artifact.name.startsWith(`course-relay-${artifact.workflow_run.id}-`) &&
          (!config.since || Date.parse(artifact.created_at) >= Date.parse(config.since))) results.push(artifact);
    }
    if (artifacts.length < 100) break;
  }
  return results.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
}

async function downloadArtifact(config, artifact, path) {
  // Fetch the signed download separately so the repository token never goes to storage.
  const response = await fetch(`${API}/repos/${config.repository}/actions/artifacts/${artifact.id}/zip`, {
    headers: { Authorization: `Bearer ${config.githubToken}`, Accept: 'application/vnd.github+json' },
    redirect: 'manual', signal: AbortSignal.timeout(30000),
  });
  if (response.status !== 302) throw new Error(`GitHub 产物 ${artifact.id} 下载失败（${response.status}）。`);
  const signed = new URL(response.headers.get('location'));
  if (signed.protocol !== 'https:') throw new Error('GitHub 下载链接不是 HTTPS。');
  const downloaded = await fetch(signed, { redirect: 'error', signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!downloaded.ok || !downloaded.body) throw new Error(`GitHub 产物 ${artifact.id} 下载未完成。`);
  let length = 0;
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    length += chunk.length;
    callback(length > MAX_ARCHIVE ? new Error('单次交接文件超过 2 GiB。') : null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(downloaded.body), limit, createWriteStream(path + '.part', { mode: 0o600 }));
    await rename(path + '.part', path);
  } finally { await rm(path + '.part', { force: true }); }
}

async function wechat(config, path, options) {
  const response = await fetch(`http://127.0.0.1:${config.wechatPort || 18766}/api/${path}`, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(options?.method === 'POST' ? 180000 : 20000),
  });
  if (!response.ok) throw new Error(`本机微信服务拒绝操作（${response.status}）。`);
  return response.json();
}

async function checkWechat(config) {
  const status = await wechat(config, 'status');
  if (!status.dataReady || !status.sendEnabled || !status.senderReady) throw new Error('本机微信尚未登录，或发送服务未就绪。');
  const query = new URLSearchParams({ keyword: config.contact, filter: 'all', limit: '100' });
  const { contacts } = await wechat(config, 'contacts?' + query);
  const hits = contacts.filter(item => item.displayName === config.contact && item.conversationKind === 'private');
  if (hits.length !== 1 || (config.talker && hits[0].username !== config.talker) || !hits[0]?.username) {
    throw new Error('微信联系人不存在、重名，或与绑定的账号不符。');
  }
  return hits[0].username;
}

export async function deliverRelayFile(file, state, persist, send) {
  const id = `${file.meta.replay}:${file.meta.kind}`;
  if (state.files[id]?.status === 'sent') return 'already-sent';
  if (state.files[id]?.status === 'sending') return 'needs-review';
  state.files[id] = { status: 'sending', at: time() };
  await persist();
  await send(file);
  state.files[id] = { status: 'sent', at: time() };
  await persist();
  return 'sent';
}

async function sendWechat(config, talker, { meta, data }) {
  const query = new URLSearchParams({ contact: config.contact, talker, name: meta.name });
  const result = await wechat(config, 'upload?' + query, { method: 'POST', body: data,
    headers: { 'Content-Type': 'application/octet-stream' } });
  if (result.ok !== true) throw new Error('微信没有返回附件发送成功。');
}

export async function processArtifact(config, key, artifact, cache, state, persist, send) {
  const path = join(cache, `${artifact.id}.zip`);
  try { await access(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || artifact.local) throw error;
    await downloadArtifact(config, artifact, path);
  }
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar';
  const { stdout } = await exec(tar, ['-tf', path], { timeout: 60000, maxBuffer: 128 * 1024 });
  const names = stdout.trim().split(/\r?\n/);
  if (names.length > 200 || new Set(names).size !== names.length ||
      names.some(name => !/^[a-f0-9]{64}\.relay$/.test(name))) throw new Error('交接包包含未知文件。');
  const index = [];
  for (const name of names) {
    const { stdout: blob } = await exec(tar, ['-xOf', path, name], { encoding: 'buffer', maxBuffer: MAX_ENVELOPE, timeout: 90000 });
    const { meta } = openRelay(key, blob);
    if (relayFilename(key, meta.replay, meta.kind) !== name) throw new Error('交接包文件名与内容不匹配。');
    index.push({ ...meta, entry: name });
  }
  index.sort((a, b) => a.kind === b.kind ? a.replay.localeCompare(b.replay) : a.kind === 'pptx' ? -1 : 1);
  let needsReview = false;
  for (const meta of index) {
    const id = `${meta.replay}:${meta.kind}`;
    if (state.files[id]?.status === 'sent') continue;
    if (state.files[id]?.status === 'sending') { needsReview = true; continue; }
    if (meta.kind === 'docx' && state.files[`${meta.replay}:pptx`]?.status !== 'sent') { needsReview = true; continue; }
    const { stdout: blob } = await exec(tar, ['-xOf', path, meta.entry], { encoding: 'buffer', maxBuffer: MAX_ENVELOPE, timeout: 90000 });
    const file = openRelay(key, blob);
    try { await deliverRelayFile(file, state, persist, send); }
    catch {
      console.error(`附件 ${id} 发送结果未能确认，已暂停这一份；请在微信核对，再用 --resolve ${id}。`);
      needsReview = true;
    }
  }
  if (!needsReview) {
    state.artifacts[artifact.id] = time();
    await persist();
    await rm(path, { force: true });
  }
  return needsReview;
}

async function main() {
  const { values: args } = parseArgs({ options: {
    config: { type: 'string', default: 'local-data/wechat-relay/config.json' },
    check: { type: 'boolean' }, 'inbox-only': { type: 'boolean' },
    resolve: { type: 'string' }, sent: { type: 'boolean' }, retry: { type: 'boolean' },
  } });
  const inboxOnly = args['inbox-only'];
  if (inboxOnly && (args.check || args.resolve)) throw new Error('--inbox-only 不能与 --check 或 --resolve 同用。');
  const configPath = resolve(args.config);
  const config = await readJson(configPath);
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository || '') || !config.contact ||
      (config.since && !Number.isFinite(Date.parse(config.since))) ||
      (config.wechatPort && (!Number.isInteger(config.wechatPort) || config.wechatPort < 1 || config.wechatPort > 65535))) {
    throw new Error('本机转发配置无效。');
  }
  const key = relayKey(config.relayKey);
  const directory = dirname(configPath);
  const statePath = join(directory, 'state.json');
  const cache = join(directory, 'inbox');
  const persist = () => store(statePath, state);
  const lockPath = join(directory, 'run.lock');
  let state;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('另一轮转发仍在运行，或上次中断留下 run.lock。'); throw error; }
  try {
    state = await readJson(statePath, EMPTY);
    if (!state?.files || !state?.artifacts) throw new Error('本机发送记录损坏，已停止。');
    if (args.resolve) {
      const id = args.resolve;
      if (!MESSAGE_ID.test(id) || state.files[id]?.status !== 'sending' || Boolean(args.sent) === Boolean(args.retry)) {
        throw new Error('用 --resolve 回放ID:pptx --sent 或 --retry 处理待核对记录。');
      }
      if (args.sent) state.files[id] = { status: 'sent', at: time() };
      else delete state.files[id];
      await persist();
      return;
    }
    const talker = await checkWechat(config);
    if (!config.talker && !args.check) throw new Error('请先用 --check 绑定微信联系人。');
    if (!config.githubToken && !inboxOnly) {
      if (args.check && !config.talker) await store(configPath, { ...config, talker });
      throw new Error('微信接收对象核对通过；本机还缺少 GitHub Actions 只读令牌。');
    }
    const artifacts = inboxOnly ? [] : await getArtifacts(config);
    if (args.check) {
      if (!config.talker) await store(configPath, { ...config, talker });
      console.log(`微信接收对象核对通过。GitHub 可读，有 ${artifacts.length} 个有效交接包。`);
      return;
    }
    await mkdir(cache, { recursive: true });
    const remoteIds = new Set(artifacts.map(item => String(item.id)));
    // Finish cached work even if GitHub no longer lists the archive.
    for (const name of await readdir(cache)) {
      if (/^\d+\.zip$/.test(name) && !remoteIds.has(name.slice(0, -4))) {
        artifacts.unshift({ id: name.slice(0, -4), local: true });
      }
    }
    let failures = 0;
    for (const artifact of artifacts) {
      if (state.artifacts[artifact.id]) continue;
      try {
        if (await processArtifact(config, key, artifact, cache, state, persist, file => sendWechat(config, talker, file))) failures++;
      } catch (error) {
        failures++;
        // Client errors from HTTP libraries may embed a signed download URL.
        console.error(`交接包 ${artifact.id} 未完成（${error.code || error.name}），请检查下载、密钥及文件格式。`);
      }
    }
    if (failures) throw new Error(`${failures} 个交接包未完成。`);
    console.log('本轮取件完成。');
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
