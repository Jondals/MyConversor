// yt-dlp integration: validates links against the supported platforms, reads
// video metadata and downloads media while reporting progress.
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './errors.mjs';

/** Only these hosts are accepted, so the server never fetches arbitrary URLs. */
export const PLATFORMS = {
  YouTube: ['youtube.com', 'youtu.be'],
  TikTok: ['tiktok.com'],
  Instagram: ['instagram.com'],
  X: ['x.com', 'twitter.com'],
  Twitch: ['twitch.tv'],
  Vimeo: ['vimeo.com'],
};

/** Audio formats yt-dlp can extract to. */
export const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'flac', 'wav', 'vorbis', 'alac'];
/** Containers the downloaded video can be merged into. */
export const VIDEO_CONTAINERS = ['mp4', 'webm', 'mkv'];

/** Returns the platform label for a link, or throws. `extraHosts` is only used by tests. */
export function platformFor(url, extraHosts = []) {
  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    throw new AppError(400, 'invalid_url', 'Invalid link');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new AppError(400, 'invalid_url', 'Invalid link');
  const host = parsed.hostname.toLowerCase();
  if (extraHosts.includes(host)) return 'YouTube';
  for (const [label, domains] of Object.entries(PLATFORMS)) {
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) return label;
  }
  throw new AppError(400, 'unsupported_platform', 'Unsupported platform');
}

/** Maps yt-dlp's stderr to a translatable error. */
export function toAppError(text) {
  const rules = [
    [/Sign in to confirm|logged-in|login required|use --cookies/i, 'bot_check', 'The platform asks for a sign-in or bot check'],
    [/Unsupported URL|No video could be found/i, 'no_video', 'The link has no supported video'],
    [/Private video/i, 'private_video', 'The video is private'],
    [/max-filesize/i, 'too_large', 'The file does not fit in your storage'],
    [/Video unavailable|not available|HTTP Error 404/i, 'unavailable', 'The video is not available'],
  ];
  for (const [pattern, code, message] of rules) {
    if (pattern.test(text)) return new AppError(422, code, message);
  }
  const line = text.trim().split('\n').filter((l) => l.includes('ERROR')).pop() ?? text.trim();
  return new AppError(422, 'fetch_failed', line.replace(/^.*?ERROR:\s*/, '').slice(0, 300) || 'Could not read the link');
}

/**
 * Common yt-dlp flags. YouTube now needs a JavaScript runtime to unlock all
 * formats; the Node running this server is used for that. YouTube clients are
 * left to yt-dlp's defaults (they change with each release). `bins.ytdlpArgs`
 * holds server-wide extras (proxy, PO token provider; see index.mjs).
 */
export function baseArgs(bins, cookies) {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--ffmpeg-location',
    bins.ffmpeg,
    '--js-runtimes',
    `node:${process.execPath}`,
    ...(bins.ytdlpArgs ?? []),
  ];
  if (cookies) args.push('--cookies', cookies);
  return args;
}

/** Runs a command and resolves with its stdout (rejects with a translated error). */
export function collect(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err = (err + d).slice(-8000)));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(toAppError(err))));
  });
}

/** Highest quality offered (4K). */
export const MAX_HEIGHT = 2160;

/**
 * Summarises yt-dlp's format list into the qualities offered: one entry per
 * resolution (the short side, like yt-dlp's `res`) with its best frame rate,
 * capped at 4K. A format counts as video unless it is explicitly audio-only:
 * some sites (e.g. Twitch clips) omit `vcodec`.
 */
export function summarizeFormats(info) {
  const formats = info.formats ?? [];
  const isVideo = (f) => f.vcodec !== 'none' && (Boolean(f.vcodec) || f.height > 0 || f.width > 0);
  const video = formats.filter(isVideo);
  const best = new Map();
  for (const f of video) {
    const res = f.width > 0 && f.height > 0 ? Math.min(f.width, f.height) : f.height;
    if (!(res > 0) || res > MAX_HEIGHT) continue;
    best.set(res, Math.max(best.get(res) ?? 0, Math.round(f.fps || 0)));
  }
  if (!best.size && info.height) best.set(Math.min(info.height, MAX_HEIGHT), Math.round(info.fps || 0));
  const qualities = [...best].sort((a, b) => b[0] - a[0]).map(([height, fps]) => ({ height, fps: fps || null }));
  const fps = Math.max(0, ...qualities.map((q) => q.fps ?? 0));
  return {
    qualities,
    heights: qualities.map((q) => q.height),
    fps: fps || null,
    hasVideo: video.length > 0 || Boolean(info.width) || (!formats.length && info.vcodec !== 'none'),
  };
}

