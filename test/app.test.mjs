// MyConversor end-to-end test: accounts, uploads, downloads (yt-dlp), trims and
// conversions (FFmpeg), the library, quotas, expiry, music links and the web app.
// Everything runs in a temporary folder that is deleted at the end.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureBinaries } from '../server/binaries.mjs';
import { createApp, passwordProblems } from '../server/app.mjs';
import { summarizeFormats } from '../server/downloader.mjs';
import { musicSource, parseSpotifyEmbed, parseSpotifyUrl } from '../server/music.mjs';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const tmp = mkdtempSync(join(tmpdir(), 'myconversor-test-'));
const webDir = process.env.MYCONVERSOR_TEST_WEB; // set by `pnpm check`
let bins, ctx, server, media, base, sample;

/** Minimal cookie-keeping client: each instance is one browser/visitor. */
class Client {
  cookie = '';
  /** Raw request keeping the session cookie. */
  async req(method, path, body, headers = {}) {
    const isJson = body !== undefined && !(body instanceof Uint8Array);
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(this.cookie && { cookie: this.cookie }),
        ...(isJson && { 'content-type': 'application/json' }),
        ...headers,
      },
      body: isJson ? JSON.stringify(body) : body,
    });
    // Like a browser: the last Set-Cookie for the session wins.
    const set = res.headers
      .getSetCookie()
      .filter((c) => c.startsWith('mc_session='))
      .pop();
    if (set) this.cookie = set.split(';')[0];
    return res;
  }
  /** JSON request that asserts the status code. */
  async json(method, path, body, status = 200) {
    const res = await this.req(method, path, body);
    const data = await res.json();
    assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }
  /** Uploads a file. */
  upload(name, bytes) {
    return this.req('PUT', '/api/upload', bytes, { 'x-file-name': encodeURIComponent(name) });
  }
  /** Polls a job until it finishes. */
  async wait(job, timeout = 120_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      job = await this.json('GET', `/api/jobs/${job.id}`);
      if (['done', 'error', 'cancelled'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('job timed out');
  }
}

before(async () => {
  bins = await ensureBinaries({ dir: join(root, '.bin'), log: () => {} });
  sample = join(tmp, 'sample clip.mp4');
  const gen = spawnSync(bins.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=30:duration=4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=4',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '15',
    '-c:a',
    'aac',
    '-shortest',
    sample,
  ]);
  assert.equal(gen.status, 0, String(gen.stderr));

  // Stand-in for a video platform: serves the sample over HTTP for yt-dlp.
  media = createServer((req, res) => {
    const data = readFileSync(sample);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': data.length });
    res.end(data);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => media.once('listening', r));

  ctx = createApp({
    dataDir: join(tmp, 'data'),
    bins,
    webDir,
    quotaBytes: 60 * 1024 ** 2,
    guestQuotaBytes: 30 * 1024 ** 2,
    extraHosts: ['127.0.0.1'],
  });
  server = createServer(ctx.app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  ctx?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
  await new Promise((r) => (media ? media.close(r) : r()));
  rmSync(tmp, { recursive: true, force: true });
  assert.equal(existsSync(tmp), false, 'the test must not leave files behind');
});

describe('MyConversor', () => {
  const alice = new Client();
  const PASSWORD = 'Secreto#2026';
  let upload;

  test('every visitor gets a guest account without a library', async () => {
    const me = await alice.json('GET', '/api/me');
    assert.equal(me.guest, true);
    assert.equal(me.used, 0);
    assert.equal(me.ttlHours, 2);
    assert.equal(me.quota, 30 * 1024 ** 2);
    assert.match(alice.cookie, /^mc_session=/);
    assert.deepEqual((await alice.json('GET', '/api/library')).files, []);
  });

  test('guests can upload and process, but nothing is listed in a library', async () => {
    const res = await alice.upload('guest.mp4', readFileSync(sample));
    assert.equal(res.status, 200);
    const file = await res.json();
    assert.deepEqual((await alice.json('GET', '/api/library')).files, []);
    const job = await alice.wait(await alice.json('POST', `/api/files/${file.id}/trim`, { start: 0, end: 1 }));
    assert.equal(job.status, 'done', job.error);
  });

  test('passwords must be strong (10+ chars, upper, lower, number, symbol)', async () => {
    assert.deepEqual(passwordProblems('abc'), ['length', 'upper', 'number', 'symbol']);
    assert.deepEqual(passwordProblems(PASSWORD), []);
    const weak = await alice.json('POST', '/api/auth/register', { username: 'alice', password: 'secreto123' }, 400);
    assert.equal(weak.code, 'weak_password');
    const bad = await alice.json('POST', '/api/auth/register', { username: 'a', password: PASSWORD }, 400);
    assert.equal(bad.code, 'bad_username');
  });

  test('creating an account unlocks the library (50 GB-style quota, 24 h) and keeps guest files', async () => {
    const me = await alice.json('POST', '/api/auth/register', { username: 'alice', password: PASSWORD });
    assert.equal(me.guest, false);
    assert.equal(me.quota, 60 * 1024 ** 2);
    assert.equal(me.ttlHours, 24);
    assert.equal((await alice.json('GET', '/api/library')).files.length, 2);
    const dup = await new Client().json('POST', '/api/auth/register', { username: 'ALICE', password: PASSWORD }, 409);
    assert.equal(dup.code, 'user_exists');
  });

  test('profile photo upload', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    const res = await alice.req('PUT', '/api/me/avatar', new Uint8Array(png), { 'content-type': 'image/png' });
    const me = await res.json();
    assert.equal(res.status, 200, JSON.stringify(me));
    assert.match(me.avatar, /^\/api\/avatars\//);
    const img = await alice.req('GET', me.avatar);
    assert.equal(img.headers.get('content-type'), 'image/png');
    const text = await alice.req('PUT', '/api/me/avatar', new TextEncoder().encode('x'), { 'content-type': 'text/plain' });
    assert.equal(text.status, 415);
  });

  test('uploads are probed, thumbnailed and kept in the library', async () => {
    const res = await alice.upload('sample clip.mp4', readFileSync(sample));
    upload = await res.json();
    assert.equal(res.status, 200, JSON.stringify(upload));
    assert.equal(upload.name, 'sample clip');
    assert.equal(upload.origin, 'upload');
    assert.equal(upload.width, 640);
    assert.ok(upload.duration > 3.9 && upload.duration < 4.2);
    assert.equal(upload.expiresAt - upload.createdAt, 24 * 3600_000);
    const thumb = await alice.req('GET', upload.thumb);
    assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
    const lib = await alice.json('GET', '/api/library');
    assert.equal(lib.files[0].id, upload.id);
  });

  test('non-media uploads are rejected with a code', async () => {
    const res = await alice.upload('notes.txt', new TextEncoder().encode('hola'));
    assert.equal(res.status, 415);
    assert.equal((await res.json()).code, 'not_media');
  });

  test('files stream with range requests and download with a custom name', async () => {
    const part = await alice.req('GET', upload.url, undefined, { range: 'bytes=0-99' });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    const dl = await alice.req('GET', `${upload.url}?download=1&name=${encodeURIComponent('Mi vídeo')}`);
    assert.match(dl.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''Mi%20v%C3%ADdeo\.mp4/);
    await dl.arrayBuffer();
  });

  test('trim: stream copy, reframe to 9:16 and audio volume/mute', async () => {
    const copy = await alice.wait(
      await alice.json('POST', `/api/files/${upload.id}/trim`, { start: 1, end: 3, name: 'Clip' }),
    );
    assert.equal(copy.status, 'done', copy.error);
    assert.equal(copy.file.name, 'Clip');
    assert.equal(copy.file.origin, 'trim');
    assert.ok(copy.file.duration > 1.5 && copy.file.duration < 2.6);

    const vertical = await alice.wait(
      await alice.json('POST', `/api/files/${upload.id}/trim`, { start: 0, end: 2, aspect: '9:16', volume: 1.5 }),
    );
    assert.equal(vertical.status, 'done', vertical.error);
    assert.deepEqual([vertical.file.width, vertical.file.height], [1080, 1920]);

    const muted = await alice.wait(
      await alice.json('POST', `/api/files/${upload.id}/trim`, { start: 0, end: 2, mute: true }),
    );
    assert.equal(muted.status, 'done', muted.error);
    const probe = spawnSync(bins.ffmpeg, ['-hide_banner', '-i', join(tmp, 'data/files', muted.file.id, 'output.mp4')]);
    assert.doesNotMatch(String(probe.stderr), /Audio:/);

    const range = await alice.json('POST', `/api/files/${upload.id}/trim`, { start: 3, end: 1 }, 400);
    assert.equal(range.code, 'bad_range');
  });

  for (const [body, ext] of [
    [{ format: 'mp4', codec: 'h264', preset: 'youtube' }, 'mp4'],
    [{ format: 'webm', codec: 'vp9', quality: 'light' }, 'webm'],
    [{ format: 'mkv', codec: 'h265', preset: 'square' }, 'mkv'],
    [{ format: 'avi' }, 'avi'],
    [{ format: 'gif', gifFps: 10 }, 'gif'],
    [{ format: 'webp', quality: 'light' }, 'webp'],
    [{ format: 'mp3', audioKbps: 128 }, 'mp3'],
    [{ format: 'opus' }, 'opus'],
    [{ format: 'ogg' }, 'ogg'],
    [{ format: 'flac' }, 'flac'],
  ]) {
    test(`convert to ${body.format}`, async () => {
      const job = await alice.wait(await alice.json('POST', `/api/files/${upload.id}/convert`, { ...body, name: 'Salida' }));
      assert.equal(job.status, 'done', job.error);
      assert.equal(job.file.ext, ext);
      assert.equal(job.file.origin, 'convert');
      assert.ok(job.file.size > 0);
    });
  }

  test('qualities keep the best frame rate per resolution and stop at 4K', () => {
    const f = (width, height, fps) => ({ vcodec: 'avc1', width, height, fps });
    const info = { formats: [f(7680, 4320, 60), f(3840, 2160, 60), f(2560, 1440, 60), f(1920, 1080, 30), f(1920, 1080, 60), f(1280, 720, 30), f(1080, 1920, 30)] };
    assert.deepEqual(summarizeFormats(info).qualities, [
      { height: 2160, fps: 60 },
      { height: 1440, fps: 60 },
      { height: 1080, fps: 60 },
      { height: 720, fps: 30 },
    ]);
  });

  test('formats without a video codec but with a height count as video (Twitch clips)', () => {
    const twitch = { formats: [360, 720, 1080].map((height) => ({ format_id: `${height}`, height, ext: 'mp4' })) };
    assert.deepEqual(summarizeFormats(twitch).heights, [1080, 720, 360]);
    assert.equal(summarizeFormats(twitch).hasVideo, true);
    const audio = { formats: [{ vcodec: 'none', acodec: 'opus' }] };
    assert.equal(summarizeFormats(audio).hasVideo, false);
  });

  test('health reports the tools, and the trimmer strip is made with FFmpeg', async () => {
    assert.deepEqual(await alice.json('GET', '/api/health'), { ok: true, tools: { ffmpeg: true, ytdlp: true } });
    const res = await alice.req('GET', `/api/files/${upload.id}/strip`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.ok((await res.arrayBuffer()).byteLength > 1000);
  });

  test('music links: YouTube and Spotify are recognised, Spotify pages are parsed', () => {
    assert.equal(musicSource('https://music.youtube.com/watch?v=abc'), 'youtube');
    assert.equal(musicSource('https://youtu.be/abc'), 'youtube');
    assert.equal(musicSource('https://open.spotify.com/intl-es/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x'), 'spotify');
    assert.throws(() => musicSource('https://soundcloud.com/a/b'), { code: 'music_unsupported' });
    assert.deepEqual(parseSpotifyUrl('https://open.spotify.com/intl-es/album/4aawyAB9vmqN3uQ7FjRGTy?si=1'), { type: 'album', id: '4aawyAB9vmqN3uQ7FjRGTy' });
    assert.throws(() => parseSpotifyUrl('https://open.spotify.com/artist/4aawyAB9vmqN3uQ7FjRGTy'), { code: 'music_unsupported' });
    const page = (entity) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></html>`;
    const track = parseSpotifyEmbed(page({ type: 'track', name: 'Song', artists: [{ name: 'A' }, { name: 'B' }], duration: 181270 }));
    assert.deepEqual(track.items, [{ title: 'A, B - Song', duration: 181, query: 'A, B Song' }]);
    const list = parseSpotifyEmbed(page({ type: 'playlist', name: 'Hits', trackList: [{ title: 'One', subtitle: 'X', duration: 3_600_000 }] }));
    assert.equal(list.title, 'Hits');
    assert.deepEqual(list.items, [{ title: 'X - One', duration: 3600, query: 'X One' }]);
  });

  test('music from a link: resolve it and stream the audio (nothing kept on the server)', async () => {
    const url = `http://127.0.0.1:${media.address().port}/watch.mp4`;
    const { items } = await alice.json('POST', '/api/music/resolve', { url });
    assert.equal(items.length, 1);
    assert.equal(items[0].url, url);
    const res = await alice.req('POST', '/api/music/audio', { url });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^audio\//);
    assert.ok((await res.arrayBuffer()).byteLength > 1000);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(readdirSync(join(tmp, 'data', 'music-tmp')), []);
    const bad = await alice.json('POST', '/api/music/resolve', { url: 'https://example.com/song' }, 400);
    assert.equal(bad.code, 'music_unsupported');
  });

  test('download from a platform link with yt-dlp (video and audio)', async () => {
    const url = `http://127.0.0.1:${media.address().port}/watch.mp4`;
    const info = await alice.json('POST', '/api/info', { url });
    assert.equal(info.platform, 'YouTube');
    const video = await alice.wait(await alice.json('POST', '/api/fetch', { url, name: 'Título original', quality: 'best' }));
    assert.equal(video.status, 'done', video.error);
    assert.equal(video.file.name, 'Título original');
    assert.equal(video.file.origin, 'download');
    assert.ok(video.downloaded > 0);
    const audio = await alice.wait(
      await alice.json('POST', '/api/fetch', { url, mode: 'audio', quality: '128', audioFormat: 'opus' }),
    );
    assert.equal(audio.status, 'done', audio.error);
    assert.equal(audio.file.kind, 'audio');
  });

  test('only supported platforms are accepted', async () => {
    for (const [url, code] of [
      ['https://example.com/v', 'unsupported_platform'],
      ['file:///etc/passwd', 'invalid_url'],
      ['http://localhost:1/x', 'unsupported_platform'],
    ]) {
      assert.equal((await alice.json('POST', '/api/fetch', { url }, 400)).code, code);
      assert.equal((await alice.json('POST', '/api/info', { url }, 400)).code, code);
    }
  });

  test('rename; other visitors cannot touch my files; share links work', async () => {
    const bob = new Client();
    await bob.json('GET', '/api/me');
    await bob.json('DELETE', `/api/files/${upload.id}`, undefined, 404);
    await bob.json('PATCH', `/api/files/${upload.id}`, { name: 'hack' }, 404);
    const renamed = await alice.json('PATCH', `/api/files/${upload.id}`, { name: 'Nuevo / nombre' });
    assert.equal(renamed.name, 'Nuevo nombre');
    assert.equal((await bob.req('GET', upload.url, undefined, { range: 'bytes=0-9' })).status, 206);
  });

  test('deleting a file removes it from disk immediately', async () => {
    const res = await alice.upload('borrar.mp4', readFileSync(sample));
    const file = await res.json();
    const folder = join(tmp, 'data/files', file.id);
    assert.ok(existsSync(folder));
    await alice.json('DELETE', `/api/files/${file.id}`);
    assert.equal(existsSync(folder), false);
    assert.equal((await alice.req('GET', file.url)).status, 404);
  });

  test('quota: uploads that do not fit are refused', async () => {
    const { used, quota } = await alice.json('GET', '/api/me');
    const res = await alice.upload('big.mp4', new Uint8Array(quota - used + 1024));
    assert.equal(res.status, 413);
    assert.equal((await res.json()).code, 'no_space');
  });

  test('login merges a visitor\'s files; logout starts a fresh guest', async () => {
    const before = (await alice.json('GET', '/api/library')).files.length;
    const phone = new Client();
    assert.equal((await phone.upload('movil.mp4', readFileSync(sample))).status, 200);
    const wrong = await phone.json('POST', '/api/auth/login', { username: 'alice', password: 'incorrecta' }, 401);
    assert.equal(wrong.code, 'bad_login');
    await phone.json('POST', '/api/auth/login', { username: 'alice', password: PASSWORD });
    assert.equal((await phone.json('GET', '/api/library')).files.length, before + 1);
    const out = await alice.json('POST', '/api/auth/logout');
    assert.equal(out.guest, true);
    assert.deepEqual((await alice.json('GET', '/api/library')).files, []);
  });

  test('files expire: 2 h for guests, 24 h for accounts', async () => {
    const guest = new Client();
    const g = await (await guest.upload('g.mp4', readFileSync(sample))).json();
    const phone = new Client();
    await phone.json('POST', '/api/auth/login', { username: 'alice', password: PASSWORD });
    const count = (await phone.json('GET', '/api/library')).files.length;
    ctx.purge(Date.now() + 3 * 3600_000);
    assert.equal((await guest.req('GET', g.url)).status, 404);
    assert.equal((await phone.json('GET', '/api/library')).files.length, count);
    ctx.purge(Date.now() + 25 * 3600_000);
    assert.deepEqual((await phone.json('GET', '/api/library')).files, []);
    assert.equal(readdirSync(join(tmp, 'data/files')).length, 0);
  });

  test('cancelling a job stops it', async () => {
    const res = await alice.upload('c.mp4', readFileSync(sample));
    const file = await res.json();
    const job = await alice.json('POST', `/api/files/${file.id}/convert`, { format: 'webm', codec: 'av1', quality: 'high' });
    await alice.json('DELETE', `/api/jobs/${job.id}`);
    assert.equal((await alice.wait(job)).status, 'cancelled');
  });

  test('real Twitch clip is detected as video', { skip: !process.env.MYCONVERSOR_NETWORK_TESTS && 'needs internet' }, async () => {
    const url = 'https://www.twitch.tv/noasauruss/clip/BadAttractiveHerbsDerp-u8CcgZmf-aKiS8CU?range=7d';
    const info = await alice.json('POST', '/api/info', { url });
    assert.equal(info.hasVideo, true);
    assert.ok(info.heights.includes(1080));
  });

  test('serves the single-page web app', { skip: !webDir && 'set by pnpm check' }, async () => {
    const res = await alice.req('GET', '/biblioteca');
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<title>MyConversor/);
    assert.match(html, /github\.com\/Jondals/);
    assert.equal((await alice.req('GET', '/api/nope')).status, 404);
  });
});
