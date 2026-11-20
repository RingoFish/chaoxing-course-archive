import { safeMessage } from './logging.mjs';
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';
import { request } from 'playwright-core';
import { load } from 'cheerio';
import { loginWithSecrets } from './auth.mjs';
import { normalizeCourseIds } from './subscriptions.mjs';

const COURSE_HOST = 'fanyalubodata.fanya.chaoxing.com';
const DEFAULT_COURSE_ENTRY_URL = `https://${COURSE_HOST}/starcloud/list?type=2&ut=s`;

export function courseListParameters(html) {
  const $ = load(html);
  const v = id => $(`#${id}`).first().attr('value') || '';
  const fid = v('fid'), xn = v('xn'), xq = v('xq');
  if (!/^[1-9]\d*$/.test(fid) || !xn || !xq) {
    let result;
    try { result = JSON.parse(html); } catch {}
    const unit = result?.status === false && /^当前单位\s*(\d+)\s*未开通服务/.exec(result.msg);
    if (unit) {
      throw new Error(`超星当前选中了单位 ${unit[1]}，该单位未开通智播课堂。请从学校官方入口确认机构编号，账号密码模式请设置 COURSE_FID，浏览器模式请切换到正确单位。`);
    }
    throw new Error('未进入智播课堂课程列表。请在浏览器确认账号的当前单位和课程权限。若学校使用专用入口，可设置 COURSE_ENTRY_URL。');
  }
  return { fid, xn, xq, type: v('type') || '2', ut: v('ut') || 's', role: v('roleid'),
    mycoursetype: v('mycoursetype'), loginname: v('loginname'), loginnameenc: v('loginnameenc'),
    pagesize: '50', djz: v('djz') || '0' };
}

export function publishedReplays(records, course) {
  return records.filter(r => Number(r.status) === 3 && Number(r.respublish) === 1 && Number(r.isopen) !== 1 && r.pcplayerurl)
    .map(r => ({ course: course.name, courseId: course.id, speechId: r.speechid,
      date: r.skrq || r.skdate || '', lesson: String(r.lessons || ''), url: r.pcplayerurl }));
}

export function courseRecordParameters(args, course, state, page = 1) {
  const info = args.courseinfo || args.model?.courseinfo || args.model || {};
  const params = { djz: '', page: String(page), status: '3', xn: String(info.xn || state.xn),
    xq: String(info.xq || state.xq), fid: String(info.fid || args.fid || state.fid), jsgh: info.jsgh || '',
    kcbh: info.kcbh || '', enc: course.enc, id: String(course.id) };
  if (!params.jsgh || !params.kcbh || !params.fid) throw new Error('课程详情缺少教师或课程编号，已停止以避免查错课程。');
  return params;
}

export function selectCourses(courses, courseIds = [], onWarning = console.warn) {
  const ids = normalizeCourseIds(courseIds);
  if (!ids.length) return courses;
  const byId = new Map(courses.map(course => [String(course.id), course]));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) {
    onWarning('以下订阅课程本轮不可见，已跳过：' + missing.join(', ') + '。订阅保留，下次会再检查。');
  }
  return ids.flatMap(id => byId.has(id) ? [byId.get(id)] : []);
}

