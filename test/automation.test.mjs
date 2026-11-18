import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { publishedReplays, courseListParameters, courseRecordParameters, selectCourses } from '../src/discover.mjs';
import { encryptLoginField, loginWithSecrets } from '../src/auth.mjs';
import { encryptState, decryptState, loadRemoteState, saveRemoteState, statePassword, mergeState } from '../src/state.mjs';
import { courseDiscoverySummary, deliveryChannels, deliveryFiles, pendingReplays, recordRelayUploads } from '../src/run.mjs';
import { safeMessage } from '../src/logging.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

test('discovery includes only playable published records', () => {
  const records = [
    { speechid: 1, status: 3, respublish: 1, pcplayerurl: 'https://example.test/one' },
    { speechid: 2, status: 3, respublish: 0, pcplayerurl: 'https://example.test/two' },
    { speechid: 3, status: 2, respublish: 1, pcplayerurl: 'https://example.test/three' },
    { speechid: 4, status: 3, respublish: 1, isopen: 1, pcplayerurl: 'https://example.test/four' },
  ];
  assert.deepEqual(publishedReplays(records, { id: 20, name: 'Course' }).map(r => r.speechId), [1]);
  const p = courseRecordParameters({ model: { jsgh: 'T', kcbh: 'C', fid: 30 } }, { id: 20, enc: 'signature' }, { xn: '2026', xq: '1' });
  assert.equal(p.jsgh, 'T'); assert.equal(p.fid, '30');
  assert.throws(() => courseRecordParameters({}, { id: 1 }, {}));
});

test('course selection uses platform course IDs, not course-name keywords', () => {
  const courses = [
    { id: 20, name: '物理化学' },
    { id: 30, name: '无机化学' },
  ];
  assert.deepEqual(selectCourses(courses, ['30']).map(c => c.id), [30]);
  assert.deepEqual(selectCourses(courses, []).map(c => c.id), [20, 30]);
  assert.throws(() => selectCourses(courses, ['999']), /不在当前账号可访问/);
});

test('course list requests retain the week and signed login name from the page', () => {
  const html = `<input id="fid" value="123"><input id="xn" value="2026"><input id="xq" value="1">
    <input id="djz" value="10"><input id="loginname" value="student"><input id="loginnameenc" value="sample&amp;signature">`;
  const params = courseListParameters(html);
  assert.equal(params.djz, '10');
  assert.equal(params.loginname, 'student');
  assert.equal(params.loginnameenc, 'sample&signature');
  assert.equal(params.fid, '123');
});

test('course list diagnostics distinguish a disabled institution from a login page', () => {
  const body = JSON.stringify({ status: false, msg: '当前单位123未开通服务，请联系管理员开通！' });
  assert.throws(() => courseListParameters(body), /单位 123.*COURSE_FID/);
  assert.throws(() => courseListParameters('<input id="fid" value="-1">'), /未进入智播课堂课程列表/);
});

test('login encryption roundtrips with the official AES parameters', () => {
  const key = Buffer.from('u2oh6Vu^HWe4_AES');
  const cipher = createDecipheriv('aes-128-cbc', key, key);
  const result = Buffer.concat([cipher.update(Buffer.from(encryptLoginField('sample-only'), 'base64')), cipher.final()]).toString();
  assert.equal(result, 'sample-only');
});

test('CAPTCHA/2FA login never becomes false success and credentials are never echoed', async () => {
  const context = { request: { get: async () => ({}), post: async () => ({ ok: () => true,
    json: async () => ({ status: true, containTwoFactorLogin: true }) }) } };
  await assert.rejects(loginWithSecrets(context, { account: 'test-account', password: 'test-password' }), /二次验证/);
});

