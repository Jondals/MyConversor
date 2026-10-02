// LibreOffice integration for documents (PDF, Word, Excel, PowerPoint, OpenDocument,
// text...): finds `soffice` and converts one file at a time in headless mode.
// LibreOffice is optional; without it the document conversions are switched off.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { docType } from './catalog.mjs';
import { AppError } from './errors.mjs';

/** Usual install locations, tried after $MYCONVERSOR_SOFFICE and the PATH. */
const CANDIDATES = {
  win32: ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'],
  darwin: ['/Applications/LibreOffice.app/Contents/MacOS/soffice'],
  linux: ['/usr/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/opt/libreoffice/program/soffice'],
};

/** Returns the `soffice` command, or null when LibreOffice is not installed. */
export function findOffice() {
  const list = [process.env.MYCONVERSOR_SOFFICE, 'soffice', 'libreoffice', ...(CANDIDATES[process.platform] ?? [])];
  for (const cmd of list.filter(Boolean)) {
    if (cmd.includes('/') || cmd.includes('\\') ? !existsSync(cmd) : false) continue;
    try {
      if (spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 60_000 }).status === 0) return cmd;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/** `--convert-to` spec (extension plus export filter) for each output. */
const EXPORT = {
  pdf: 'pdf',
  docx: 'docx:MS Word 2007 XML',
  odt: 'odt',
  rtf: 'rtf:Rich Text Format',
  txt: 'txt:Text (encoded):UTF8',
  html: 'html',
  epub: 'epub',
  xlsx: 'xlsx:Calc MS Excel 2007 XML',
  ods: 'ods',
  csv: 'csv:Text - txt - csv (StarCalc):44,34,76',
  pptx: 'pptx:Impress MS PowerPoint 2007 XML',
  odp: 'odp',
  png: 'png',
  jpg: 'jpg',
};

/** PDFs open in Draw by default; text and slide outputs need the matching import filter. */
function importFilter(srcExt, target) {
  if (docType(srcExt) !== 'pdf') return null;
  if (['pptx', 'odp'].includes(target)) return 'impress_pdf_import';
  if (['docx', 'odt', 'rtf', 'txt', 'html', 'epub'].includes(target)) return 'writer_pdf_import';
  return null;
}

/**
 * Creates a converter bound to one LibreOffice profile folder. LibreOffice can't
 * run twice on the same profile, so conversions wait in line.
 */
export function createOffice(soffice, profileDir) {
  let line = Promise.resolve();
  mkdirSync(profileDir, { recursive: true });
  const profile = pathToFileURL(profileDir).href;

  /** Converts `src` into `outDir` and resolves with the new file's path. */
  function convertOnce(src, srcExt, target, outDir, signal) {
    const spec = EXPORT[target];
    if (!spec) return Promise.reject(new AppError(400, 'bad_format', `Unsupported format: ${target}`));
    const filter = importFilter(srcExt, target);
    const args = [
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--nodefault',
      '--nofirststartwizard',
      `-env:UserInstallation=${profile}`,
      ...(filter ? [`--infilter=${filter}`] : []),
      '--convert-to',
      spec,
      '--outdir',
      outDir,
      src,
    ];
    return new Promise((resolve, reject) => {
      const proc = spawn(soffice, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const kill = () => proc.kill('SIGKILL');
      const timer = setTimeout(kill, 5 * 60_000);
      signal?.addEventListener('abort', kill, { once: true });
      let log = '';
      proc.stdout.on('data', (d) => (log = (log + d).slice(-2000)));
      proc.stderr.on('data', (d) => (log = (log + d).slice(-2000)));
      proc.on('error', reject);
      proc.on('close', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
        if (signal?.aborted) return reject(new AppError(499, 'cancelled', 'Cancelled'));
        const out = readdirSync(outDir).find((f) => f.toLowerCase().endsWith(`.${target}`));
        if (!out) return reject(new AppError(422, 'office_failed', `LibreOffice could not convert the file. ${log.trim().slice(-300)}`));
        resolve(join(outDir, out));
      });
    });
  }

  return {
    /** Queues a conversion; see `convertOnce`. */
    convert(src, srcExt, target, outDir, signal) {
      const task = line.then(() => convertOnce(src, srcExt, target, outDir, signal));
      line = task.catch(() => undefined);
      return task;
    },
  };
}
