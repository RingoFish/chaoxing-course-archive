import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const MAGIC = Buffer.from('CXRELAY1');
export const MAX_FILE = 100 * 1024 * 1024;
export const MAX_ENVELOPE = MAX_FILE + 8192;
export const MAX_ARCHIVE = 2 * 1024 * 1024 * 1024;
export const RELAY_DIR = 'local-data/relay-outbox';
// Revision 2 marks files using the "<course> 课件/讲义 NN" names; the relay
// tracks it separately so earlier deliveries do not suppress the resend.
export const RELAY_REVISION = 2;

export function relayKey(encoded) {
  if (!/^[a-f0-9]{64}$/i.test(encoded || '')) throw new Error('RELAY_KEY 需要 64 位十六进制随机值。');
  return Buffer.from(encoded, 'hex');
}

export function relayFilename(key, replay, kind) {
  return createHmac('sha256', key).update(`filename:${replay}:${kind}`).digest('hex') + '.relay';
}

function validate(meta) {
  if (typeof meta?.replay !== 'string' || !/^\d{1,24}$/.test(meta.replay) ||
      !['pptx', 'docx'].includes(meta.kind) || typeof meta.name !== 'string' ||
      !meta.name || meta.name.length > 180 || /[<>:"/\\|?*\x00-\x1f]/.test(meta.name) ||
      extname(meta.name).toLowerCase() !== '.' + meta.kind ||
      (meta.revision !== undefined && (!Number.isInteger(meta.revision) || meta.revision < 2 || meta.revision > 99))) throw new Error('加密附件的标识或文件名无效。');
}

export function sealRelay(key, meta, data) {
  validate(meta);
  if (!data.length || data.length > MAX_FILE) throw new Error('附件为空，或超过微信转发端的 100 MiB 上限。');
  const json = Buffer.from(JSON.stringify(meta));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(json.length);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const encrypted = [cipher.update(size), cipher.update(json), cipher.update(data), cipher.final()];
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ...encrypted]);
}

export function openRelay(key, blob) {
  if (blob.length < 42 || blob.length > MAX_ENVELOPE || !blob.subarray(0, 8).equals(MAGIC)) {
    throw new Error('加密附件格式无效。');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(8, 20));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(blob.subarray(20, 36));
  const decoded = decipher.update(blob.subarray(36));
  try { decipher.final(); } catch { throw new Error('附件认证失败，请核对密钥和下载来源。'); }
  const size = decoded.readUInt32BE();
  if (size < 2 || size > 4096 || size + 4 >= decoded.length) throw new Error('加密附件头无效。');
  const meta = JSON.parse(decoded.subarray(4, 4 + size).toString());
  validate(meta);
  const data = decoded.subarray(4 + size);
  if (data.length > MAX_FILE) throw new Error('附件超过微信转发端的 100 MiB 上限。');
  return { meta, data };
}

export async function stageRelay(dir, replay, attachments, key) {
  await mkdir(dir, { recursive: true });
  const entries = (await readdir(dir)).filter(name => name.endsWith('.relay'));
  let total = (await Promise.all(entries.map(name => stat(join(dir, name))))).reduce((n, entry) => n + entry.size, 0);
  for (const path of attachments) {
    const kind = extname(path).slice(1).toLowerCase();
    const name = basename(path);
    const { size } = await stat(path);
    if (size > MAX_FILE) throw new Error('附件超过微信转发端的 100 MiB 上限。');
    total += size + 8192;
    // Leave room for the ZIP directory and the per-file encryption headers.
    if (total > MAX_ARCHIVE - 1024 * 1024) {
      const error = new Error('本轮交接包达到 2 GiB 上限；未上传的附件将在后续运行继续处理。');
      error.code = 'RELAY_OUTBOX_FULL';
      throw error;
    }
    const target = join(dir, relayFilename(key, replay, kind));
    await writeFile(target + '.part', sealRelay(key, { replay, kind, name, revision: RELAY_REVISION }, await readFile(path)), { mode: 0o600 });
    await rename(target + '.part', target);
  }
}
