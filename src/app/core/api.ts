// Typed client for the MyConversor server API (see server/app.mjs).
import { Injectable } from '@angular/core';

export type MediaKind = 'video' | 'audio' | 'gif' | 'image' | 'document';
export type Origin = 'download' | 'upload' | 'trim' | 'convert';

/** A file in the user's library on the MyConversor server. */
export interface RemoteFile {
  id: string;
  name: string;
  ext: string;
  kind: MediaKind;
  size: number;
  duration: number;
  width: number;
  height: number;
  platform: string | null;
  origin: Origin;
  createdAt: number;
  expiresAt: number;
  url: string;
  thumb: string | null;
}

export interface Me {
  username: string | null;
  guest: boolean;
  avatar: string | null;
  used: number;
  quota: number;
  ttlHours: number;
  /** Quota and retention a registered account gets. */
  accountQuota: number;
  accountTtlHours: number;
}

export interface VideoInfo {
  url: string;
  title: string;
  uploader: string;
  duration: number;
  thumbnail: string | null;
  platform: string;
  /** Resolutions offered (up to 4K), each with its best frame rate. */
  qualities: { height: number; fps: number | null }[];
  heights: number[];
  fps: number | null;
  hasVideo: boolean;
}

/** One song found in a music link (YouTube songs carry a URL, Spotify ones a search). */
export interface MusicItem {
  title: string;
  duration: number;
  url?: string;
  query?: string;
}

export interface ApiJob {
  id: string;
  kind: 'download' | 'trim' | 'convert';
  name: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  stage: string;
  progress: number;
  downloaded: number;
  total: number;
  speed: number;
  eta: number | null;
  error: string | null;
  code: string | null;
  file: RemoteFile | null;
}

export interface FetchOptions {
  url: string;
  mode: 'video' | 'audio';
  quality: string;
  /** 30 or 60; only sent when the resolution offers 60 fps. */
  fps?: number;
  audioFormat: string;
  container: string;
  name: string;
}

export interface TrimOptions {
  start: number;
  end: number;
  copy: boolean;
  aspect: 'original' | '9:16' | '1:1' | '21:9';
  volume: number;
  mute: boolean;
  name: string;
}

export interface ConvertOptions {
  group: string;
  format: string;
  codec: string | null;
  preset: string;
  quality: string;
  audioKbps: number;
  gifFps: number;
  name: string;
}

/** Server error with a stable `code` the UI translates (see i18n `err.*`). */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const offline = () => new ApiError('offline', 'No connection to the server');

@Injectable({ providedIn: 'root' })
export class Api {
  private readonly base = '/api';

  /** Current session (creates a guest one if needed). */
  me(): Promise<Me> {
    return this.request('GET', '/me');
  }
  /** Account summary plus the library files. */
  library(): Promise<Me & { files: RemoteFile[] }> {
    return this.request('GET', '/library');
  }
  /** Creates an account from the current session. */
  register(username: string, password: string): Promise<Me> {
    return this.request('POST', '/auth/register', { username, password });
  }
  /** Signs in and merges the guest files. */
  login(username: string, password: string): Promise<Me> {
    return this.request('POST', '/auth/login', { username, password });
  }
  /** Signs out and returns a fresh guest session. */
  logout(): Promise<Me> {
    return this.request('POST', '/auth/logout');
  }
  /** Deletes the account (or guest) with all its files and returns a fresh guest session. */
  deleteAccount(): Promise<Me> {
    return this.request('DELETE', '/me');
  }
  /** Uploads a profile photo (PNG/JPG/WebP/GIF, 2 MB max). */
  async setAvatar(image: File): Promise<Me> {
    return this.handle(
      await fetch(`${this.base}/me/avatar`, { method: 'PUT', headers: { 'Content-Type': image.type }, body: image }).catch(() => {
        throw offline();
      }),
    );
  }
  /** Deletes the profile photo. */
  removeAvatar(): Promise<Me> {
    return this.request('DELETE', '/me/avatar');
  }
  /** Reads title, qualities and thumbnail of a link. */
  info(url: string): Promise<VideoInfo> {
    return this.request('POST', '/info', { url });
  }
  /** Starts a download job. */
  fetch(options: FetchOptions): Promise<ApiJob> {
    return this.request('POST', '/fetch', options);
  }
  /** Starts a trim job. */
  trim(fileId: string, options: TrimOptions): Promise<ApiJob> {
    return this.request('POST', `/files/${fileId}/trim`, options);
  }
  /** Starts a conversion job. */
  convert(fileId: string, options: ConvertOptions): Promise<ApiJob> {
    return this.request('POST', `/files/${fileId}/convert`, options);
  }
  /** Reads the state of a job. */
  job(id: string): Promise<ApiJob> {
    return this.request('GET', `/jobs/${id}`);
  }
  /** Cancels a running job. */
  cancel(id: string): Promise<ApiJob> {
    return this.request('DELETE', `/jobs/${id}`);
  }
  /** Renames a stored file. */
  rename(id: string, name: string): Promise<RemoteFile> {
    return this.request('PATCH', `/files/${id}`, { name });
  }
  /** Deletes a file from the server disk. */
  remove(id: string): Promise<unknown> {
    return this.request('DELETE', `/files/${id}`);
  }

  /** Uploads a local file with progress (fetch can't report upload progress). */
  upload(file: File, onProgress?: (ratio: number) => void): Promise<RemoteFile> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${this.base}/upload`);
      xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onerror = () => reject(offline());
      xhr.onload = () => {
        let data: { detail?: string; code?: string } | null = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* not JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as unknown as RemoteFile);
        else reject(data?.code ? new ApiError(data.code, data.detail ?? '') : offline());
      };
      xhr.send(file);
    });
  }

  /** Real server status: it answers and FFmpeg and yt-dlp are installed. */
  health(): Promise<{ ok: boolean; tools: { ffmpeg: boolean; ytdlp: boolean; office: boolean } }> {
    return this.request('GET', '/health');
  }

  /** Songs inside a YouTube or Spotify link (a song, playlist or album). */
  musicResolve(url: string): Promise<{ title: string; items: MusicItem[] }> {
    return this.request('POST', '/music/resolve', { url });
  }

  /** Audio of one song from a link; the server doesn't keep it. */
  async musicAudio(item: MusicItem, signal?: AbortSignal): Promise<Blob> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/music/audio`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url, query: item.query }),
        signal,
      });
    } catch {
      throw offline();
    }
    if (!res.ok) return this.handle(res);
    return res.blob();
  }

  /** Triggers a browser download of a server file with the given name. */
  save(file: Pick<RemoteFile, 'id' | 'ext'>, name: string): void {
    const a = document.createElement('a');
    a.href = `${this.base}/files/${file.id}?download=1&name=${encodeURIComponent(name)}`;
    a.download = `${name}.${file.ext}`;
    document.body.append(a);
    a.click();
    a.remove();
  }

  /** JSON request helper; network failures become an `offline` error. */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw offline();
    }
    return this.handle(res);
  }

  /** Parses a response, turning error statuses into ApiError. */
  private async handle<T>(res: Response): Promise<T> {
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // A proxy error page (server down in dev) has no JSON body.
      if (!data?.code) throw res.status >= 500 ? offline() : new ApiError('generic', res.statusText);
      throw new ApiError(data.code, data.detail ?? '');
    }
    return data as T;
  }
}
