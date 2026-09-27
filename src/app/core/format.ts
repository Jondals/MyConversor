// Formatting helpers: platform detection, sizes, durations, timecodes and
// relative times (translated through the `t` function passed in).
import type { I18n } from './i18n';

type T = I18n['t'];

export interface Platform {
  id: 'youtube' | 'tiktok' | 'instagram' | 'x' | 'twitch' | 'vimeo';
  label: string;
  color: string;
}

export const PLATFORMS: (Platform & { pattern: RegExp })[] = [
  { id: 'youtube', label: 'YouTube', color: '#ef4444', pattern: /(^|\.)(youtube\.com|youtu\.be)$/ },
  { id: 'tiktok', label: 'TikTok', color: '#3b82f6', pattern: /(^|\.)tiktok\.com$/ },
  { id: 'instagram', label: 'Instagram', color: '#facc15', pattern: /(^|\.)instagram\.com$/ },
  { id: 'x', label: 'X / Twitter', color: '#94a3b8', pattern: /(^|\.)(x\.com|twitter\.com)$/ },
  { id: 'twitch', label: 'Twitch', color: '#3b82f6', pattern: /(^|\.)twitch\.tv$/ },
  { id: 'vimeo', label: 'Vimeo', color: '#3b82f6', pattern: /(^|\.)vimeo\.com$/ },
];

/** Parses user input as a URL (adding https:// when missing). */
export function parseUrl(value: string): URL | null {
  const text = value.trim();
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return url.hostname.includes('.') ? url : null;
  } catch {
    return null;
  }
}

/** Supported platform of a link, or null. */
export function detectPlatform(value: string): Platform | null {
  const url = parseUrl(value);
  if (!url) return null;
  const host = url.hostname.replace(/^www\./, '');
  const match = PLATFORMS.find((p) => p.pattern.test(host));
  return match ? { id: match.id, label: match.label, color: match.color } : null;
}

/** Human file size (KB / MB / GB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const mb = bytes / 1024 ** 2;
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(mb < 10240 ? 2 : 1)} GB`;
}

/** m:ss or h:mm:ss. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** mm:ss.mmm — timecode used by the trimmer. */
export function formatTimecode(seconds: number): string {
  const t = Math.max(0, seconds || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** "5 min ago"-style label. */
export function relativeTime(t: T, timestamp: number, now = Date.now()): string {
  const min = Math.round((now - timestamp) / 60000);
  if (min < 1) return t('time.now');
  if (min < 60) return t('time.minAgo', { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return t('time.hAgo', { n: h });
  if (h < 48) return t('time.yesterday');
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Time left until `timestamp` ("45 min", "5 h"). */
export function timeLeft(t: T, timestamp: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((timestamp - now) / 60000));
  return min < 60 ? t('time.min', { n: min }) : t('time.h', { n: Math.round(min / 60) });
}

/** Rough duration label ("12 s", "3 min"). */
export function shortDuration(t: T, seconds: number): string {
  return seconds < 60
    ? t('time.s', { n: Math.max(1, Math.round(seconds)) })
    : t('time.min', { n: Math.round(seconds / 60) });
}
