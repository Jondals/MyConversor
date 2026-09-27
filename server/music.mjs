// Background music from links: turns a YouTube or Spotify link (a single song
// or a playlist/album) into a list of songs, and fetches the audio of one song
// with yt-dlp. Spotify audio can't be downloaded (DRM), so its public embed page
// is read for title/artist/duration and the song is looked up on YouTube.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { baseArgs, collect, toAppError } from './downloader.mjs';
import { AppError } from './errors.mjs';

/** Songs a link can add at most, and the longest song accepted (4 h). */
export const MUSIC_MAX_ITEMS = 30;
export const MUSIC_MAX_SECONDS = 4 * 3600;
export const MUSIC_MAX_BYTES = 350 * 1024 ** 2;

const SPOTIFY_TYPES = ['track', 'album', 'playlist'];

/** Tells whether a link is YouTube or Spotify (throws otherwise). `extraHosts` is for tests. */
export function musicSource(url, extraHosts = []) {
  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    throw new AppError(400, 'invalid_url', 'Invalid link');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new AppError(400, 'invalid_url', 'Invalid link');
  const host = parsed.hostname.toLowerCase();
  const is = (d) => host === d || host.endsWith(`.${d}`);
  if (extraHosts.includes(host) || is('youtube.com') || is('youtu.be')) return 'youtube';
  if (host === 'open.spotify.com') return 'spotify';
  throw new AppError(400, 'music_unsupported', 'Only YouTube and Spotify links');
}

/** Reads the type (track, album, playlist) and id from an open.spotify.com link. */
export function parseSpotifyUrl(url) {
  const parts = new URL(url).pathname.split('/').filter((p) => p && !p.startsWith('intl-'));
  const [type, id] = parts[0] === 'embed' ? parts.slice(1) : parts;
  if (!SPOTIFY_TYPES.includes(type) || !/^[A-Za-z0-9]{10,40}$/.test(id ?? '')) {
    throw new AppError(400, 'music_unsupported', 'Unsupported Spotify link');
  }
  return { type, id };
}

/** Extracts the songs from a Spotify embed page (its Next.js JSON data). */
export function parseSpotifyEmbed(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  const entity = m && JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new AppError(422, 'music_not_found', 'Could not read the Spotify link');
  const tracks =
    entity.type === 'track'
      ? [{ title: entity.name ?? entity.title, artist: (entity.artists ?? []).map((a) => a.name).join(', '), duration: entity.duration }]
      : (entity.trackList ?? []).map((t) => ({ title: t.title, artist: t.subtitle ?? '', duration: t.duration }));
  const items = tracks
    .filter((t) => t.title)
    .map((t) => ({
      title: t.artist ? `${t.artist} - ${t.title}` : t.title,
      duration: Math.round((t.duration ?? 0) / 1000),
      query: `${t.artist} ${t.title}`.trim(),
    }));
  return { title: entity.name ?? entity.title ?? 'Spotify', items };
}

/**
 * Turns a link into songs: [{title, duration, url?, query?}]. YouTube songs
 * carry their `url`; Spotify songs carry a YouTube search `query`.
 */
export async function resolveMusic(bins, url, { cookies, extraHosts = [], fetchImpl = fetch } = {}) {
  const source = musicSource(url, extraHosts);
  let result;
  if (source === 'spotify') {
    const { type, id } = parseSpotifyUrl(url);
    const res = await fetchImpl(`https://open.spotify.com/embed/${type}/${id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) MyConversor' },
    }).catch(() => null);
    if (!res?.ok) throw new AppError(422, 'music_not_found', 'Could not read the Spotify link');
    result = parseSpotifyEmbed(await res.text());
  } else {
    const isList = new URL(url).searchParams.has('list');
    const args = [...baseArgs(bins, cookies), '-J', '--flat-playlist'];
    if (isList) args.push('--yes-playlist', '--playlist-end', String(MUSIC_MAX_ITEMS * 2));
    const info = JSON.parse(await collect(bins.ytdlp, [...args, '--', url]));
    const entries = info.entries ?? [info];
    result = {
      title: info.title ?? 'YouTube',
      items: entries
        .filter((e) => e && (e.url || e.webpage_url || e.id) && e.title !== '[Private video]' && e.title !== '[Deleted video]')
        .map((e) => ({
          title: e.title ?? 'YouTube',
          duration: Math.round(e.duration ?? 0),
          url: e.webpage_url ?? (e.url?.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`),
        })),
    };
  }
  result.items = result.items.filter((i) => !i.duration || i.duration <= MUSIC_MAX_SECONDS).slice(0, MUSIC_MAX_ITEMS);
  if (!result.items.length) throw new AppError(422, 'music_not_found', 'No songs found in the link');
  return result;
}

/** Runs yt-dlp once for one candidate URL; resolves with the saved path. */
function fetchAudio(bins, url, folder, { cookies, signal }) {
  const args = [
    ...baseArgs(bins, cookies),
    '-f',
    'ba[ext=m4a]/ba/b',
    '-x',
    '--match-filter',
    `duration <=? ${MUSIC_MAX_SECONDS}`,
    '--max-filesize',
    String(MUSIC_MAX_BYTES),
    '-o',
    join(folder, 'song.%(ext)s'),
    '--',
    url,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(bins.ytdlp, args);
    const abort = () => proc.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    let err = '';
    proc.stderr.on('data', (d) => (err = (err + d).slice(-8000)));
    proc.on('error', reject);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(new AppError(499, 'cancelled', 'Cancelled'));
      const file = readdirSync(folder).find((f) => f.startsWith('song.') && !f.endsWith('.part'));
      if (code === 0 && file) return resolve(join(folder, file));
      reject(code === 0 ? new AppError(422, 'too_long', 'The song is too long') : toAppError(err));
    });
  });
}

/**
 * Downloads the audio of one song into `folder`. A search query tries the
 * first few YouTube results in turn, so one blocked video doesn't fail the song.
 */
export async function downloadMusic(bins, song, folder, { cookies, extraHosts = [], signal } = {}) {
  let candidates;
  if (song.url) {
    if (musicSource(song.url, extraHosts) !== 'youtube') throw new AppError(400, 'music_unsupported', 'Only YouTube audio');
    candidates = [song.url];
  } else {
    const query = String(song.query ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!query) throw new AppError(400, 'invalid_url', 'Nothing to search');
    const found = JSON.parse(await collect(bins.ytdlp, [...baseArgs(bins, cookies), '-J', '--flat-playlist', '--', `ytsearch3:${query} audio`]));
    candidates = (found.entries ?? []).map((e) => e.url ?? `https://www.youtube.com/watch?v=${e.id}`);
    if (!candidates.length) throw new AppError(422, 'music_not_found', 'Song not found on YouTube');
  }
  let last;
  for (const url of candidates) {
    try {
      return await fetchAudio(bins, url, folder, { cookies, signal });
    } catch (err) {
      if (err?.code === 'cancelled') throw err;
      last = err;
    }
  }
  throw last;
}