test('encrypted delivery state uses icourse-compatible Salted__ envelope', () => {
  const value = { completed: { '1': { email: '2026-11-16' } } }, password = statePassword({ COURSE_ACCOUNT: 'test', COURSE_PASSWORD: 'pass' });
  const blob = encryptState(value, password);
  assert.equal(blob.subarray(0, 8).toString(), 'Salted__');
  assert.deepEqual(decryptState(blob, password), value);
  const keyiv = pbkdf2Sync(password, blob.subarray(8, 16), 100000, 48, 'sha256');
  const cipher = createDecipheriv('aes-256-cbc', keyiv.subarray(0, 32), keyiv.subarray(32));
  assert.deepEqual(JSON.parse(Buffer.concat([cipher.update(blob.subarray(16)), cipher.final()]).toString()), value);
  assert.throws(() => decryptState(blob, 'wrong'), /解密失败/);
  assert.deepEqual(mergeState(value, { completed: { '1': { qq: 'later' } } }).completed['1'], { email: '2026-11-16', qq: 'later' });
});

test('remote delivery receipts use the Git blob matching the optimistic update SHA', async t => {
  const env = { GITHUB_REPOSITORY: 'example/course', GITHUB_TOKEN: 'fixture-token', STATE_KEY: 'fixture-key' };
  const oldEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const directory = await mkdtemp(join(tmpdir(), 'receipt-test-'));
  t.after(async () => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'state.json');
  const sha = 'a'.repeat(40);
  const existing = { completed: { 1: { email: 'existing' } } };
  const raw = encryptState(existing, env.STATE_KEY);
  let update;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/git/blobs/' + sha)) {
      return Response.json({ sha, size: raw.length, encoding: 'base64', content: raw.toString('base64') });
    }
    if (options.method === 'PUT') {
      update = JSON.parse(options.body);
      return Response.json({}, { status: 200 });
    }
    assert.match(url, /\/contents\/data\/delivery-state\.enc\?ref=data$/);
    return Response.json({ sha, encoding: 'base64', content: 'inconsistent-inline-body' });
  });
  await loadRemoteState(path);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), existing);
  await writeFile(path, JSON.stringify({ completed: { 1: { relay: 'new' } } }));
  await saveRemoteState(path);
  assert.equal(update.sha, sha);
  assert.deepEqual(decryptState(Buffer.from(update.content, 'base64'), env.STATE_KEY), {
    completed: { 1: { email: 'existing', relay: 'new' } },
  });
});

test('incremental delivery continues the unfinished channel and prioritizes recent lectures', () => {
  const replays = [{ speechId: 1, date: '2026-10-01' }, { speechId: 2, date: '2026-11-01' }];
  const state = { completed: { 2: { built: true, email: true } } };
  assert.deepEqual(pendingReplays(replays, state, ['email']).map(r => r.speechId), [1]);
  assert.deepEqual(pendingReplays(replays, state, ['email', 'qq']).map(r => r.speechId), [2, 1]);
  assert.deepEqual(deliveryChannels('both'), ['email', 'qq']);
  assert.throws(() => deliveryChannels('typo'));
});

test('pending transcripts wait until their next check after the PPTX is ready', () => {
  const replays = [{ speechId: 1, date: '2026-10-01' }, { speechId: 2, date: '2026-10-02' }];
  const retryAt = '2026-10-03T00:00:00.000Z';
  const before = Date.parse(retryAt) - 1;
  const state = { completed: { 1: { pptxBuilt: '2026-10-01', emailPptx: '2026-10-01', transcriptRetryAt: retryAt } } };
  assert.deepEqual(pendingReplays(replays, state, [], before).map(r => r.speechId), [2]);
  assert.deepEqual(pendingReplays(replays, state, ['email'], before).map(r => r.speechId), [2]);
  assert.deepEqual(pendingReplays(replays, state, ['email', 'qq'], before).map(r => r.speechId), [2, 1]);
  assert.deepEqual(pendingReplays(replays, state, ['email'], Date.parse(retryAt)).map(r => r.speechId), [1, 2]);
});

