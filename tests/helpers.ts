import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { createHarfBuzzShaper } from '@/lib/pdf/shaping';
import type { FontLoader } from '@/lib/pdf/fonts';
import { encodePNG } from '@/lib/pdf/images';

export function testPng(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return encodePNG({ width: w, height: h, data });
}

const ROOT = path.resolve(__dirname, '..');

/** Font loader reading bundled fonts straight from node_modules (same files postinstall copies to /public/fonts). */
export const nodeFontLoader: FontLoader = async (file) => {
  const local = path.join(ROOT, 'public/fonts', file);
  if (fs.existsSync(local)) return new Uint8Array(fs.readFileSync(local));
  const m = /^([A-Za-z]+?)_(\d{3}\w+?)(?:_Italic)?\.ttf$/.exec(file);
  const dirs = fs.readdirSync(path.join(ROOT, 'node_modules/@expo-google-fonts'));
  for (const d of dirs) {
    const pkgDir = path.join(ROOT, 'node_modules/@expo-google-fonts', d);
    for (const sub of fs.readdirSync(pkgDir)) {
      const cand = path.join(pkgDir, sub, file);
      if (fs.existsSync(cand)) return new Uint8Array(fs.readFileSync(cand));
    }
  }
  throw new Error(`Font not found: ${file} ${m ? '' : ''}`);
};

export async function nodeSubsetter() {
  const { createHarfBuzzSubsetter } = await import('@/lib/pdf/subset');
  return createHarfBuzzSubsetter(new Uint8Array(fs.readFileSync(path.join(ROOT, 'node_modules/harfbuzzjs/hb-subset.wasm'))));
}

export async function nodeShaper() {
  return createHarfBuzzShaper(new Uint8Array(fs.readFileSync(path.join(ROOT, 'node_modules/harfbuzzjs/hb.wasm'))));
}

/** Text extraction with pdf.js (independent reader) */
export async function pdfjsText(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join(''));
  }
  await doc.destroy();
  return pages;
}

export async function pdfjsItems(bytes: Uint8Array, pageNo = 1) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, verbosity: 0 }).promise;
  const page = await doc.getPage(pageNo);
  const tc = await page.getTextContent();
  const items = tc.items.filter((it) => 'str' in it).map((it) => {
    const t = it as { str: string; transform: number[]; width: number };
    return { str: t.str, x: t.transform[4], y: t.transform[5], width: t.width };
  });
  await doc.destroy();
  return items;
}

/** A simple fixture: Helvetica (non-embedded, WinAnsi) + embedded subset TrueType + image + vector shapes. */
export async function makeFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle('Fixture');
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const arimo = await doc.embedFont(await nodeFontLoader('Arimo_400Regular.ttf'), { subset: true });
  page.drawText('Hello World from Helvetica', { x: 72, y: 700, size: 18, font: helv, color: rgb(0, 0, 0) });
  page.drawText('Invoice total: 100 USD', { x: 72, y: 660, size: 14, font: helv, color: rgb(0.2, 0.2, 0.8) });
  page.drawText('Embedded subset font line', { x: 72, y: 620, size: 12, font: arimo });
  page.drawText('Second paragraph line one', { x: 72, y: 560, size: 12, font: helv });
  page.drawText('Second paragraph line two', { x: 72, y: 545, size: 12, font: helv });
  page.drawRectangle({ x: 300, y: 300, width: 100, height: 50, color: rgb(1, 0, 0) });
  page.drawLine({ start: { x: 72, y: 500 }, end: { x: 300, y: 500 }, thickness: 2, color: rgb(0, 0.5, 0) });
  // 2x2 RGB PNG
  const png = testPng(2, 2, [255, 0, 0]);
  const img = await doc.embedPng(png);
  page.drawImage(img, { x: 400, y: 600, width: 100, height: 100 });
  const p2 = doc.addPage([612, 792]);
  p2.drawText('Page two text', { x: 72, y: 700, size: 16, font: helv });
  return doc.save({ useObjectStreams: false });
}
