/**
 * OCR: recognition with tesseract.js (browser; runs in tesseract's own Web
 * Worker) and helpers to turn results into an editable/searchable text layer.
 */
import type { OcrPageResult, OcrWord } from './types';
import type { RGBAImage } from './images';

type TesseractWorker = {
  recognize(img: unknown): Promise<{ data: { words?: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[]; blocks?: unknown[] } }>;
  terminate(): Promise<void>;
};

const workers = new Map<string, Promise<TesseractWorker>>();

async function getWorker(lang: string): Promise<TesseractWorker> {
  let w = workers.get(lang);
  if (!w) {
    w = (async () => {
      const T = await import('tesseract.js');
      const langPath = process.env.NEXT_PUBLIC_TESSDATA_URL || undefined;
      // Worker and wasm core are self-hosted (see scripts/copy-assets.mjs); language data is fetched on demand.
      return (await T.createWorker(lang, 1, { workerPath: '/tesseract/worker.min.js', corePath: '/tesseract', ...(langPath ? { langPath } : {}) })) as unknown as TesseractWorker;
    })();
    workers.set(lang, w);
  }
  return w;
}

/** Recognize words on a rendered page image (canvas, ImageData, Blob or URL). */
export async function recognizePage(image: HTMLCanvasElement | OffscreenCanvas | Blob | string, width: number, height: number, lang = 'eng'): Promise<OcrPageResult> {
  const worker = await getWorker(lang);
  const { data } = await worker.recognize(image);
  const words: OcrWord[] = [];
  const collect = (list: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[]) => {
    for (const w of list) if (w.text.trim() && w.confidence > 30) words.push({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, confidence: w.confidence });
  };
  if (data.words?.length) collect(data.words);
  else if (Array.isArray(data.blocks)) {
    // tesseract.js v6 output layout
    for (const b of data.blocks as { paragraphs: { lines: { words: never[] }[] }[] }[])
      for (const p of b.paragraphs) for (const l of p.lines) collect(l.words);
  }
  return { words, imageWidth: width, imageHeight: height };
}

export async function terminateOcr() {
  for (const w of workers.values()) (await w).terminate();
  workers.clear();
}

/** Median colour of a 3px ring around a pixel region - used to erase scanned words. */
export function estimateBackground(img: RGBAImage, r: { x0: number; y0: number; x1: number; y1: number }): [number, number, number] {
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const take = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const o = (y * img.width + x) * 4;
    rs.push(img.data[o]);
    gs.push(img.data[o + 1]);
    bs.push(img.data[o + 2]);
  };
  for (let d = 1; d <= 3; d++) {
    for (let x = r.x0 - d; x <= r.x1 + d; x += 2) {
      take(x, r.y0 - d);
      take(x, r.y1 + d);
    }
    for (let y = r.y0 - d; y <= r.y1 + d; y += 2) {
      take(r.x0 - d, y);
      take(r.x1 + d, y);
    }
  }
  const med = (a: number[]) => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : 255);
  return [med(rs), med(gs), med(bs)];
}
