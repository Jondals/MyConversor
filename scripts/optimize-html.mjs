// Post-build step for the prerendered page.
//
// The HTML already contains the whole interface, so JavaScript is not needed to
// show it. Angular starts (hydrates) on the first sign of user intent — pointer,
// touch, key, scroll, focus, file pick or drag — or after a short idle delay.
// Returning visitors hydrate right away. Clicks made before hydration are
// replayed by `withEventReplay()`.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'dist/myconversor/browser';
const IDLE_MS = 6000;
const events = [
  'pointerdown',
  'pointermove',
  'touchstart',
  'keydown',
  'wheel',
  'scroll',
  'focusin',
  'change',
  'dragenter',
];

/** Inline script that imports the app on the first sign of user intent. */
const loader = (main) =>
  `<script type="module">` +
  `let s=0;const go=()=>{if(!s){s=1;import("/${main}")}};` +
  `for(const e of ${JSON.stringify(events)})addEventListener(e,go,{once:!0,passive:!0,capture:!0});` +
  `try{localStorage.getItem("mc.returning")&&go();localStorage.setItem("mc.returning","1")}catch{}` +
  `const idle=()=>setTimeout(go,${IDLE_MS});document.readyState==="complete"?idle():addEventListener("load",idle)` +
  `</script>`;

const file = join(dir, 'index.html');
const html = readFileSync(file, 'utf8');
const out = html
  .replace(/<link rel="modulepreload"[^>]*>/g, '')
  .replace(/<script src="(main-[\w-]+\.js)" type="module"><\/script>/, (_, main) => loader(main));
if (out === html) throw new Error('optimize-html: main script not found');
writeFileSync(file, out);
console.log(`optimize-html: ${file} updated`);
