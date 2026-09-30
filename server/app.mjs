// MyConversor HTTP app (Express): accounts, the per-user library, downloads with
// yt-dlp, trimming/conversion with FFmpeg, and the built web app.
//
// Storage: every file lives on the server's own disk under `<dataDir>/files/<id>/`
// and its metadata in `<dataDir>/db.json`. Deleting a file from the library
// removes its folder from disk immediately; expired files are removed by a
// janitor every 5 minutes.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import compression from 'compression';
import express from 'express';
import { Db, newId } from './db.mjs';
import { AUDIO_FORMATS, VIDEO_CONTAINERS, download, getInfo, platformFor } from './downloader.mjs';
import { AppError } from './errors.mjs';
import { FORMATS, PRESETS, convertArgs, probe, run, strip, thumbnail, trimArgs } from './media.mjs';
import { downloadMusic, resolveMusic } from './music.mjs';

const COOKIE = 'mc_session';
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'ac3', 'aiff', 'alac']);
const IMAGE_EXTS = new Set(['gif', 'webp', 'png']);
const HOUR = 3600_000;

/** Media kind from a file extension. */
export const kindOf = (ext) => (IMAGE_EXTS.has(ext) ? 'gif' : AUDIO_EXTS.has(ext) ? 'audio' : 'video');

