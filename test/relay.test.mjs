import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deliverRelayFile } from '../scripts/wechat-relay.mjs';
import { openRelay, relayFilename, sealRelay } from '../src/relay-envelope.mjs';

const meta = { replay: '1234', kind: 'pptx', name: '示例课件.pptx' };
const content = Buffer.from('test lecture data');

test('relay hides the lecture metadata and rejects modified ciphertext or wrong keys', () => {
  const key = randomBytes(32);
  const sealed = sealRelay(key, meta, content);
  assert.match(relayFilename(key, meta.replay, meta.kind), /^[a-f0-9]{64}\.relay$/);
  assert.notEqual(relayFilename(key, meta.replay, meta.kind), relayFilename(key, meta.replay, 'docx'));
  assert.equal(sealed.includes(content), false);
  assert.equal(sealed.includes(Buffer.from(meta.name)), false);
  assert.deepEqual(openRelay(key, sealed), { meta, data: content });
  assert.throws(() => openRelay(randomBytes(32), sealed), /认证失败/);
  sealed[sealed.length - 1] ^= 1;
  assert.throws(() => openRelay(key, sealed), /认证失败/);
  assert.throws(() => sealRelay(key, { ...meta, name: '../x.pptx' }, content), /文件名无效/);
});

test('confirmed files and uncertain sends are skipped independently', async () => {
  const state = { files: {} };
  const snapshots = [];
  const persist = () => snapshots.push(structuredClone(state.files));
  const sends = [];
  const send = ({ meta }) => {
    sends.push(meta.kind);
    assert.equal(snapshots.at(-1)[`1234:${meta.kind}`].status, 'sending');
    if (meta.kind === 'docx') throw new Error('Connection lost after submitting');
  };
  const pptx = { meta, data: content };
  const docx = { meta: { ...meta, kind: 'docx', name: '讲义.docx' }, data: content };
  assert.equal(await deliverRelayFile(pptx, state, persist, send), 'sent');
  await assert.rejects(deliverRelayFile(docx, state, persist, send), /Connection lost/);
  assert.equal(await deliverRelayFile(pptx, state, persist, send), 'already-sent');
  assert.equal(await deliverRelayFile(docx, state, persist, send), 'needs-review');
  assert.deepEqual(sends, ['pptx', 'docx']);
});
