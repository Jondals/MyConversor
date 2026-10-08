// Conversion catalog for the converter: every output format with its label and
// options, the kind of each input file and which outputs it can become (the
// server enforces the same table, see server/catalog.mjs).
import type { MediaKind } from './api';
import type { IconName } from './icon';

/** Output groups, shown as tabs. */
export type Group = 'video' | 'animation' | 'audio' | 'image' | 'document';
export const GROUPS: { id: Group; icon: IconName }[] = [
  { id: 'video', icon: 'film' },
  { id: 'animation', icon: 'zap' },
  { id: 'audio', icon: 'music' },
  { id: 'image', icon: 'image' },
  { id: 'document', icon: 'file' },
];

export interface Target {
  id: string;
  label: string;
  /** File extension of the result. */
  ext: string;
  /** Video codecs the container accepts (first = default). */
  codecs?: string[];
  recommended?: boolean;
  lossless?: boolean;
}

export const TARGETS: Record<Group, Target[]> = {
  video: [
    { id: 'mp4', label: 'MP4', ext: 'mp4', codecs: ['h264', 'h265'], recommended: true },
    { id: 'webm', label: 'WebM', ext: 'webm', codecs: ['vp9', 'av1'] },
    { id: 'mkv', label: 'MKV', ext: 'mkv', codecs: ['h264', 'h265', 'av1', 'vp9'] },
    { id: 'mov', label: 'MOV', ext: 'mov', codecs: ['prores', 'h264'] },
    { id: 'avi', label: 'AVI', ext: 'avi', codecs: ['xvid'] },
    { id: 'm4v', label: 'M4V', ext: 'm4v', codecs: ['h264'] },
    { id: 'flv', label: 'FLV', ext: 'flv', codecs: ['flv'] },
    { id: 'mpeg', label: 'MPEG', ext: 'mpg', codecs: ['mpeg2'] },
    { id: 'ogv', label: 'OGV', ext: 'ogv', codecs: ['theora'] },
  ],
  animation: [
    { id: 'gif', label: 'GIF', ext: 'gif', recommended: true },
    { id: 'webp', label: 'WebP', ext: 'webp' },
    { id: 'apng', label: 'APNG', ext: 'png' },
  ],
  audio: [
    { id: 'mp3', label: 'MP3', ext: 'mp3', recommended: true },
    { id: 'aac', label: 'AAC', ext: 'm4a' },
    { id: 'ogg', label: 'OGG', ext: 'ogg' },
    { id: 'opus', label: 'Opus', ext: 'opus' },
    { id: 'wma', label: 'WMA', ext: 'wma' },
    { id: 'ac3', label: 'AC3', ext: 'ac3' },
    { id: 'wav', label: 'WAV', ext: 'wav', lossless: true },
    { id: 'flac', label: 'FLAC', ext: 'flac', lossless: true },
    { id: 'alac', label: 'ALAC', ext: 'm4a', lossless: true },
    { id: 'aiff', label: 'AIFF', ext: 'aiff', lossless: true },
  ],
  image: [
    { id: 'png', label: 'PNG', ext: 'png', recommended: true, lossless: true },
    { id: 'jpg', label: 'JPG', ext: 'jpg' },
    { id: 'webp', label: 'WebP', ext: 'webp' },
    { id: 'avif', label: 'AVIF', ext: 'avif' },
    { id: 'bmp', label: 'BMP', ext: 'bmp', lossless: true },
    { id: 'tiff', label: 'TIFF', ext: 'tiff', lossless: true },
    { id: 'ico', label: 'ICO', ext: 'ico', lossless: true },
    { id: 'gif', label: 'GIF', ext: 'gif', lossless: true },
  ],
  document: [
    { id: 'pdf', label: 'PDF', ext: 'pdf', recommended: true },
    { id: 'docx', label: 'DOCX', ext: 'docx' },
    { id: 'odt', label: 'ODT', ext: 'odt' },
    { id: 'rtf', label: 'RTF', ext: 'rtf' },
    { id: 'txt', label: 'TXT', ext: 'txt' },
    { id: 'html', label: 'HTML', ext: 'html' },
    { id: 'epub', label: 'EPUB', ext: 'epub' },
    { id: 'xlsx', label: 'XLSX', ext: 'xlsx' },
    { id: 'ods', label: 'ODS', ext: 'ods' },
    { id: 'csv', label: 'CSV', ext: 'csv' },
    { id: 'pptx', label: 'PPTX', ext: 'pptx' },
    { id: 'odp', label: 'ODP', ext: 'odp' },
  ],
};

