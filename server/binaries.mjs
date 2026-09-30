// Finds FFmpeg and yt-dlp: env var → PATH → automatic download into `.bin/`.
// Downloading at runtime (not in an install script) also works with pnpm, which blocks them,
// which blocks install scripts by default.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

const exe = process.platform === 'win32' ? '.exe' : '';
const key = `${process.platform}-${process.arch}`;

const FFMPEG_URLS = {
  'win32-x64': 'ffmpeg-win32-x64.gz',
  'linux-x64': 'ffmpeg-linux-x64.gz',
  'linux-arm64': 'ffmpeg-linux-arm64.gz',
  'darwin-x64': 'ffmpeg-darwin-x64.gz',
  'darwin-arm64': 'ffmpeg-darwin-arm64.gz',
};
const YTDLP_URLS = {
  'win32-x64': 'yt-dlp.exe',
  'win32-arm64': 'yt-dlp_arm64.exe',
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
  'darwin-x64': 'yt-dlp_macos',
  'darwin-arm64': 'yt-dlp_macos',
};

/** True if the command runs and exits cleanly. */
function works(cmd, args) {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore', timeout: 20_000 }).status === 0;
  } catch {
    return false;
  }
}

/** Downloads a binary (optionally gunzipping it) and makes it executable. */
async function download(url, target, gunzip, log) {
  log(`Downloading ${url.split('/').pop()}…`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Could not download ${url} (${res.status})`);
  const tmp = `${target}.part`;
  const body = Readable.fromWeb(res.body);
  await (gunzip
    ? pipeline(body, createGunzip(), createWriteStream(tmp))
    : pipeline(body, createWriteStream(tmp)));
  renameSync(tmp, target);
  if (process.platform !== 'win32') chmodSync(target, 0o755);
}

/** Resolves one tool, downloading it when nothing usable is installed. */
async function resolveTool(name, { envVar, versionArgs, localPath, url, gunzip, log }) {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  if (existsSync(localPath) && works(localPath, versionArgs)) return localPath;
  if (works(name, versionArgs)) return name;
  if (!url) throw new Error(`${name} is not available for ${key}. Install it or set ${envVar}.`);
  try {
    await download(url, localPath, gunzip, log);
  } catch (err) {
    rmSync(`${localPath}.part`, { force: true });
    throw err;
  }
  if (!works(localPath, versionArgs)) throw new Error(`${name} was downloaded but does not run`);
  return localPath;
}

/** Returns absolute commands for ffmpeg and yt-dlp, downloading them if needed. */
export async function ensureBinaries({ dir, log = console.log } = {}) {
  mkdirSync(dir, { recursive: true });
  const ffmpeg = await resolveTool('ffmpeg', {
    envVar: 'MYCONVERSOR_FFMPEG',
    versionArgs: ['-version'],
    localPath: join(dir, `ffmpeg${exe}`),
    url:
      FFMPEG_URLS[key] &&
      `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/${FFMPEG_URLS[key]}`,
    gunzip: true,
    log,
  });
  const ytdlpPath = join(dir, `yt-dlp${exe}`);
  const ytdlp = await resolveTool('yt-dlp', {
    envVar: 'MYCONVERSOR_YTDLP',
    versionArgs: ['--version'],
    localPath: ytdlpPath,
    url:
      YTDLP_URLS[key] &&
      `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_URLS[key]}`,
    gunzip: false,
    log,
  });
  // Platforms (YouTube above all) change often: keep our own copy of yt-dlp on the
  // nightly channel, which gets extractor fixes first, now and every 6 hours.
  if (ytdlp === ytdlpPath) {
    const update = () => spawn(ytdlp, ['--update-to', 'nightly'], { stdio: 'ignore' }).on('error', () => {});
    update();
    setInterval(update, 6 * 3600_000).unref();
  }
  return { ffmpeg, ytdlp };
}
