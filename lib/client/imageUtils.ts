'use client';
import type { NewImage } from '@/lib/pdf/types';

/** Convert any browser-decodable image (PNG, JPEG, WebP, SVG, GIF, BMP) to PNG/JPEG bytes. */
export async function fileToPdfImage(file: Blob): Promise<NewImage & { width: number; height: number }> {
  const type = file.type;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (type === 'image/jpeg' || type === 'image/png') {
    const dims = await imageSize(file);
    return { bytes, mime: type, ...dims };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    // SVGs without intrinsic size get a sensible raster size.
    let w = img.naturalWidth || 1000;
    let h = img.naturalHeight || 1000;
    if (type === 'image/svg+xml') {
      const scaleUp = Math.max(1, 2000 / Math.max(w, h));
      w = Math.round(w * scaleUp);
      h = Math.round(h * scaleUp);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Image conversion failed'))), 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Unsupported image'));
    img.src = url;
  });
}

async function imageSize(file: Blob): Promise<{ width: number; height: number }> {
  try {
    const bmp = await createImageBitmap(file);
    const r = { width: bmp.width, height: bmp.height };
    bmp.close();
    return r;
  } catch {
    return { width: 100, height: 100 };
  }
}

export function downloadBytes(bytes: Uint8Array | Blob, name: string, mime = 'application/pdf') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

/** Render typed text as a signature PNG using a cursive font stack. */
export async function typedSignaturePng(text: string, color: string, font: string): Promise<NewImage & { width: number; height: number }> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const size = 96;
  ctx.font = `${size}px ${font}`;
  const w = Math.ceil(ctx.measureText(text).width + size * 0.6);
  const h = Math.ceil(size * 1.6);
  canvas.width = w;
  canvas.height = h;
  ctx.font = `${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size * 0.3, h / 2);
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('fail'))), 'image/png'));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', width: w, height: h };
}

export function rgbToHex(c: { r: number; g: number; b: number } | null | undefined): string {
  if (!c) return '#000000';
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) ?? [];
  return { r: parseInt(m[1] ?? '0', 16) / 255, g: parseInt(m[2] ?? '0', 16) / 255, b: parseInt(m[3] ?? '0', 16) / 255 };
}
