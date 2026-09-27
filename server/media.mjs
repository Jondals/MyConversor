// FFmpeg helpers: reads media info, runs FFmpeg with progress and cancellation,
// makes thumbnails and builds the arguments for trimming and converting.
import { spawn } from 'node:child_process';
import { AppError } from './errors.mjs';

/** Reads duration/size from `ffmpeg -i` stderr (no ffprobe needed). */
export function probe(ffmpeg, path) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, ['-hide_banner', '-i', path]);
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', () => resolve(emptyInfo()));
    proc.on('close', () => resolve(parseProbe(err)));
  });
}

/** Media info for files FFmpeg cannot read. */
const emptyInfo = () => ({ duration: 0, width: 0, height: 0, hasVideo: false, hasAudio: false });

/** Parses the stream summary FFmpeg prints for an input file. */
export function parseProbe(text) {
  const info = emptyInfo();
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (d) info.duration = +d[1] * 3600 + +d[2] * 60 + +d[3];
  for (const line of text.split('\n')) {
    if (!line.includes('Stream #')) continue;
    if (line.includes(' Video: ') && !line.includes('attached pic')) {
      info.hasVideo = true;
      const m = /, (\d{2,5})x(\d{2,5})/.exec(line);
      if (m && !info.width) [info.width, info.height] = [+m[1], +m[2]];
    } else if (line.includes(' Audio: ')) {
      info.hasAudio = true;
    }
  }
  return info;
}

/** Runs FFmpeg reporting progress (0..1) and honouring an AbortSignal. */
export function run(ffmpeg, args, out, { duration = 0, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const cmd = ['-hide_banner', '-nostdin', '-y', ...args, '-progress', 'pipe:1', '-nostats', out];
    const proc = spawn(ffmpeg, cmd);
    const abort = () => proc.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    let err = '';
    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith('out_time_us=') && duration > 0 && onProgress) {
          const us = Number(line.slice(12));
          if (Number.isFinite(us)) onProgress(Math.min(1, us / 1e6 / duration));
        }
      }
    });
    proc.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    proc.on('error', reject);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(new AppError(499, 'cancelled', 'Cancelled'));
      if (code !== 0) {
        const tail = err.trim().split('\n').slice(-3).join(' ');
        return reject(new AppError(500, 'ffmpeg_failed', `FFmpeg failed: ${tail}`));
      }
      resolve(out);
    });
  });
}

/** Saves a JPEG frame from ~10% into the video. */
export async function thumbnail(ffmpeg, src, out, duration) {
  const at = duration > 2 ? Math.min(duration * 0.1, 30) : 0;
  await run(
    ffmpeg,
    ['-ss', at.toFixed(2), '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5'],
    out,
  );
}

/**
 * Builds the trimmer's timeline strip: `count` evenly spaced frames side by
 * side in one JPEG. Each frame uses a fast input seek, so even hour-long
 * videos take about a second.
 */
export async function strip(ffmpeg, src, out, duration, count = 12) {
  const inputs = [];
  const chains = [];
  for (let i = 0; i < count; i++) {
    inputs.push('-ss', (((i + 0.5) * duration) / count).toFixed(2), '-i', src);
    chains.push(`[${i}:v:0]scale=160:90:force_original_aspect_ratio=increase,crop=160:90,setsar=1[f${i}]`);
  }
  const stack = `${chains.map((_, i) => `[f${i}]`).join('')}hstack=inputs=${count}`;
  await run(ffmpeg, [...inputs, '-filter_complex', `${chains.join(';')};${stack}`, '-frames:v', '1', '-q:v', '6'], out);
}

// -------------------------------------------------------------------- trim

export const ASPECT_SIZE = { '9:16': [1080, 1920], '1:1': [1080, 1080], '21:9': [2560, 1080] };