export async function discover(value, {
  courseIds = [], includeReplays = true,
  profile, headless = false, onProgress = () => {}, onWarning = console.warn,
} = {}) {
  const entry = new URL(String(value ?? '').trim() || DEFAULT_COURSE_ENTRY_URL);
  if (entry.protocol !== 'https:' || entry.hostname !== COURSE_HOST || !entry.pathname.startsWith('/starcloud/')) {
    throw new Error('课程发现需要原始智播课堂课程列表链接。');
  }
  const secretsLogin = Boolean(process.env.COURSE_ACCOUNT && process.env.COURSE_PASSWORD);
  if (!secretsLogin && (process.env.GITHUB_ACTIONS === 'true' || process.env.COURSE_ACCOUNT || process.env.COURSE_PASSWORD)) {
    throw new Error('请同时配置 COURSE_ACCOUNT 和 COURSE_PASSWORD。使用本地浏览器登录时，两项都留空。');
  }
  let context, apiOnly;
  if (secretsLogin) {
    const client = await request.newContext({ userAgent: 'Mozilla/5.0', timeout: 60000 });
    context = { request: client, close: () => client.dispose() }; apiOnly = true;
    onProgress('通过账号密码登录超星');
    await loginWithSecrets(context, { account: process.env.COURSE_ACCOUNT, password: process.env.COURSE_PASSWORD,
      fid: process.env.COURSE_FID || '-1' }).catch(async e => { await context.close(); throw e; });
  } else context = await chromium.launchPersistentContext(resolve(profile), { channel: 'chrome', headless,
    acceptDownloads: false, viewport: { width: 1280, height: 900 } });
  try {
    let html;
    if (apiOnly) {
      const response = await context.request.get(entry.href);
      if (!response.ok()) throw new Error(`智播课堂入口请求失败 HTTP ${response.status()}。`);
      html = await response.text();
    } else {
      const page = context.pages()[0] || await context.newPage();
      onProgress(headless ? '读取项目独立浏览器的登录环境' : '首次使用请在打开的 Chrome 中正常登录；程序将自动继续。');
      await page.goto(entry.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(host => location.hostname === host &&
        document.querySelector('#modellistDiv, .modellistDiv, a[onclick*="getcourseinfo"]'),
      COURSE_HOST, { timeout: headless ? 15000 : 300000 }).catch(() => { throw new Error('尚未进入已登录的课程列表。请先以非 headless 模式完成一次登录。'); });
      html = await page.content();
    }
    const state = courseListParameters(html);
    const courses = [], seen = new Set();
    for (let n = 1; n <= 200; n++) {
      const response = await context.request.post(new URL('/starcloud/getmodellist-data', entry).href,
        { form: { ...state, page: String(n) } });
      if (!response.ok()) throw new Error(`课程列表请求失败 HTTP ${response.status()}`);
      const result = await response.json();
      if (result.status === false) throw new Error('超星拒绝读取课程列表，请检查登录和课程权限。');
      const records = result.data?.arry || result.data?.list || result.arry || result.list || result.modellist || result.data?.modellist;
      if (!Array.isArray(records)) throw new Error('课程列表接口格式变化，已停止而未猜测课程权限。');
      for (const r of records) {
        const id = String(r.courseinfoid ?? '');
        const name = r.kcmc || r.coursename || r.name || '';
        if (/^[1-9]\d*$/.test(id) && r.courseinfoenc && !seen.has(id)) {
          seen.add(id); courses.push({ id, name, enc: r.courseinfoenc });
        }
      }
      const paging = result.data?.pageInfo || result.pageInfo || {};
      const total = Number(paging.totalResult || 0), size = Number(paging.pagesize || 50), totalPages = Number(paging.totalPage || 0);
      if (!records.length || (totalPages && n >= totalPages) || (total && n * size >= total) || (!totalPages && !total && records.length < size)) break;
      await new Promise(r => setTimeout(r, 350));
      if (n === 200) throw new Error('课程分页超出合理范围。');
    }
    if (!courses.length) onWarning('智播课堂本轮返回空课程列表；请检查单位、学期和权限。');
    const selectedCourses = selectCourses(courses, courseIds, onWarning);
    if (!includeReplays) {
      return { schemaVersion: 1, courses: selectedCourses.map(({ enc, ...c }) => c), replays: [] };
    }
    const replays = [];
    for (const [index, course] of selectedCourses.entries()) {
      onProgress('查找第 ' + (index + 1) + '/' + selectedCourses.length + ' 门课的回放');
      try {
        const detail = new URL('/starcloud/getcoursehead', entry);
        detail.search = new URLSearchParams({ id: String(course.id), enc: course.enc, ut: 's', ischange: 'true' });
        const response = await context.request.get(detail.href);
        if (!response.ok()) throw new Error('课程详情请求失败（HTTP ' + response.status() + '）。');
        const { parseArgsDeclaration } = await import('./platform.mjs');
        const args = parseArgsDeclaration(await response.text());
        for (let n = 1; n <= 200; n++) {
          const url = new URL('/starcloud/getclassrecord', entry);
          url.search = new URLSearchParams(courseRecordParameters(args, course, state, n));
          const response = await context.request.post(url.href);
          if (!response.ok()) throw new Error('回放列表请求失败（HTTP ' + response.status() + '）。');
          const result = await response.json(), data = result.data;
          if (result.status === false || !Array.isArray(data?.arry)) throw new Error('回放列表接口未返回有效课程记录。');
          replays.push(...publishedReplays(data.arry, course));
          const size = Number(data.pageInfo?.pagesize || 10), total = Number(data.pageInfo?.totalResult || 0);
          if (data.arry.length < size || (total && n * size >= total)) break;
          await new Promise(r => setTimeout(r, 350));
          if (n === 200) throw new Error('回放分页超出合理范围。');
        }
      } catch (error) {
        onWarning('课程 ' + course.id + ' 的回放未能查全：' + safeMessage(error.message) + ' 已查到的回放照常处理，其余下次复查。');
      }
    }
    return { schemaVersion: 1, courses: selectedCourses.map(({ enc, ...c }) => c),
      replays: [...new Map(replays.map(r => [String(r.speechId || r.url), r])).values()] };
  } finally { await context.close(); }
}