/** Reads the metadata of a supported link. */
export async function getInfo(bins, url, { cookies, extraHosts } = {}) {
  const platform = platformFor(url, extraHosts);
  let info = JSON.parse(await collect(bins.ytdlp, [...baseArgs(bins, cookies), '-J', '--', url]));
  if (info._type === 'playlist') info = (info.entries ?? []).find(Boolean);
  if (!info) throw new AppError(422, 'no_video', 'The link has no video');
  return {
    url: info.webpage_url || url,
    title: info.title || 'video',
    uploader: info.uploader || info.channel || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || null,
    platform,
    ...summarizeFormats(info),
  };
}

/**
 * Downloads a link into `folder` and resolves with the resulting file path.
 * @param {{mode:'video'|'audio', quality:string, fps?:number, container:string, audioFormat:string}} o
 * `quality` is a resolution (e.g. "1080") or "best" (up to 4K); `fps` 60 prefers
 * high frame rate formats, 30 avoids them.
 */
export function download(bins, url, folder, o, { cookies, extraHosts, maxBytes, signal, onProgress }) {
  platformFor(url, extraHosts);
  const args = [
    ...baseArgs(bins, cookies),
    '--newline',
    '--progress',
    '--progress-template',
    'download:MCP %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s',
    '--print',
    'after_move:MCF %(filepath)s',
    '-o',
    join(folder, 'source.%(ext)s'),
  ];
  if (maxBytes) args.push('--max-filesize', String(Math.max(1, Math.floor(maxBytes))));

  if (o.mode === 'audio') {
    const format = AUDIO_FORMATS.includes(o.audioFormat) ? o.audioFormat : 'mp3';
    const quality = /^\d+$/.test(o.quality) && o.quality !== '0' ? `${o.quality}K` : '0';
    args.push('-f', 'ba/b', '-x', '--audio-format', format, '--audio-quality', quality);
  } else {
    const container = VIDEO_CONTAINERS.includes(o.container) ? o.container : 'mp4';
    const height = /^\d+$/.test(o.quality) ? Math.min(Number(o.quality), MAX_HEIGHT) : MAX_HEIGHT;
    const res = `res:${height},${o.fps === 30 ? 'fps:30,' : o.fps === 60 ? 'fps:60,' : ''}`;
    const sort = container === 'mp4' ? `${res}vcodec:h264,ext:mp4:m4a` : container === 'webm' ? `${res}ext:webm:webm` : `${res}ext`;
    args.push('-f', 'bv*+ba/b', '-S', sort, '--merge-output-format', container);
  }
  args.push('--', url);

  return new Promise((resolve, reject) => {
    const proc = spawn(bins.ytdlp, args);
    const abort = () => proc.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    const parts = new Map();
    let finalPath = null;
    let log = '';
    let buf = '';
    let part = 0;
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        log = (log + line + '\n').slice(-4000);
        if (line.startsWith('MCF ')) {
          finalPath = line.slice(4);
        } else if (line.startsWith('MCP ')) {
          const [done, total, estimate, speed, eta] = line.slice(4).split(' ').map(Number);
          // A new file (e.g. audio after video) restarts the byte counter.
          if (done === 0 || (parts.has(part) && done < parts.get(part).done)) part++;
          parts.set(part, { done: done || 0, size: total || estimate || 0 });
          const downloaded = [...parts.values()].reduce((s, p) => s + p.done, 0);
          const all = [...parts.values()].reduce((s, p) => s + p.size, 0);
          onProgress?.({
            stage: 'downloading',
            downloaded,
            total: all,
            speed: speed || 0,
            eta: Number.isFinite(eta) ? eta : null,
            progress: all ? (0.9 * downloaded) / all : 0,
          });
        } else if (/^\[(Merger|ExtractAudio|FixupM3u8|VideoConvertor)\]/.test(line)) {
          onProgress?.({ stage: 'processing', speed: 0, eta: null });
        }
      }
    });
    proc.stderr.on('data', (d) => (log = (log + d).slice(-8000)));
    proc.on('error', reject);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(new AppError(499, 'cancelled', 'Cancelled'));
      if (code !== 0) return reject(toAppError(log));
      if (!finalPath) {
        const files = readdirSync(folder)
          .filter((f) => !/\.(part|ytdl|tmp)$/.test(f))
          .map((f) => join(folder, f));
        finalPath = files.sort((a, b) => statSync(b).size - statSync(a).size)[0] ?? null;
      }
      if (!finalPath) return reject(/max-filesize/.test(log) ? toAppError(log) : new AppError(422, 'fetch_failed', 'The download produced no file'));
      resolve(finalPath);
    });
  });
}
