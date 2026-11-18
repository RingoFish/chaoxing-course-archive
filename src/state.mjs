import { createHash, createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { saveJson } from './platform.mjs';

const DATA_BRANCH = 'data';
const STATE_PATH = 'data/delivery-state.enc';
const LEGACY_BRANCH = 'archive-state';
const LEGACY_PATH = 'delivery-state.enc';

// Compatible port of icourse/src/data/crypto_box.py's ICSv2 envelope.
export function statePassword(env = process.env) {
  if (env.STATE_KEY) return env.STATE_KEY;
  if (!env.COURSE_ACCOUNT || !env.COURSE_PASSWORD) {
    throw new Error('持久发送记录需要 COURSE_ACCOUNT / COURSE_PASSWORD 或独立 STATE_KEY。');
  }
  return createHash('sha256').update('ICSv2:' + env.COURSE_ACCOUNT + ':' + env.COURSE_PASSWORD).digest('hex');
}

export function encryptState(state, password) {
  const salt = randomBytes(8), keyiv = pbkdf2Sync(password, salt, 100000, 48, 'sha256');
  const cipher = createCipheriv('aes-256-cbc', keyiv.subarray(0, 32), keyiv.subarray(32));
  return Buffer.concat([Buffer.from('Salted__'), salt, cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
}

export function decryptState(blob, password) {
  if (blob.length < 32 || blob.subarray(0, 8).toString() !== 'Salted__') {
    throw new Error('发送记录加密格式无效。');
  }
  const keyiv = pbkdf2Sync(password, blob.subarray(8, 16), 100000, 48, 'sha256');
  try {
    const cipher = createDecipheriv('aes-256-cbc', keyiv.subarray(0, 32), keyiv.subarray(32));
    const state = JSON.parse(Buffer.concat([cipher.update(blob.subarray(16)), cipher.final()]).toString('utf8'));
    if (!state.completed || Array.isArray(state.completed) || typeof state.completed !== 'object') throw new Error();
    return state;
  } catch {
    throw new Error('发送记录解密失败。若账号密码已修改，请使用原 STATE_KEY；不要删除状态后直接重跑。');
  }
}

export function mergeState(remote, local) {
  const completed = { ...remote.completed };
  for (const [id, entry] of Object.entries(local.completed || {})) {
    completed[id] = { ...completed[id], ...entry };
  }
  return { completed };
}

async function api(path, options = {}) {
  const { allowMissing, ...requestOptions } = options;
  const response = await fetch('https://api.github.com/repos/' + process.env.GITHUB_REPOSITORY +
    (path ? '/' + path : ''), {
    ...requestOptions,
    headers: {
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...requestOptions.headers,
    },
    signal: AbortSignal.timeout(60000),
  });
  if (response.status === 404 && allowMissing) return null;
  if (!response.ok) {
    throw new Error('GitHub 发送记录请求失败 HTTP ' + response.status + '；未把错误当成首次运行。');
  }
  return response.status === 204 ? null : response.json();
}

async function decodeRemote(remote, password) {
  // Decode the immutable blob matching the SHA used for optimistic updates.
  // The Contents API may return a stale inline body with current file metadata.
  if (!/^[a-f0-9]{40}$/.test(remote.sha || '')) throw new Error('GitHub 发送记录缺少有效的文件版本。');
  const blob = await api('git/blobs/' + remote.sha);
  if (blob.sha !== remote.sha || blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new Error('GitHub 发送记录文件格式无效。');
  }
  const raw = Buffer.from(blob.content, 'base64');
  if (raw.length !== blob.size) throw new Error('GitHub 发送记录文件长度与响应不符。');
  return decryptState(raw, password);
}

export async function loadRemoteState(path) {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return;
  const password = statePassword();
  let cached;
  try {
    cached = await readFile(join(dirname(path), 'delivery-state.enc'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // New installations keep subscriptions and encrypted delivery receipts on
  // the same per-fork data branch. Read archive-state as a one-time migration
  // source for repositories created by earlier versions.
  const current = await api('contents/' + STATE_PATH + '?ref=' + DATA_BRANCH, { allowMissing: true });
  const legacy = current ? null : await api('contents/' + LEGACY_PATH + '?ref=' + LEGACY_BRANCH, { allowMissing: true });
  const remote = current || legacy;
  if (!remote && !cached) return;

  const remoteState = remote ? await decodeRemote(remote, password) : { completed: {} };
  let local = { completed: {} };
  try {
    local = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const merged = cached ? mergeState(remoteState, decryptState(cached, password)) : remoteState;
  await saveJson(path, mergeState(merged, local));
}

export async function saveRemoteState(path) {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return;
  const local = JSON.parse(await readFile(path, 'utf8'));
  const password = statePassword();
  const cache = join(dirname(path), 'delivery-state.enc');
  await writeFile(cache + '.tmp', encryptState(local, password), { mode: 0o600 });
  await rename(cache + '.tmp', cache);

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await api('contents/' + STATE_PATH + '?ref=' + DATA_BRANCH, { allowMissing: true });
    const legacy = current ? null : await api('contents/' + LEGACY_PATH + '?ref=' + LEGACY_BRANCH, { allowMissing: true });
    const remote = current || legacy;
    const state = remote ? mergeState(await decodeRemote(remote, password), local) : local;
    const payload = {
      message: 'chore(state): update encrypted delivery receipts',
      branch: DATA_BRANCH,
      content: encryptState(state, password).toString('base64'),
      ...(current ? { sha: current.sha } : {}),
    };
    try {
      await api('contents/' + STATE_PATH, { method: 'PUT', body: JSON.stringify(payload) });
      return;
    } catch (error) {
      if (attempt === 2 || !/HTTP 409|HTTP 422/.test(error.message)) throw error;
    }
  }
}
