/// <reference lib="webworker" />
/**
 * Web Worker hosting the PdfEngine: parsing, content-stream rewriting,
 * font shaping/embedding and saving all happen off the main thread.
 */
import * as Comlink from 'comlink';
import { PdfEngine } from '@/lib/pdf/engine';
import { createHarfBuzzShaper, type Shaper } from '@/lib/pdf/shaping';
import type { MupdfApi } from '@/lib/pdf/security';
import { createHarfBuzzSubsetter, type Subsetter } from '@/lib/pdf/subset';
import type { ImageCodec, RGBAImage } from '@/lib/pdf/images';

const CJK_BASE = process.env.NEXT_PUBLIC_CJK_FONT_BASE ?? 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-sc@0.4.4';

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

const fontCache = new Map<string, Promise<Uint8Array>>();
const fontLoader = (file: string) => {
  let p = fontCache.get(file);
  if (!p) {
    if (file.startsWith('cjk:')) {
      const name = file.slice(4);
      const weight = /_(\w+)\.ttf$/.exec(name)?.[1] ?? '400Regular';
      p = CJK_BASE ? fetchBytes(`${CJK_BASE}/${weight}/${name}`) : Promise.reject(new Error('CJK fonts disabled'));
    } else p = fetchBytes(`/fonts/${file}`);
    p.catch(() => fontCache.delete(file));
    fontCache.set(file, p);
  }
  return p;
};

let mupdfPromise: Promise<MupdfApi> | null = null;
const mupdfLoader = () => {
  mupdfPromise ??= (async () => {
    const wasm = await fetchBytes('/wasm/mupdf-wasm.wasm');
    (globalThis as unknown as Record<string, unknown>)['$libmupdf_wasm_Module'] = { wasmBinary: wasm.buffer };
    return (await import('mupdf')) as unknown as MupdfApi;
  })();
  return mupdfPromise;
};

const codec: ImageCodec = {
  async decode(bytes, mime): Promise<RGBAImage> {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { width: d.width, height: d.height, data: d.data };
  },
  async encodeJpeg(img, quality) {
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await blob.arrayBuffer());
  },
};

let subsetter: Subsetter | null = null;
async function initSubsetter(): Promise<Subsetter | null> {
  try {
    subsetter = await createHarfBuzzSubsetter(await fetchBytes('/wasm/hb-subset.wasm'));
  } catch (e) {
    console.warn('hb-subset unavailable, fonts will be embedded in full', e);
  }
  return subsetter;
}

let shaper: Shaper | null = null;
async function initShaper(): Promise<Shaper | null> {
  if (shaper) return shaper;
  try {
    shaper = await createHarfBuzzShaper(await fetchBytes('/wasm/hb.wasm'));
  } catch (e) {
    console.warn('HarfBuzz unavailable, falling back to fontkit shaping', e);
    shaper = null;
  }
  return shaper;
}

const ready = initShaper();
const subsetReady = initSubsetter();
let engine: PdfEngine | null = null;

async function getEngine(): Promise<PdfEngine> {
  if (!engine) {
    engine = new PdfEngine({ fontLoader, shaper: await ready, subsetter: await subsetReady, mupdf: mupdfLoader, codec });
  }
  return engine;
}

/**
 * Generic RPC: call any public PdfEngine method by name. Keeps the worker
 * surface in sync with the engine without hand-written wrappers.
 */
const api = {
  async call(method: string, args: unknown[]): Promise<unknown> {
    const e = await getEngine();
    const fn = (e as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function') throw new Error(`Unknown engine method ${method}`);
    // Results are structured-cloned (not transferred): they may alias engine-owned buffers.
    return (fn as (...a: unknown[]) => unknown).apply(e, args);
  },
  async reset() {
    engine = null;
  },
};

export type EngineWorkerApi = typeof api;
Comlink.expose(api);
