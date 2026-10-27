'use client';
/**
 * pdf.js integration: loads the "base" document once per base version and
 * single-page preview documents for edited pages, and renders pages to canvas.
 * Rendering happens in pdf.js's own worker.
 */
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { RenderSource } from '@/lib/pdf/types';

type PdfJs = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist').then((m) => {
    m.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    return m;
  });
  return pdfjsPromise;
}

const baseDocs = new Map<number, Promise<PDFDocumentProxy>>();
const previewDocs = new Map<Uint8Array, Promise<PDFDocumentProxy>>();

async function openDoc(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfJs();
  return pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
}

export function setBaseDocument(version: number, bytes: Uint8Array) {
  if (baseDocs.has(version)) return;
  for (const [v, p] of baseDocs) {
    if (v !== version) {
      p.then((d) => d.destroy()).catch(() => undefined);
      baseDocs.delete(v);
    }
  }
  baseDocs.set(version, openDoc(bytes));
}

export async function getPdfPage(src: RenderSource): Promise<PDFPageProxy> {
  if (src.kind === 'base') {
    const d = baseDocs.get(src.baseVersion);
    if (!d) throw new Error('Base document not loaded');
    return (await d).getPage(src.index + 1);
  }
  let p = previewDocs.get(src.bytes);
  if (!p) {
    p = openDoc(src.bytes);
    previewDocs.set(src.bytes, p);
    // Keep the preview cache bounded.
    if (previewDocs.size > 40) {
      const [k, v] = previewDocs.entries().next().value!;
      previewDocs.delete(k);
      v.then((d) => d.destroy()).catch(() => undefined);
    }
  }
  return (await p).getPage(1);
}

export interface RenderHandle {
  cancel(): void;
  promise: Promise<void>;
}

/** Render a page at the given zoom to a canvas (handles devicePixelRatio). */
export function renderToCanvas(page: PDFPageProxy, canvas: HTMLCanvasElement, zoom: number, opts: { maxPixels?: number } = {}): RenderHandle {
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  let scale = zoom * dpr;
  const vp0 = page.getViewport({ scale: 1 });
  const maxPixels = opts.maxPixels ?? 16_000_000;
  if (vp0.width * vp0.height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (vp0.width * vp0.height));
  const viewport = page.getViewport({ scale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(vp0.width * zoom)}px`;
  canvas.style.height = `${Math.floor(vp0.height * zoom)}px`;
  const ctx = canvas.getContext('2d')!;
  let task: RenderTask | null = null;
  const promise = (async () => {
    const pdfjs = await loadPdfJs();
    task = page.render({ canvasContext: ctx, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE });
    try {
      await task.promise;
    } catch (e) {
      if ((e as Error)?.name !== 'RenderingCancelledException') throw e;
    }
  })();
  return { cancel: () => task?.cancel(), promise };
}

/** Render a page to an image blob (PNG/JPEG) at a given DPI. */
export async function renderToBlob(page: PDFPageProxy, dpi: number, type: 'image/png' | 'image/jpeg', quality = 0.92): Promise<Blob> {
  const pdfjs = await loadPdfJs();
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d')!;
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  await page.render({ canvasContext: ctx, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Render failed'))), type, quality));
}

/** Render to a canvas for OCR (no DPR scaling). */
export async function renderForOcr(page: PDFPageProxy, dpi = 200): Promise<HTMLCanvasElement> {
  const pdfjs = await loadPdfJs();
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
  return canvas;
}

/** Open arbitrary bytes for one-off exports (e.g. PNG export of the saved file). */
export async function openTemporary(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return openDoc(bytes);
}