/** Makes a user/platform supplied title safe to use as a file name. */
export function cleanName(name, fallback = 'video') {
  const clean = String(name ?? '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  return clean || fallback;
}

/** Password policy: 10+ characters with lower and upper case, a number and a symbol. */
export function passwordProblems(password) {
  const rules = {
    length: password.length >= 10,
    lower: /[a-z]/.test(password),
    upper: /[A-Z]/.test(password),
    number: /\d/.test(password),
    symbol: /[^A-Za-z0-9]/.test(password),
  };
  return Object.keys(rules).filter((k) => !rules[k]);
}

/** Parses the Cookie header into an object. */
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Content types of the audio files yt-dlp can produce. */
const AUDIO_TYPES = { m4a: 'audio/mp4', mp4: 'audio/mp4', webm: 'audio/webm', opus: 'audio/ogg', ogg: 'audio/ogg', mp3: 'audio/mpeg', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac' };

/**
 * Creates the app.
 * @param {{
 *   dataDir: string, bins: {ffmpeg: string, ytdlp: string}, webDir?: string,
 *   ttlMs?: number, guestTtlMs?: number, quotaBytes?: number, guestQuotaBytes?: number,
 *   maxJobs?: number, cookies?: string, extraHosts?: string[], log?: (msg: string) => void
 * }} options
 */
export function createApp(options) {
  const {
    dataDir,
    bins,
    webDir,
    ttlMs = 24 * HOUR,
    guestTtlMs = 2 * HOUR,
    quotaBytes = 50 * 1024 ** 3,
    guestQuotaBytes = 10 * 1024 ** 3,
    maxJobs = 2,
    cookies,
    extraHosts = [],
  } = options;
  const filesDir = join(dataDir, 'files');
  const avatarsDir = join(dataDir, 'avatars');
  // Songs fetched for the music player only pass through here on their way to the browser.
  const musicDir = join(dataDir, 'music-tmp');
  rmSync(musicDir, { recursive: true, force: true });
  mkdirSync(musicDir, { recursive: true });
  mkdirSync(filesDir, { recursive: true });
  mkdirSync(avatarsDir, { recursive: true });
  const db = new Db(dataDir);
  const jobs = new Map();
  const queue = [];
  let running = 0;

  // Remove folders left behind by a crash (on disk but not in the database).
  for (const dir of readdirSync(filesDir)) {
    if (!db.file(dir)) rmSync(join(filesDir, dir), { recursive: true, force: true });
  }

  // ------------------------------------------------------------- helpers

  const isGuest = (userId) => !db.user(userId)?.username;
  const ttlOf = (userId) => (isGuest(userId) ? guestTtlMs : ttlMs);
  const quotaOf = (userId) => (isGuest(userId) ? guestQuotaBytes : quotaBytes);
  const freeSpace = (userId) => Math.max(0, quotaOf(userId) - db.usedBy(userId));

  /** File metadata as sent to the browser. */
  const publicFile = (f) => ({
    id: f.id,
    name: f.name,
    ext: f.ext,
    kind: kindOf(f.ext),
    size: f.size,
    duration: f.duration,
    width: f.width,
    height: f.height,
    platform: f.platform ?? null,
    origin: f.origin,
    createdAt: f.created,
    expiresAt: f.created + ttlOf(f.userId),
    url: `/api/files/${f.id}`,
    thumb: f.thumb ? `/api/files/${f.id}/thumb` : null,
  });

  /** Account summary as sent to the browser. */
  const me = (user) => ({
    username: user.username ?? null,
    guest: !user.username,
    avatar: user.avatar ? `/api/avatars/${user.id}?v=${user.avatar}` : null,
    used: db.usedBy(user.id),
    quota: quotaOf(user.id),
    ttlHours: Math.round(ttlOf(user.id) / HOUR),
    accountQuota: quotaBytes,
    accountTtlHours: Math.round(ttlMs / HOUR),
  });

  /** Creates an empty folder for a new file; its name is the file id. */
  function newFolder() {
    const id = newId();
    mkdirSync(join(filesDir, id));
    return { id, dir: join(filesDir, id) };
  }

  /** Probes a finished file, makes its thumbnail and registers it. */
  async function storeFile(userId, path, name, origin, extra = {}) {
    const info = await probe(bins.ffmpeg, path);
    const id = basename(resolve(path, '..'));
    let thumb = false;
    if (info.hasVideo) {
      try {
        await thumbnail(bins.ffmpeg, path, join(filesDir, id, 'thumb.jpg'), info.duration);
        thumb = true;
      } catch {
        /* thumbnails are optional */
      }
    }
    return db.addFile({
      id,
      userId,
      path,
      name: cleanName(name),
      ext: extname(path).slice(1).toLowerCase(),
      size: statSync(path).size,
      duration: info.duration,
      width: info.width,
      height: info.height,
      origin,
      thumb,
      created: Date.now(),
      ...extra,
    });
  }

  /** Deletes a file from the database and its folder from disk. */
  function deleteFile(file) {
    db.removeFile(file.id);
    rmSync(join(filesDir, file.id), { recursive: true, force: true });
  }

  /** The requested file if it belongs to the current user. */
  function ownFile(req) {
    const file = db.file(req.params.id);
    if (!file || file.userId !== req.user.id || !existsSync(file.path)) {
      throw new AppError(404, 'file_gone', 'The file is no longer available');
    }
    return file;
  }

  // ---------------------------------------------------------------- jobs

  /** Queues background work (download/trim/convert) and returns the job. */
  function submit(userId, kind, name, work) {
    const job = {
      id: newId(),
      userId,
      kind,
      name,
      status: 'queued',
      stage: 'queued',
      progress: 0,
      downloaded: 0,
      total: 0,
      speed: 0,
      eta: null,
      error: null,
      code: null,
      file: null,
      created: Date.now(),
      controller: new AbortController(),
    };
    jobs.set(job.id, job);
    queue.push(async () => {
      if (job.controller.signal.aborted) return;
      job.status = 'running';
      job.stage = 'starting';
      try {
        const file = await work(job, job.controller.signal);
        Object.assign(job, { file: publicFile(file), progress: 1, status: 'done', stage: 'done' });
      } catch (err) {
        if (job.controller.signal.aborted) {
          Object.assign(job, { status: 'cancelled', stage: 'cancelled' });
        } else {
          Object.assign(job, {
            status: 'error',
            stage: 'error',
            code: err instanceof AppError ? err.code : 'internal',
            error: err.message,
          });
        }
      }
    });
    pump();
    return job;
  }

  /** Starts queued jobs while there are free slots. */
  function pump() {
    while (running < maxJobs && queue.length) {
      const task = queue.shift();
      running++;
      task().finally(() => {
        running--;
        pump();
      });
    }
  }

  /** Job data as sent to the browser. */
  const publicJob = ({ controller, userId, ...rest }) => rest;

  /** The requested job if it belongs to the current user. */
  function ownJob(req) {
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== req.user.id) throw new AppError(404, 'job_not_found', 'Job not found');
    return job;
  }

  // ------------------------------------------------------------- janitor

  /** Deletes expired files, old jobs and idle guests. `now` is injectable for tests. */
  function purge(now = Date.now()) {
    for (const f of Object.values(db.data.files)) {
      if (now - f.created > ttlOf(f.userId)) deleteFile(f);
    }
    for (const [id, j] of jobs) {
      if (!['running', 'queued'].includes(j.status) && now - j.created > HOUR) jobs.delete(id);
    }
    for (const u of Object.values(db.data.users)) {
      if (!u.username && now - u.created > 30 * 24 * HOUR && !db.filesOf(u.id).length) db.deleteUser(u.id);
    }
  }
  const janitor = setInterval(purge, 5 * 60_000);
  janitor.unref();

  // ----------------------------------------------------------------- app

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  // Compress the web app and JSON, never media (keeps Range requests intact).
  app.use(
    compression({
      filter: (req, res) => !/^\/api\/(files|avatars)\//.test(req.path) && compression.filter(req, res),
    }),
  );

  const api = express.Router();
  api.use(express.json({ limit: '64kb' }));

  /** Sets the session cookie for a new session. */
  function startSession(req, res, userId) {
    const token = db.createSession(userId);
    req.token = token;
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 365 * 24 * HOUR, path: '/' });
  }

  // Every visitor gets a guest user; registering keeps it (and its files).
  api.use((req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = db.session(token);
    let user = session && db.user(session.userId);
    if (user) {
      req.token = token;
    } else {
      user = db.createGuest();
      startSession(req, res, user.id);
    }
    req.user = user;
    next();
  });

  // Real status: the server answers and both tools are present on disk.
  api.get('/health', (req, res) => {
    const tools = { ffmpeg: existsSync(bins.ffmpeg), ytdlp: existsSync(bins.ytdlp) };
    res.json({ ok: tools.ffmpeg && tools.ytdlp, tools });
  });
  api.get('/me', (req, res) => res.json(me(req.user)));

  // ------------------------------------------------------------ accounts

  /** Validates and returns the username/password of a request body. */
  function credentials(body, strict) {
    const username = String(body?.username ?? '').trim();
    const password = String(body?.password ?? '');
    if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) throw new AppError(400, 'bad_username', 'Invalid username');
    if (password.length > 200) throw new AppError(400, 'weak_password', 'Password too long');
    if (strict) {
      const problems = passwordProblems(password);
      if (problems.length) throw new AppError(400, 'weak_password', `Weak password: ${problems.join(', ')}`);
    }
    return { username, password };
  }

  api.post('/auth/register', (req, res) => {
    const { username, password } = credentials(req.body, true);
    if (db.byUsername(username)) throw new AppError(409, 'user_exists', 'Username already taken');
    let user = req.user;
    if (user.username) {
      // Signed in with another account: create a fresh one.
      user = db.createGuest();
      db.dropSession(req.token);
      startSession(req, res, user.id);
    }
    db.setPassword(user, username, password);
    res.json(me(user));
  });

  api.post('/auth/login', (req, res) => {
    const { username, password } = credentials(req.body, false);
    const user = db.byUsername(username);
    if (!user || !db.checkPassword(user, password)) throw new AppError(401, 'bad_login', 'Wrong username or password');
    const guest = req.user;
    if (!guest.username && guest.id !== user.id) {
      // Keep whatever the visitor made before signing in.
      for (const f of db.filesOf(guest.id)) f.userId = user.id;
      for (const j of jobs.values()) if (j.userId === guest.id) j.userId = user.id;
      db.deleteUser(guest.id);
    } else {
      db.dropSession(req.token);
    }
    startSession(req, res, user.id);
    res.json(me(user));
  });

  api.post('/auth/logout', (req, res) => {
    db.dropSession(req.token);
    const guest = db.createGuest();
    startSession(req, res, guest.id);
    res.json(me(guest));
  });

  // Profile photo: raw image body, 2 MB max, accounts only.
  api.put('/me/avatar', async (req, res) => {
    if (!req.user.username) throw new AppError(403, 'account_required', 'Create an account first');
    const type = String(req.headers['content-type'] ?? '');
    if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) throw new AppError(415, 'bad_image', 'Unsupported image');
    const target = join(avatarsDir, req.user.id);
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 ** 2) req.destroy(new AppError(413, 'bad_image', 'Image too large'));
    });
    try {
      await pipeline(req, createWriteStream(target));
    } catch (err) {
      rmSync(target, { force: true });
      throw err instanceof AppError ? err : new AppError(400, 'upload_interrupted', 'Upload interrupted');
    }
    req.user.avatar = Date.now();
    req.user.avatarType = type;
    db.save();
    res.json(me(req.user));
  });

  api.delete('/me/avatar', (req, res) => {
    rmSync(join(avatarsDir, req.user.id), { force: true });
    req.user.avatar = false;
    db.save();
    res.json(me(req.user));
  });

  api.get('/avatars/:id', (req, res) => {
    const user = db.user(req.params.id);
    const path = join(avatarsDir, basename(req.params.id));
    if (!user?.avatar || !existsSync(path)) throw new AppError(404, 'not_found', 'No avatar');
    res.type(user.avatarType).sendFile(path, { headers: { 'Cache-Control': 'private, max-age=31536000' } });
  });

  // ------------------------------------------------------------- library

  // Guests have a library too (smaller quota, shorter expiry).
  api.get('/library', (req, res) => {
    res.json({ ...me(req.user), files: db.filesOf(req.user.id).map(publicFile) });
  });

  api.put('/upload', async (req, res) => {
    const raw = decodeURIComponent(String(req.headers['x-file-name'] ?? 'file'));
    const ext = (extname(raw).slice(1).toLowerCase() || 'mp4').replace(/[^a-z0-9]/g, '').slice(0, 8);
    const limit = freeSpace(req.user.id);
    if (Number(req.headers['content-length'] ?? 0) > limit) throw new AppError(413, 'no_space', 'Not enough space');
    const { dir } = newFolder();
    const target = join(dir, `source.${ext}`);
    let written = 0;
    req.on('data', (chunk) => {
      written += chunk.length;
      if (written > limit) req.destroy(new AppError(413, 'no_space', 'Not enough space'));
    });
    try {
      await pipeline(req, createWriteStream(target));
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err instanceof AppError ? err : new AppError(400, 'upload_interrupted', 'Upload interrupted');
    }
    const info = await probe(bins.ffmpeg, target);
    if (!info.hasVideo && !info.hasAudio) {
      rmSync(dir, { recursive: true, force: true });
      throw new AppError(415, 'not_media', 'Not a supported video or audio file');
    }
    const name = raw.slice(0, raw.length - extname(raw).length) || 'file';
    res.json(publicFile(await storeFile(req.user.id, target, name, 'upload')));
  });

  api.get('/files/:id/info', (req, res) => res.json(publicFile(ownFile(req))));

  // Files are readable by their unguessable id so share links work.
  api.get('/files/:id', (req, res) => {
    const file = db.file(req.params.id);
    if (!file || !existsSync(file.path)) throw new AppError(404, 'file_gone', 'The file is no longer available');
    const name = `${cleanName(req.query.name || file.name)}.${file.ext}`;
    const ascii = name.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || `video.${file.ext}`;
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader(
      'Content-Disposition',
      `${req.query.download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    );
    res.sendFile(file.path, { dotfiles: 'allow', headers: { 'Cache-Control': 'private, max-age=3600' } });
  });

  api.get('/files/:id/thumb', (req, res) => {
    const file = db.file(req.params.id);
    const path = file && join(filesDir, file.id, 'thumb.jpg');
    if (!path || !existsSync(path)) throw new AppError(404, 'not_found', 'No thumbnail');
    res.sendFile(path, { dotfiles: 'allow', headers: { 'Cache-Control': 'private, max-age=86400' } });
  });

  // Timeline strip for the trimmer, made once with FFmpeg and cached next to the file.
  const strips = new Map();
  api.get('/files/:id/strip', async (req, res) => {
    const file = db.file(req.params.id);
    if (!file || !existsSync(file.path) || !file.width || !file.duration) throw new AppError(404, 'not_found', 'No strip');
    const path = join(filesDir, file.id, 'strip.jpg');
    if (!existsSync(path)) {
      if (!strips.has(file.id)) strips.set(file.id, strip(bins.ffmpeg, file.path, path, file.duration).finally(() => strips.delete(file.id)));
      await strips.get(file.id);
    }
    res.sendFile(path, { dotfiles: 'allow', headers: { 'Cache-Control': 'private, max-age=86400' } });
  });

  api.patch('/files/:id', (req, res) => {
    const file = ownFile(req);
    file.name = cleanName(req.body?.name, file.name);
    db.save();
    res.json(publicFile(file));
  });

  // Deleting removes the file from disk right away.
  api.delete('/files/:id', (req, res) => {
    const file = ownFile(req);
    for (const j of jobs.values()) if (j.file?.id === file.id) j.file = null;
    deleteFile(file);
    res.json({ deleted: true, id: file.id });
  });

  // --------------------------------------------------------------- music

  // A YouTube/Spotify link (song or playlist) → the songs it contains.
  api.post('/music/resolve', async (req, res) => {
    res.json(await resolveMusic(bins, req.body?.url, { cookies, extraHosts }));
  });

  // Audio of one song, streamed to the browser (which keeps it) and deleted here.
  let musicBusy = 0;
  api.post('/music/audio', async (req, res) => {
    if (musicBusy >= 3) throw new AppError(429, 'busy', 'Too many songs at once, try again');
    musicBusy++;
    const folder = join(musicDir, newId());
    mkdirSync(folder);
    const controller = new AbortController();
    const cleanup = () => rmSync(folder, { recursive: true, force: true });
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
      cleanup();
    });
    try {
      const b = req.body ?? {};
      const path = await downloadMusic(bins, { url: b.url, query: b.query }, folder, {
        cookies,
        extraHosts,
        signal: controller.signal,
      });
      res.setHeader('Content-Type', AUDIO_TYPES[extname(path).slice(1)] ?? 'application/octet-stream');
      res.setHeader('Content-Length', statSync(path).size);
      res.setHeader('Cache-Control', 'no-store');
      await pipeline(createReadStream(path), res);
    } finally {
      musicBusy--;
      cleanup();
    }
  });

  // ------------------------------------------------------------ download

  api.post('/info', async (req, res) => {
    res.json(await getInfo(bins, req.body?.url, { cookies, extraHosts }));
  });

  api.post('/fetch', (req, res) => {
    const b = req.body ?? {};
    const platform = platformFor(b.url, extraHosts);
    const free = freeSpace(req.user.id);
    if (free < 1024 ** 2) throw new AppError(413, 'library_full', 'Your storage is full');
    const name = cleanName(b.name, 'download');
    const userId = req.user.id;
    const job = submit(userId, 'download', name, async (job, signal) => {
      const { dir } = newFolder();
      try {
        job.stage = 'reading';
        const options = {
          mode: b.mode === 'audio' ? 'audio' : 'video',
          quality: String(b.quality ?? ''),
          fps: [30, 60].includes(Number(b.fps)) ? Number(b.fps) : undefined,
          container: VIDEO_CONTAINERS.includes(b.container) ? b.container : 'mp4',
          audioFormat: AUDIO_FORMATS.includes(b.audioFormat) ? b.audioFormat : 'mp3',
        };
        const path = await download(bins, b.url, dir, options, {
          cookies,
          extraHosts,
          maxBytes: free,
          signal,
          onProgress: (p) => Object.assign(job, p),
        });
        return await storeFile(userId, path, name, 'download', { platform });
      } catch (err) {
        rmSync(dir, { recursive: true, force: true });
        throw err;
      }
    });
    res.json(publicJob(job));
  });

  // ---------------------------------------------------- trim & convert

  const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

  api.post('/files/:id/trim', (req, res) => {
    const src = ownFile(req);
    const b = req.body ?? {};
    const start = Math.max(0, num(b.start));
    const end = Math.min(num(b.end), src.duration || Infinity);
    if (!(end > start)) throw new AppError(400, 'bad_range', 'The end must be after the start');
    const aspect = ['original', '9:16', '1:1', '21:9'].includes(b.aspect) ? b.aspect : 'original';
    const name = cleanName(b.name, `${src.name} (clip)`);
    const job = submit(req.user.id, 'trim', name, async (job, signal) => {
      job.stage = 'trimming';
      const info = await probe(bins.ffmpeg, src.path);
      const { args, ext } = trimArgs(
        src.path,
        src.ext,
        { start, end, copy: b.copy !== false, aspect, volume: num(b.volume, 1), mute: !!b.mute },
        info,
      );
      return encode(job, signal, args, ext, end - start, name, 'trim', src);
    });
    res.json(publicJob(job));
  });

  api.post('/files/:id/convert', (req, res) => {
    const src = ownFile(req);
    const b = req.body ?? {};
    if (!FORMATS.includes(b.format)) throw new AppError(400, 'bad_format', 'Unsupported format');
    const name = cleanName(b.name, src.name);
    const job = submit(req.user.id, 'convert', name, async (job, signal) => {
      job.stage = 'converting';
      const info = await probe(bins.ffmpeg, src.path);
      const { args, ext } = convertArgs(src.path, info, {
        format: b.format,
        codec: b.codec,
        preset: b.preset in PRESETS ? b.preset : 'original',
        quality: b.quality,
        audioKbps: num(b.audioKbps, 192),
        gifFps: num(b.gifFps, 15),
      });
      return encode(job, signal, args, ext, info.duration, name, 'convert', src);
    });
    res.json(publicJob(job));
  });

  /** Runs FFmpeg into a new folder and registers the result. */
  async function encode(job, signal, args, ext, duration, name, origin, src) {
    if (freeSpace(job.userId) <= 0) throw new AppError(413, 'library_full', 'Your storage is full');
    const { dir } = newFolder();
    const out = join(dir, `output.${ext}`);
    try {
      await run(bins.ffmpeg, args, out, { duration, signal, onProgress: (p) => (job.progress = p) });
      if (statSync(out).size > freeSpace(job.userId)) throw new AppError(413, 'no_space', 'The result does not fit');
      return await storeFile(job.userId, out, name, origin, { platform: src.platform ?? null });
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  api.get('/jobs/:id', (req, res) => res.json(publicJob(ownJob(req))));
  api.delete('/jobs/:id', (req, res) => {
    const job = ownJob(req);
    job.controller.abort();
    if (job.status === 'queued') Object.assign(job, { status: 'cancelled', stage: 'cancelled' });
    res.json(publicJob(job));
  });

  api.use((req, res) => res.status(404).json({ code: 'not_found', detail: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, _next) => {
    const known = err instanceof AppError;
    const status = known ? err.status : err.status ?? err.statusCode ?? 500;
    res.status(status).json({
      code: known ? err.code : status < 500 ? 'bad_request' : 'internal',
      detail: known || status < 500 ? err.message : 'Internal server error',
    });
    if (status >= 500) options.log?.(`API error: ${err.stack ?? err}`);
  });

  app.use('/api', api);

  // ------------------------------------------------------------- web app

  if (webDir && existsSync(webDir)) {
    const root = resolve(webDir);
    app.use(
      express.static(root, {
        index: 'index.html',
        /** Long cache for hashed assets, no cache for the HTML shell. */
        setHeaders(res, path) {
          if (/\.(js|css|woff2)$/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          else if (/\.(svg|png|ico)$/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000');
          else if (path.endsWith('.webmanifest')) res.setHeader('Cache-Control', 'public, max-age=86400');
          else res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    // Single-page app: any other GET returns the prerendered page.
    app.get(/.*/, (req, res) => {
      const file = join(root, 'index.html');
      if (!file.startsWith(root + sep)) return res.status(404).end();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(file);
    });
  }

  return {
    app,
    db,
    purge,
    /** Stops the janitor, cancels running jobs and flushes the database. */
    close() {
      clearInterval(janitor);
      for (const j of jobs.values()) j.controller.abort();
      db.flush();
    },
  };
}
