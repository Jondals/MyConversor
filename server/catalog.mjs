// Conversion catalog: what kind of file an extension is and which outputs each
// kind can become. The converter UI keeps the same table (src/app/core/formats.ts)
// so it can show only the possible outputs; the server enforces it.
import { AUDIO_FORMATS, FORMAT_CODECS, IMAGE_FORMATS } from './media.mjs';

export const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'ac3', 'aiff', 'alac']);
/** Still images (FFmpeg reads them; WebP is treated as still because FFmpeg can't decode animated WebP). */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'ico']);
/** Animated images handled like short silent videos. */
export const ANIMATED_EXTS = new Set(['gif']);
/** Documents (converted with LibreOffice), by family. */
export const DOC_TYPES = {
  text: ['doc', 'docx', 'odt', 'rtf', 'txt', 'html', 'htm'],
  sheet: ['xls', 'xlsx', 'ods', 'csv'],
  slides: ['ppt', 'pptx', 'odp'],
  pdf: ['pdf'],
};

/** Output groups shown as tabs in the converter. */
export const GROUPS = ['video', 'animation', 'audio', 'image', 'document'];

/** Still image outputs (FFmpeg). */
export const IMAGE_TARGETS = ['png', 'jpg', 'webp', 'avif', 'bmp', 'tiff', 'ico', 'gif'];
/** Still frames a video can be exported to. */
const FRAME_TARGETS = ['png', 'jpg', 'webp', 'avif', 'bmp', 'tiff'];
/** Document outputs (LibreOffice) per input family; `image` holds page/slide snapshots. */
const DOC_TARGETS = {
  text: { document: ['pdf', 'docx', 'odt', 'rtf', 'txt', 'html', 'epub'], image: ['png', 'jpg'] },
  sheet: { document: ['xlsx', 'ods', 'csv', 'pdf', 'html'] },
  slides: { document: ['pptx', 'odp', 'pdf'], image: ['png', 'jpg'] },
  pdf: { document: ['docx', 'odt', 'pptx', 'odp', 'txt', 'html'], image: ['png', 'jpg'] },
};

/** Canonical spelling of an extension (jpeg → jpg, tif → tiff, htm → html). */
export const canonical = (ext) => ({ jpeg: 'jpg', tif: 'tiff', htm: 'html' })[ext] ?? ext;

/** Document family of an extension, or null. */
export function docType(ext) {
  return Object.keys(DOC_TYPES).find((type) => DOC_TYPES[type].includes(ext)) ?? null;
}

/** Kind of file from its extension: video, audio, gif (animated), image or document. */
export function kindOf(ext) {
  if (ANIMATED_EXTS.has(ext)) return 'gif';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (docType(ext)) return 'document';
  return 'video';
}

/**
 * Every output a file with this extension can become, by group. Its own format
 * is left out of the image and document groups (re-encoding media to the same
 * format still makes sense: smaller size, another codec, another resolution).
 */
export function targetsFor(ext) {
  const own = canonical(ext);
  const media = {
    video: Object.keys(FORMAT_CODECS),
    animation: IMAGE_FORMATS,
    audio: Object.keys(AUDIO_FORMATS),
  };
  let groups;
  switch (kindOf(ext)) {
    case 'audio':
      groups = { audio: media.audio };
      break;
    case 'image':
      groups = { image: IMAGE_TARGETS, document: ['pdf'] };
      break;
    case 'gif':
      groups = { video: media.video, animation: media.animation, image: FRAME_TARGETS };
      break;
    case 'document':
      groups = DOC_TARGETS[docType(ext)];
      break;
    default:
      groups = { ...media, image: FRAME_TARGETS };
  }
  return Object.fromEntries(
    Object.entries(groups).map(([g, list]) => [g, ['image', 'document'].includes(g) ? list.filter((f) => f !== own) : list]),
  );
}

/** Whether a conversion needs LibreOffice (any document output, or a document input). */
export const needsOffice = (ext, group) => group === 'document' || kindOf(ext) === 'document';
