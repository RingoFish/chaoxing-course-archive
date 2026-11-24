import { readFile, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { saveJson, downloadVideo } from './platform.mjs';
import { probeVideo, extractSlides } from './media.mjs';
import { writeTranscript, alignTranscript } from './transcript.mjs';
import { prepareAutomatically } from './automatic.mjs';
import { exportFiles } from './export.mjs';
import { inspectWithLogin } from './auth.mjs';
import { safeMessage } from './logging.mjs';

const log = message => console.error(safeMessage(message));

// Internal subprocess: the runner supplies a replay from its subscription catalog.
async function archiveLecture(catalogPath, id, dir, output, mode) {
  if (!catalogPath || !/^\d+$/.test(id || '') || !dir || !output) throw new Error('请通过课程订阅入口运行归档。');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const replay = catalog.replays.find(item => String(item.speechId) === id);
  if (!replay) throw new Error('该回放不在本轮订阅目录中。');
  log('获取平台字幕和录屏信息（不使用语音模型）');
  const result = await inspectWithLogin(replay.url);
  if (String(result.metadata.speechId) !== id) throw new Error('回放与课程列表中的编号不一致。');
  const transcriptPending = !result.transcript.some(segment => segment.text.trim());
  if (transcriptPending && mode === '--check-transcript') {
    console.log(JSON.stringify({ transcriptPending }));
    return;
  }
  await mkdir(dir, { recursive: true });
  await saveJson(join(dir, 'source.private.json'), result);
  await writeTranscript(dir, result.transcript, result.metadata);
  const ppt = result.metadata.streams.find(v => v.type === 'ppt');
  if (!ppt?.url) throw new Error('该回放没有电脑录屏，已停止。');
  const video = join(dir, 'recording.mp4');
  const existing = await stat(video).catch(() => null);
  if (existing?.size) {
    let record;
    try { record = JSON.parse(await readFile(video + '.json', 'utf8')); } catch {}
    const source = new URL(ppt.url);
    if (!record?.complete || record.bytes !== existing.size || record.source !== source.origin + source.pathname) {
      throw new Error('已有录屏缺少匹配的完成记录，已保留文件并停止。请检查 local-data 对应课节目录。');
    }
    await probeVideo(video); log('复用已完整下载的本地录屏');
  }
  else await downloadVideo(ppt.url, video, { onProgress: p => log(`下载 ${Math.round(p.done / 1048576)} MiB${p.total ? ` / ${Math.round(p.total / 1048576)} MiB` : ''}`) });
  const extracted = await extractSlides(video, dir, { onProgress: log });
  extracted.metadata = { course: result.metadata.course, date: result.metadata.date, lesson: result.metadata.lesson, teacher: result.metadata.teacher };
  extracted.occurrences = alignTranscript(extracted.occurrences, result.transcript);
  await saveJson(join(dir, 'timeline.json'), extracted);
  const lesson = await prepareAutomatically(dir);
  log(`自动整理完成：${lesson.pages.length} 页课件，${lesson.transcript.length} 段讲解`);
  const files = await exportFiles(dir, lesson, output, { includeDocx: !transcriptPending,
    course: replay.course || result.metadata.course, number: replay.number });
  console.log(JSON.stringify({ ...files, transcriptPending, pages: lesson.pages.length, segments: lesson.transcript.length }, null, 2));
}

archiveLecture(...process.argv.slice(2)).catch(error => {
  log(error.stderr?.trim().split('\n').at(-1) || error.message);
  process.exitCode = 1;
});