test('an existing PPTX receipt leaves only the Word attachment for that channel', () => {
  const pptx = { pptx: 'slides.pptx' };
  const complete = { ...pptx, docx: 'notes.docx' };
  const done = { emailPptx: '2026-10-01' };
  assert.deepEqual(deliveryFiles(pptx, {}, 'email'), ['slides.pptx']);
  assert.deepEqual(deliveryFiles(pptx, done, 'email'), []);
  assert.deepEqual(deliveryFiles(complete, done, 'email'), ['notes.docx']);
  assert.deepEqual(deliveryFiles(complete, done, 'qq'), ['slides.pptx', 'notes.docx']);
  assert.deepEqual(deliveryFiles(complete, { email: '2026-10-01' }, 'email'), []);
});

test('Actions default to course discovery and keep video processing separate', async () => {
  const raw = await readFile(new URL('../.github/workflows/course.yml', import.meta.url), 'utf8');
  const workflow = YAML.parse(raw);
  assert.equal(workflow.on.workflow_dispatch.inputs.operation.default, 'discover');
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.operation.options, ['discover', 'mail-test', 'run']);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ['operation', 'max_lectures']);
  assert.match(workflow.jobs.course.if, /vars\.RUN_SCHEDULED == 'true'/);
  const steps = workflow.jobs.course.steps;
  assert.equal(steps.find(s => s.run === 'node src/run.mjs --discover').if, "env.COURSE_OPERATION == 'discover'");
  assert.equal(steps.find(s => s.run === 'node src/run.mjs --mail-test').if, "env.COURSE_OPERATION == 'mail-test'");
  assert.equal(steps.find(s => s.run === 'node src/run.mjs').if, "env.COURSE_OPERATION == 'run'");
  const uploads = steps.filter(s => s.uses?.startsWith('actions/upload-artifact'));
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].if, /env\.DELIVERY == 'relay'/);
  assert.equal(uploads[0].with.path, 'local-data/relay-outbox/*.relay');
  assert.match(steps.find(s => s.run === 'node src/run.mjs --commit-relay').if, /steps\.upload_relay\.outcome == 'success'/);
  for (const step of workflow.jobs.course.steps.filter(s => s.uses?.startsWith('actions/cache/'))) {
    assert.equal(step.with.path, 'local-data/state/delivery-state.enc');
  }
});

test('a partially uploaded relay only records the file that exists', () => {
  const state = { completed: { 42: { pptxBuilt: 't', built: 't', transcriptRetryAt: null } } };
  assert.deepEqual(deliveryChannels('relay'), ['relay']);
  assert.equal(recordRelayUploads(state, (id, kind) => id === '42' && kind === 'pptx', 'uploaded'), 1);
  assert.deepEqual(deliveryFiles({ pptx: 'slides.pptx', docx: 'lecture.docx' }, state.completed[42], 'relay'), ['lecture.docx']);
  assert.equal(recordRelayUploads(state, (_id, kind) => kind === 'docx', 'next'), 1);
  assert.deepEqual(pendingReplays([{ speechId: 42 }], state, ['relay']), []);
});

test('course discovery pairs each name with its ID and links to the current fork', () => {
  const summary = courseDiscoverySummary([
    { name: '文学 | 研读', id: '10001' }, { name: '数学\n进阶', id: '10002' },
  ], 'student/course-archive');
  assert.match(summary, /\| 文学 &#124; 研读 \| `10001` \|/);
  assert.match(summary, /\| 数学 进阶 \| `10002` \|/);
  assert.match(summary, /https:\/\/github\.com\/student\/course-archive\/edit\/data\/data\/subscriptions\.json/);
});

test('network logs hide signed URLs and Playwright request dumps', () => {
  const log = 'apiRequestContext.get: timeout for https://school.example/replay?enc=token\nCall log:\n  - cookie: session-secret';
  assert.equal(safeMessage(log), 'apiRequestContext.get: timeout for [链接已隐藏]');
});