const AUDIO_EXTS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'ac3', 'aiff', 'alac'];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'ico', 'svg'];
type DocType = 'text' | 'sheet' | 'slides' | 'pdf';
const DOC_TYPES: Record<DocType, string[]> = {
  text: ['doc', 'docx', 'odt', 'rtf', 'txt', 'html', 'htm'],
  sheet: ['xls', 'xlsx', 'ods', 'csv'],
  slides: ['ppt', 'pptx', 'odp'],
  pdf: ['pdf'],
};
const FRAMES = ['png', 'jpg', 'webp', 'avif', 'bmp', 'tiff'];
const DOC_TARGETS: Record<DocType, Partial<Record<Group, string[]>>> = {
  text: { document: ['pdf', 'docx', 'odt', 'rtf', 'txt', 'html', 'epub'], image: ['png', 'jpg'] },
  sheet: { document: ['xlsx', 'ods', 'csv', 'pdf', 'html'] },
  slides: { document: ['pptx', 'odp', 'pdf'], image: ['png', 'jpg'] },
  pdf: { document: ['docx', 'odt', 'pptx', 'odp', 'txt', 'html'], image: ['png', 'jpg'] },
};

/** Everything the upload field accepts. */
export const ACCEPT = [
  'video/*',
  'audio/*',
  'image/*',
  ...[...IMAGE_EXTS, 'gif', ...Object.values(DOC_TYPES).flat()].map((e) => `.${e}`),
].join(',');

const docType = (ext: string): DocType | null =>
  (Object.keys(DOC_TYPES) as DocType[]).find((t) => DOC_TYPES[t].includes(ext)) ?? null;
const canonical = (ext: string) => ({ jpeg: 'jpg', tif: 'tiff', htm: 'html' })[ext] ?? ext;

/** Kind of file from its extension (same rules as the server). */
export function kindOfExt(ext: string): MediaKind {
  if (ext === 'gif') return 'gif';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  if (docType(ext)) return 'document';
  return 'video';
}

/** Output format ids per group for a file extension; every group when there is no file yet. */
export function targetsFor(ext: string | null): Partial<Record<Group, string[]>> {
  const all = (g: Group) => TARGETS[g].map((t) => t.id);
  if (ext === null) return Object.fromEntries(GROUPS.map((g) => [g.id, all(g.id)]));
  const own = canonical(ext);
  let groups: Partial<Record<Group, string[]>>;
  switch (kindOfExt(ext)) {
    case 'audio':
      groups = { audio: all('audio') };
      break;
    case 'image':
      groups = { image: all('image'), document: ['pdf'] };
      break;
    case 'gif':
      groups = { video: all('video'), animation: all('animation'), image: FRAMES };
      break;
    case 'document':
      groups = DOC_TARGETS[docType(ext)!];
      break;
    default:
      groups = { video: all('video'), animation: all('animation'), audio: all('audio'), image: FRAMES };
  }
  for (const g of ['image', 'document'] as const) groups[g] = groups[g]?.filter((f) => f !== own);
  return groups;
}

/** Whether a conversion runs in LibreOffice on the server. */
export const needsOffice = (ext: string, group: Group) => group === 'document' || kindOfExt(ext) === 'document';
