// Copies runtime assets (fonts, wasm, workers) from node_modules into /public.
// Runs automatically on `npm install` (postinstall).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const pub = (...p) => path.join(root, 'public', ...p);

function copy(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`[copy-assets] missing ${path.relative(root, src)}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// Fonts: regular/bold/italic faces of the bundled families.
const fontPkgs = ['arimo', 'tinos', 'cousine', 'noto-sans-bengali', 'noto-naskh-arabic', 'noto-sans-devanagari', 'noto-sans-hebrew'];
const wanted = /_(400Regular|700Bold)(_Italic)?\.ttf$/;
for (const pkg of fontPkgs) {
  const dir = nm('@expo-google-fonts', pkg);
  if (!fs.existsSync(dir)) continue;
  for (const sub of fs.readdirSync(dir)) {
    const subDir = path.join(dir, sub);
    if (!fs.statSync(subDir).isDirectory()) continue;
    for (const f of fs.readdirSync(subDir)) if (wanted.test(f)) copy(path.join(subDir, f), pub('fonts', f));
  }
}

// WebAssembly
copy(nm('harfbuzzjs', 'hb.wasm'), pub('wasm', 'hb.wasm'));
copy(nm('harfbuzzjs', 'hb-subset.wasm'), pub('wasm', 'hb-subset.wasm'));
copy(nm('mupdf', 'dist', 'mupdf-wasm.wasm'), pub('wasm', 'mupdf-wasm.wasm'));

// pdf.js worker
copy(nm('pdfjs-dist', 'build', 'pdf.worker.min.mjs'), pub('pdf.worker.min.mjs'));
// pdf.js standard font data and cMaps (for non-embedded fonts / CJK)
for (const d of ['standard_fonts', 'cmaps']) {
  const src = nm('pdfjs-dist', d);
  if (!fs.existsSync(src)) continue;
  for (const f of fs.readdirSync(src)) copy(path.join(src, f), pub('pdfjs', d, f));
}

// tesseract.js worker + core (language data is downloaded on demand)
copy(nm('tesseract.js', 'dist', 'worker.min.js'), pub('tesseract', 'worker.min.js'));
for (const f of ['tesseract-core.wasm.js', 'tesseract-core-simd.wasm.js', 'tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js']) {
  copy(nm('tesseract.js-core', f), pub('tesseract', f));
}
console.log('[copy-assets] done');