/** Scales to cover the box and crops the centre ("smart crop"). */
export const cover = (w, h) =>
  `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;

const AUDIO_FOR_EXT = {
  mp3: ['-c:a', 'libmp3lame', '-b:a', '320k'],
  flac: ['-c:a', 'flac'],
  wav: ['-c:a', 'pcm_s16le'],
  webm: ['-c:a', 'libopus', '-b:a', '192k'],
  ogg: ['-c:a', 'libopus', '-b:a', '192k'],
  opus: ['-c:a', 'libopus', '-b:a', '192k'],
};
/** Audio encoder arguments that fit a container extension. */
const audioCodec = (ext) => AUDIO_FOR_EXT[ext] ?? ['-c:a', 'aac', '-b:a', '192k'];

/**
 * @param {{start:number,end:number,copy:boolean,aspect:string,volume:number,mute:boolean}} o
 * @returns {{args:string[], ext:string}}
 */
export function trimArgs(src, srcExt, o, info) {
  const args = ['-ss', o.start.toFixed(3), '-to', o.end.toFixed(3), '-i', src];
  const reframe = o.aspect !== 'original' && info.hasVideo;
  const volume = Math.max(0, Math.min(2, o.volume ?? 1));
  const mute = o.mute || volume === 0;
  const audioChanged = mute || Math.abs(volume - 1) > 0.001;
  const audio = mute ? ['-an'] : audioChanged ? ['-af', `volume=${volume.toFixed(2)}`] : [];

  if (!info.hasVideo) {
    if (mute) throw new AppError(400, 'cannot_mute_audio', 'An audio-only file cannot be muted');
    const copy = o.copy && !audioChanged;
    const ext = AUDIO_FOR_EXT[srcExt] || ['m4a', 'aac'].includes(srcExt) ? srcExt : 'm4a';
    return {
      args: [...args, '-vn', ...audio, ...(copy ? ['-c:a', 'copy'] : audioCodec(ext))],
      ext,
    };
  }

  if (o.copy && !reframe) {
    const map = ['-map', '0:v:0', '-map', '0:a:0?'];
    const a = audioChanged ? [...audio, ...(mute ? [] : audioCodec(srcExt))] : ['-c:a', 'copy'];
    return {
      args: [...args, ...map, '-c:v', 'copy', ...a, '-avoid_negative_ts', 'make_zero'],
      ext: srcExt,
    };
  }

  const vf = reframe ? ['-vf', cover(...ASPECT_SIZE[o.aspect])] : [];
  return {
    args: [
      ...args,
      ...vf,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      ...audio,
      ...(mute ? [] : ['-c:a', 'aac', '-b:a', '192k']),
      '-movflags',
      '+faststart',
    ],
    ext: 'mp4',
  };
}

// ----------------------------------------------------------------- convert

const VIDEO_CODECS = {
  h264: ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'],
  h265: [
    '-c:v',
    'libx265',
    '-preset',
    'fast',
    '-pix_fmt',
    'yuv420p',
    '-x265-params',
    'log-level=error',
  ],
  vp9: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4'],
  av1: ['-c:v', 'libaom-av1', '-b:v', '0', '-row-mt', '1', '-cpu-used', '8'],
  prores: ['-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le'],
  xvid: ['-c:v', 'libxvid', '-pix_fmt', 'yuv420p'],
  flv: ['-c:v', 'flv', '-pix_fmt', 'yuv420p'],
  mpeg2: ['-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p'],
  theora: ['-c:v', 'libtheora', '-pix_fmt', 'yuv420p'],
};
/** Quality → bitrate (kbps per 1080p) for codecs without CRF. */
const BITRATE = { xvid: [9000, 5000, 2500], flv: [6000, 3500, 1800], mpeg2: [12000, 7000, 3500], theora: [8000, 4500, 2200] };
const CRF = { h264: [18, 23, 28], h265: [22, 27, 32], vp9: [24, 31, 38], av1: [26, 34, 42] };
const QUALITY = { high: 0, balanced: 1, light: 2 };
/** Video containers and the codecs each one accepts (first = default). */
export const FORMAT_CODECS = {
  mp4: ['h264', 'h265'],
  webm: ['vp9', 'av1'],
  mkv: ['h264', 'h265', 'av1', 'vp9'],
  mov: ['prores', 'h264'],
  avi: ['xvid'],
  m4v: ['h264'],
  flv: ['flv'],
  mpeg: ['mpeg2'],
  ogv: ['theora'],
};
/** Audio formats: FFmpeg codec arguments, file extension and whether it is lossless. */
const AUDIO_FORMATS = {
  mp3: [['-c:a', 'libmp3lame'], 'mp3', false],
  aac: [['-c:a', 'aac'], 'm4a', false],
  ogg: [['-c:a', 'libvorbis'], 'ogg', false],
  opus: [['-c:a', 'libopus'], 'opus', false],
  wma: [['-c:a', 'wmav2'], 'wma', false],
  ac3: [['-c:a', 'ac3'], 'ac3', false],
  wav: [['-c:a', 'pcm_s16le'], 'wav', true],
  flac: [['-c:a', 'flac'], 'flac', true],
  alac: [['-c:a', 'alac'], 'm4a', true],
  aiff: [['-c:a', 'pcm_s16be'], 'aiff', true],
};
/** Animated image formats. */
const IMAGE_FORMATS = ['gif', 'webp', 'apng'];
export const FORMATS = [...Object.keys(FORMAT_CODECS), ...IMAGE_FORMATS, ...Object.keys(AUDIO_FORMATS)];

/** Output presets: `cover` crops to fill the frame, `fit` limits the height. */
export const PRESETS = {
  original: null,
  reels: { cover: [1080, 1920] },
  square: { cover: [1080, 1080] },
  uhd: { fit: 2160 },
  youtube: { fit: 1080 },
  hd: { fit: 720 },
  sd: { fit: 480 },
  discord: { fit: 720, capMb: 24 },
};

/**
 * Builds the FFmpeg arguments for a conversion.
 * @param {{format:string,codec?:string|null,preset:string,quality:string,audioKbps:number,gifFps:number}} o
 * @returns {{args:string[], ext:string}}
 */
export function convertArgs(src, info, o) {
  const base = ['-i', src];
  const kbps = Math.max(64, Math.min(320, o.audioKbps || 192));
  const q = QUALITY[o.quality] ?? 1;

  if (AUDIO_FORMATS[o.format]) {
    if (!info.hasAudio) throw new AppError(400, 'no_audio_track', 'The file has no audio track');
    const [codec, ext, lossless] = AUDIO_FORMATS[o.format];
    const bitrate = lossless ? [] : ['-b:a', `${o.format === 'ac3' ? Math.max(kbps, 192) : kbps}k`];
    return { args: [...base, '-vn', '-map', '0:a:0', ...codec, ...bitrate], ext };
  }
  if (!info.hasVideo) throw new AppError(400, 'no_video_track', 'The file has no video track');

  const preset = PRESETS[o.preset] ?? null;
  const scale = preset?.cover ? cover(...preset.cover) : preset?.fit ? `scale=-2:'min(${preset.fit},ih)'` : null;

  if (IMAGE_FORMATS.includes(o.format)) {
    const fps = Math.max(5, Math.min(30, o.gifFps || 15));
    const width = [640, 480, 360][q];
    const size = `fps=${fps},scale='min(${width},iw)':-2:flags=lanczos`;
    if (o.format === 'gif') {
      const vf = `${size},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=floyd_steinberg`;
      return { args: [...base, '-vf', vf, '-an', '-loop', '0'], ext: 'gif' };
    }
    if (o.format === 'webp') {
      return { args: [...base, '-vf', size, '-an', '-c:v', 'libwebp_anim', '-q:v', String([80, 65, 45][q]), '-loop', '0'], ext: 'webp' };
    }
    return { args: [...base, '-vf', size, '-an', '-c:v', 'apng', '-plays', '0'], ext: 'png' };
  }

  const codecs = FORMAT_CODECS[o.format];
  if (!codecs) throw new AppError(400, 'bad_format', `Unsupported format: ${o.format}`);
  const codec = codecs.includes(o.codec) ? o.codec : codecs[0];
  const args = [...base, ...VIDEO_CODECS[codec]];
  if (scale) args.push('-vf', scale);

  if (preset?.capMb && info.duration > 0 && codec !== 'prores') {
    // Fit the whole file under the cap: total kbit budget minus the audio track.
    const v = Math.max(150, Math.floor((preset.capMb * 8 * 1024) / info.duration) - kbps);
    args.push('-b:v', `${v}k`, '-maxrate', `${v}k`, '-bufsize', `${v * 2}k`);
  } else if (CRF[codec]) {
    args.push('-crf', String(CRF[codec][q]));
  } else if (BITRATE[codec]) {
    const pixels = (info.width || 1920) * (info.height || 1080);
    args.push('-b:v', `${Math.round((BITRATE[codec][q] * pixels) / (1920 * 1080))}k`);
  }
  if (codec === 'h265' && ['mp4', 'mov', 'm4v'].includes(o.format)) args.push('-tag:v', 'hvc1');

  if (!info.hasAudio) args.push('-an');
  else if (o.format === 'webm') args.push('-c:a', 'libopus', '-b:a', `${Math.min(kbps, 256)}k`);
  else if (o.format === 'ogv') args.push('-c:a', 'libvorbis', '-b:a', `${kbps}k`);
  else if (o.format === 'avi' || o.format === 'mpeg') args.push('-c:a', 'libmp3lame', '-b:a', `${kbps}k`);
  else if (codec === 'prores') args.push('-c:a', 'pcm_s16le');
  else args.push('-c:a', 'aac', '-b:a', `${kbps}k`);

  if (['mp4', 'mov', 'm4v'].includes(o.format)) args.push('-movflags', '+faststart');
  return { args, ext: o.format === 'mpeg' ? 'mpg' : o.format };
}
