import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import pptxgen from 'pptxgenjs';
import { timecode } from './transcript.mjs';

const exec = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function notesFor(page, lesson) {
  return `${lesson.metadata.course}\n${lesson.metadata.date} 第 ${lesson.metadata.lesson} 节\n` +
    lesson.occurrences.filter(o => o.slideId === page.id).map(o => `${timecode(o.start)} - ${timecode(o.end)}`).join('\n');
}

export async function writePptx(directory, lesson, target) {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: 'ARCHIVE', width: 12, height: 6.75 });
  pptx.layout = 'ARCHIVE';
  pptx.title = lesson.metadata.course;
  pptx.subject = `${lesson.metadata.date} 第 ${lesson.metadata.lesson} 节 课件页面`;
  pptx.author = 'Course Archive';
  pptx.company = '';
  pptx.lang = 'zh-CN';
  for (const page of lesson.pages) {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    const ratio = page.width / page.height;
    const width = Math.min(12, 6.75 * ratio), height = width / ratio;
    slide.addImage({ path: join(directory, page.image), x: (12 - width) / 2, y: (6.75 - height) / 2, w: width, h: height,
      altText: page.title });
    slide.addNotes(notesFor(page, lesson));
  }
  await pptx.writeFile({ fileName: target });
}

// Used inside Codex for the requested artifact workflow. The ordinary CLI uses
// the public PptxGenJS package so the friend's machine needs no Codex runtime.
export async function writeArtifactPptx(directory, lesson, target) {
  const { Presentation, PresentationFile } = await import(process.env.COURSE_ARTIFACT_MODULE);
  const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  const qa = join(directory, 'qa-pptx', basename(dirname(target)));
  await mkdir(qa, { recursive: true });
  for (const page of lesson.pages) {
    const slide = presentation.slides.add();
    slide.background.fill = '#FFFFFF';
    const bytes = await readFile(join(directory, page.image));
    const ratio = page.width / page.height;
    const width = Math.min(1280, 720 * ratio), height = width / ratio;
    slide.images.add({ blob: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), contentType: page.image.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
      alt: page.title, fit: 'contain', position: { left: (1280 - width) / 2, top: (720 - height) / 2, width, height } });
    slide.speakerNotes.text = notesFor(page, lesson);
    const preview = await presentation.export({ slide, format: 'png', scale: 1 });
    await writeFile(join(qa, `slide-${String(page.id).padStart(3, '0')}.png`), new Uint8Array(await preview.arrayBuffer()));
  }
  const candidate = join(qa, 'candidate.pptx');
  await (await PresentationFile.exportPptx(presentation)).save(candidate);
  if (process.env.COURSE_PRESENTATIONS_SKILL) {
    const { pathToFileURL } = await import('node:url');
    const skill = process.env.COURSE_PRESENTATIONS_SKILL;
    const { finalizePresentation } = await import(pathToFileURL(join(skill, 'container_tools/artifact_tool_utils.mjs')).href);
    await finalizePresentation({ workspaceDir: projectRoot, candidatePath: resolve(candidate), finalPath: resolve(target),
      pythonExecutable: process.env.COURSE_DOCX_PYTHON,
      integrityValidatorPath: join(skill, 'container_tools/inspect_presentation_package_integrity.py'),
      layoutValidatorPath: join(skill, 'container_tools/inspect_presentation_layout_geometry.py'),
      layoutArgs: ['--expected-slide-size-emu', '12192000,6858000'],
      explicitTotalSlideCount: lesson.pages.length, requiredNativeTableOwnerSlides: [], requiredNativeChartOwnerSlides: [],
      verifyArtifactToolImport: true, receiptPath: resolve(join(qa, 'validation.json')) });
  } else await (await PresentationFile.exportPptx(presentation)).save(target);
}

// Friend-facing names: "<course> 课件 01.pptx" (slides only) and
// "<course> 讲义 01.docx" (screenshots with the platform transcript).
export function lectureFileNames(course, number = 1) {
  const name = String(course || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim()
    .slice(0, 120).replace(/[. ]+$/, '') || '未命名课程';
  const index = String(Number.isSafeInteger(Number(number)) && Number(number) > 0 ? Number(number) : 1).padStart(2, '0');
  return { pptx: `${name} 课件 ${index}.pptx`, docx: `${name} 讲义 ${index}.docx` };
}

export async function exportFiles(directory, lesson, output, { includeDocx = true, course, number } = {}) {
  await mkdir(output, { recursive: true });
  const names = lectureFileNames(course || lesson.metadata.course, number);
  const pptx = resolve(output, names.pptx), docx = resolve(output, names.docx);
  if (process.env.COURSE_ARTIFACT_MODULE) await writeArtifactPptx(directory, lesson, pptx);
  else await writePptx(directory, lesson, pptx);
  if (!includeDocx) return { pptx };
  const python = process.env.COURSE_DOCX_PYTHON;
  const args = python ? [join(projectRoot, 'src/export_docx.py'), resolve(directory), docx]
    : ['run', '--locked', '--project', projectRoot, 'python', join(projectRoot, 'src/export_docx.py'), resolve(directory), docx];
  await exec(python || 'uv', args, { maxBuffer: 4e6 });
  return { pptx, docx };
}
