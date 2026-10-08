// SVG support: FFmpeg has no SVG decoder, so vector images are drawn to a PNG
// first and that PNG goes through the normal image pipeline.
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { AppError } from './errors.mjs';

/** Small vector files are drawn at least this wide so the result is not tiny. */
const MIN_WIDTH = 1024;
/** Upper bound so a huge `viewBox` cannot exhaust memory. */
const MAX_WIDTH = 8192;

/** Draws an SVG file to a PNG file; returns the pixel size. */
export function rasterizeSvg(src, out) {
  let resvg;
  try {
    resvg = new Resvg(readFileSync(src), { font: { loadSystemFonts: true }, background: 'rgba(0,0,0,0)' });
  } catch {
    throw new AppError(415, 'bad_svg', 'The SVG file is not valid');
  }
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(resvg.width)));
  const image = new Resvg(readFileSync(src), {
    font: { loadSystemFonts: true },
    fitTo: { mode: 'width', value: width },
  }).render();
  writeFileSync(out, image.asPng());
  return { width: image.width, height: image.height };
}
