import { chromium } from 'playwright-core';
import { resolve } from 'node:path';
import { request } from 'playwright-core';
import { load } from 'cheerio';
import { loginWithSecrets } from './auth.mjs';
import { normalizeCourseIds } from './subscriptions.mjs';

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

export function selectCourses(courses, courseIds = []) {
  const ids = normalizeCourseIds(courseIds);
  if (!ids.length) return courses;
  const byId = new Map(courses.map(course => [String(course.id), course]));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) {
    throw new Error('以下课程 ID 不在当前账号可访问的课程列表中：' + missing.join(', ') +
      '。请重新执行 discover 检查课程列表和学期。');
  }
  return ids.map(id => byId.get(id));
}

export async function discover(value, {
  courseIds = [], includeReplays = true,
  profile, headless = false, onProgress = () => {},
} = {}) {
  const entry = new URL(value);
  if (entry.protocol !== 'https:' || entry.hostname !== 'fanyalubodata.fanya.chaoxing.com' || !entry.pathname.startsWith('/starcloud/')) {
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
    let state;
    if (apiOnly) {
      if (process.env.GITHUB_ACTIONS === 'true') {
        const withoutToken = new URL(entry);
        withoutToken.searchParams.delete('space_token');
        const canonical = new URL('/starcloud/list?type=2&ut=s', entry.origin);
        const probes = [['configured', entry], ['without-space-token', withoutToken], ['canonical', canonical]];
        probes.push(['personal-space', new URL('https://i.chaoxing.com/')], ['configured-after-personal-space', entry]);
        const cookieCounts = async () => {
          const { cookies } = await context.request.storageState();
          const count = host => cookies.filter(cookie => {
            const domain = cookie.domain.replace(/^\./, '');
            return host === domain || (cookie.domain.startsWith('.') && host.endsWith('.' + domain));
          }).length;
          return { personal: count('i.chaoxing.com'), course: count(entry.hostname) };
        };
        const seenProbes = new Set();
        for (const [label, target] of probes) {
          if (seenProbes.has(target.href) && label !== 'configured-after-personal-space') continue;
          seenProbes.add(target.href);
          try {
            const before = await cookieCounts();
            const reply = await context.request.get(target.href, { timeout: 25000 });
            const finalUrl = new URL(reply.url());
            const html = await reply.text();
            const doc = load(html);
            const filled = id => Boolean(doc(`[id="${id}"]`).first().attr('value'));
            const destination = finalUrl.hostname === entry.hostname
              ? finalUrl.pathname === '/starcloud/list' ? 'course-list' : 'other-course-host-page'
              : finalUrl.hostname === 'passport2.chaoxing.com' ? 'passport'
                : finalUrl.hostname === 'i.chaoxing.com' ? 'personal-space' : 'other-host';
            console.log('COURSE_ENTRY_CHECK ' + JSON.stringify({
              probe: label, status: reply.status(), destination,
              redirected: finalUrl.href !== target.href,
              inputIsList: target.pathname === '/starcloud/list',
              inputHasSpaceToken: target.searchParams.has('space_token'),
              inputHasS: target.searchParams.has('s'),
              cookiesBefore: before, cookiesAfter: await cookieCounts(),
              contentKind: /html/i.test(reply.headers()['content-type'] || '') ? 'html' : /json/i.test(reply.headers()['content-type'] || '') ? 'json' : 'other',
              bodyLength: html.length,
              titleKind: /智播课堂/.test(doc('title').text()) ? 'course' : /登录|login/i.test(doc('title').text()) ? 'login' : /个人空间/.test(doc('title').text()) ? 'personal-space' : doc('title').text().trim() ? 'other' : 'none',
              textLength: doc('body').clone().find('script,style').remove().end().text().trim().length,
              scripts: doc('script').length, frames: doc('iframe,frame').length, forms: doc('form').length,
              personalSpaceMarker: Boolean(doc('#siteName, #frame_content').length),
              authMarker: /非法访问|访问异常|登录失效|请先登陆|请先登录|身份认证|统一认证|重新登录|账号异常|身份验证|安全校验|安全验证|身份校验|请使用.*浏览器/i.test(html),
              fid: filled('fid'), term: filled('xn') && filled('xq'),
              courseListContainer: Boolean(doc('#modellistDiv, .modellistDiv').length),
              loginForm: Boolean(doc('input[type="password"], #loginBtn').length),
              captchaMention: /验证码|captcha/i.test(doc('body').text()),
              unauthorizedMessage: /无权限|未登录|请登录|登录超时|访问受限|not authorized|access denied/i.test(doc('body').text()),
              invalidParameterMessage: /参数错误|参数无效|链接失效|链接过期/i.test(doc('body').text()),
              htmlRedirectMarker: /location\.(?:href|replace|assign)|http-equiv=["']refresh/i.test(html),
            }));
          } catch {
            console.log('COURSE_ENTRY_CHECK ' + JSON.stringify({ probe: label, requestFailed: true }));
          }
        }
        throw new Error('Course entry diagnostics finished.');
      }
      const response = await context.request.get(entry.href);
      const $ = load(await response.text());
      const v = id => $(`[id="${id}"]`).first().attr('value') || '';
      if (!v('fid')) throw new Error('已登录，但课程入口不可用。请更新 COURSE_ENTRY_URL 为本人当前可访问的课程列表链接。');
      state = { fid: v('fid'), xn: v('xn'), xq: v('xq'), type: v('type') || '2', ut: v('ut') || 's',
        role: v('roleid'), mycoursetype: v('mycoursetype'), loginname: v('loginname'), pagesize: '50', djz: '0' };
    } else {
      const page = context.pages()[0] || await context.newPage();
      onProgress(headless ? '读取项目独立浏览器的登录环境' : '首次使用请在打开的 Chrome 中正常登录；程序将自动继续。');
      await page.goto(entry.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => location.hostname === 'fanyalubodata.fanya.chaoxing.com' &&
      (document.querySelector('#modellistDiv') || document.querySelector('.modellistDiv') || document.querySelector('a[onclick*="getcourseinfo"]')),
      null, { timeout: headless ? 15000 : 300000 }).catch(() => { throw new Error('尚未进入已登录的课程列表。请先以非 headless 模式完成一次登录。'); });
    // Use the site's own authenticated read endpoint. Keep the profile private
    // inside local-data; no cookies are copied to the manifest or final files.
      state = await page.evaluate(() => {
      const v = id => document.getElementById(id)?.value ?? '';
      return { fid: v('fid'), xn: v('xn'), xq: v('xq'), type: v('type') || '2', ut: v('ut') || 's',
        role: v('roleid'), mycoursetype: v('mycoursetype'), loginname: v('loginname'), pagesize: '50', djz: '0' };
      });
    }
    const courses = [], seen = new Set();
    for (let n = 1; n <= 200; n++) {
      const response = await context.request.post(new URL('/starcloud/getmodellist-data', entry).href,
        { form: { ...state, page: String(n) } });
      if (!response.ok()) throw new Error(`课程列表请求失败 HTTP ${response.status()}`);
      const result = await response.json();
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
    const selectedCourses = selectCourses(courses, courseIds);
    if (!selectedCourses.length) throw new Error('没有找到匹配的课程。请核对课程列表和订阅 ID。');
    if (!includeReplays) {
      return { schemaVersion: 1, courses: selectedCourses.map(({ enc, ...c }) => c), replays: [] };
    }
    const replays = [];
    for (const [index, course] of selectedCourses.entries()) {
      onProgress('查找第 ' + (index + 1) + '/' + selectedCourses.length + ' 门课的回放');
      const detail = new URL('/starcloud/getcoursehead', entry);
      detail.search = new URLSearchParams({ id: String(course.id), enc: course.enc, ut: 's', ischange: 'true' });
      const response = await context.request.get(detail.href);
      const { parseArgsDeclaration } = await import('./platform.mjs');
      const args = parseArgsDeclaration(await response.text());
      for (let n = 1; n <= 200; n++) {
        const url = new URL('/starcloud/getclassrecord', entry);
        url.search = new URLSearchParams(courseRecordParameters(args, course, state, n));
        const response = await context.request.post(url.href);
        const result = await response.json(), data = result.data;
        if (!Array.isArray(data?.arry)) throw new Error('回放列表接口未返回有效课程记录。');
        replays.push(...publishedReplays(data.arry, course));
        const size = Number(data.pageInfo?.pagesize || 10), total = Number(data.pageInfo?.totalResult || 0);
        if (data.arry.length < size || (total && n * size >= total)) break;
        await new Promise(r => setTimeout(r, 350));
        if (n === 200) throw new Error('回放分页超出合理范围。');
      }
    }
    return { schemaVersion: 1, courses: selectedCourses.map(({ enc, ...c }) => c),
      replays: [...new Map(replays.map(r => [String(r.speechId || r.url), r])).values()] };
  } finally { await context.close(); }
}
