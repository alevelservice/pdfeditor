/**
 * Image XObjects: decode / extract, replace, transform, crop, opacity,
 * insertion, and pixel-level editing (used by redaction and OCR).
 */
import { PDFArray, PDFContext, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';
import pako from 'pako';
import { mkop, name, nums, type Op, type PdfValue, inlineDictGet } from './lexer';
import { apply, invert } from './geom';
import { dictGet, filterNames, getName, getNumber, lookup, N, numArray, streamBytes } from './objects';
import type { InternalImage } from './parser';
import { cmForPageTransform, matrixOp, PageEditor } from './writer';
import type { FitMode, Matrix, NewImage, Rect } from './types';

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Browser-provided codec for JPEG (DCT) decoding/encoding. Optional. */
export interface ImageCodec {
  decode(bytes: Uint8Array, mime: 'image/jpeg' | 'image/png'): Promise<RGBAImage>;
  encodeJpeg(img: RGBAImage, quality: number): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePNG(img: RGBAImage): Uint8Array {
  const { width, height, data } = img;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', pako.deflate(raw)), chunk('IEND', new Uint8Array())];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

interface ColorModel {
  comps: number;
  toRGB: (src: number[], out: Uint8ClampedArray, o: number) => void;
  kind: 'gray' | 'rgb' | 'cmyk' | 'indexed';
  palette?: Uint8Array;
  baseComps?: number;
}

function colorModel(ctx: PDFContext, cs: unknown, isMask: boolean): ColorModel | null {
  if (isMask) return { comps: 1, kind: 'gray', toRGB: (s, out, o) => { const v = s[0] ? 0 : 255; out[o] = out[o + 1] = out[o + 2] = v; } };
  const csv = lookup(ctx, cs as never);
  let nm = '';
  if (csv instanceof PDFName) nm = csv.decodeText();
  if (nm === 'DeviceGray' || nm === 'G' || nm === 'CalGray') return { comps: 1, kind: 'gray', toRGB: (s, out, o) => { out[o] = out[o + 1] = out[o + 2] = s[0]; } };
  if (nm === 'DeviceRGB' || nm === 'RGB' || nm === 'CalRGB') return { comps: 3, kind: 'rgb', toRGB: (s, out, o) => { out[o] = s[0]; out[o + 1] = s[1]; out[o + 2] = s[2]; } };
  if (nm === 'DeviceCMYK' || nm === 'CMYK') return cmykModel();
  if (csv instanceof PDFArray) {
    const fam = lookup(ctx, csv.get(0));
    const f = fam instanceof PDFName ? fam.decodeText() : '';
    if (f === 'ICCBased') {
      const s = lookup(ctx, csv.get(1));
      const n = s instanceof PDFStream ? getNumber(ctx, s.dict, 'N', 3) : 3;
      if (n === 1) return colorModel(ctx, PDFName.of('DeviceGray'), false);
      if (n === 4) return cmykModel();
      return colorModel(ctx, PDFName.of('DeviceRGB'), false);
    }
    if (f === 'CalRGB') return colorModel(ctx, PDFName.of('DeviceRGB'), false);
    if (f === 'CalGray') return colorModel(ctx, PDFName.of('DeviceGray'), false);
    if (f === 'Indexed' || f === 'I') {
      const base = colorModel(ctx, csv.get(1), false);
      const lut = lookup(ctx, csv.get(3));
      let palette: Uint8Array | null = null;
      if (lut instanceof PDFStream) palette = streamBytes(lut);
      else if (lut && 'asBytes' in (lut as object)) palette = (lut as unknown as { asBytes(): Uint8Array }).asBytes();
      if (!base || !palette) return null;
      const bc = base.comps;
      return {
        comps: 1,
        kind: 'indexed',
        palette,
        baseComps: bc,
        toRGB: (s, out, o) => {
          const i = s[0] * bc;
          base.toRGB(Array.from(palette!.subarray(i, i + bc)), out, o);
        },
      };
    }
    if (f === 'Separation') return { comps: 1, kind: 'gray', toRGB: (s, out, o) => { out[o] = out[o + 1] = out[o + 2] = 255 - s[0]; } };
  }
  return null;
}

function cmykModel(): ColorModel {
  return {
    comps: 4,
    kind: 'cmyk',
    toRGB: (s, out, o) => {
      const k = s[3] / 255;
      out[o] = 255 * (1 - s[0] / 255) * (1 - k);
      out[o + 1] = 255 * (1 - s[1] / 255) * (1 - k);
      out[o + 2] = 255 * (1 - s[2] / 255) * (1 - k);
    },
  };
}

/** Undo PNG predictors (Flate DecodeParms Predictor >= 10) and TIFF predictor 2. */
export function unpredict(data: Uint8Array, parms: { predictor: number; colors: number; bpc: number; columns: number }): Uint8Array {
  const { predictor, colors, bpc, columns } = parms;
  if (predictor < 2) return data;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    if (bpc !== 8) return data;
    const out = data.slice();
    for (let r = 0; r * rowLen < out.length; r++) {
      for (let i = bpp; i < rowLen; i++) out[r * rowLen + i] = (out[r * rowLen + i] + out[r * rowLen + i - bpp]) & 0xff;
    }
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)];
    const row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = new Uint8Array(rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      switch (ft) {
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: break;
      }
      cur[i] = v & 0xff;
    }
    out.set(cur, r * rowLen);
    prev = cur;
  }
  return out;
}

export interface DecodedSamples {
  width: number;
  height: number;
  bpc: number;
  model: ColorModel;
  /** Unpacked samples, one byte (0..255 or index) per component. */
  samples: Uint8Array;
  decodeInverted: boolean;
}

function decodeParms(ctx: PDFContext, dict: PDFDict) {
  let dp = dictGet(ctx, dict, 'DecodeParms') ?? dictGet(ctx, dict, 'DP');
  if (dp instanceof PDFArray) dp = lookup(ctx, dp.get(dp.size() - 1));
  const d = dp instanceof PDFDict ? dp : undefined;
  return {
    predictor: getNumber(ctx, d, 'Predictor', 1),
    colors: getNumber(ctx, d, 'Colors', 1),
    bpc: getNumber(ctx, d, 'BitsPerComponent', 8),
    columns: getNumber(ctx, d, 'Columns', 1),
  };
}

/** Decode non-DCT image samples (Flate/LZW/RunLength/raw). Returns null for unsupported data. */
export function decodeSamples(ctx: PDFContext, stream: PDFStream): DecodedSamples | null {
  const d = stream.dict;
  const filters = filterNames(d);
  if (filters.some((f) => ['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode', 'DCT'].includes(f))) return null;
  const w = getNumber(ctx, d, 'Width', 0);
  const h = getNumber(ctx, d, 'Height', 0);
  const isMask = !!(dictGet(ctx, d, 'ImageMask') as { asBoolean?: () => boolean } | undefined)?.asBoolean?.();
  const bpc = isMask ? 1 : getNumber(ctx, d, 'BitsPerComponent', 8);
  const model = colorModel(ctx, dictGet(ctx, d, 'ColorSpace'), isMask);
  if (!model || !w || !h) return null;
  let data: Uint8Array;
  try {
    // pdf-lib's decoder does not apply predictors; do it ourselves.
    data = stream instanceof PDFRawStream ? streamBytes(stream) : stream.getContents();
  } catch {
    return null;
  }
  const parms = decodeParms(ctx, d);
  if (parms.predictor > 1) data = unpredict(data, { ...parms, colors: parms.colors || model.comps, columns: parms.columns || w });
  const comps = model.comps;
  const samples = new Uint8Array(w * h * comps);
  const rowBits = w * comps * bpc;
  const rowBytes = Math.ceil(rowBits / 8);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w * comps; x++) {
      const bit = y * rowBytes * 8 + x * bpc;
      let v: number;
      if (bpc === 8) v = data[(bit >> 3)] ?? 0;
      else if (bpc === 16) v = data[bit >> 3] ?? 0;
      else {
        const byte = data[bit >> 3] ?? 0;
        const shift = 8 - bpc - (bit & 7);
        v = (byte >> shift) & ((1 << bpc) - 1);
        if (model.kind !== 'indexed') v = Math.round((v * 255) / ((1 << bpc) - 1));
      }
      samples[y * w * comps + x] = v;
    }
  }
  const decode = numArray(ctx, d.get(N('Decode')));
  const decodeInverted = decode.length >= 2 && decode[0] > decode[1];
  return { width: w, height: h, bpc, model, samples, decodeInverted };
}

export function samplesToRGBA(s: DecodedSamples): RGBAImage {
  const { width, height, model, samples } = s;
  const out = new Uint8ClampedArray(width * height * 4);
  const tmp: number[] = new Array(model.comps).fill(0);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < model.comps; c++) {
      let v = samples[i * model.comps + c];
      if (s.decodeInverted && model.kind !== 'indexed') v = 255 - v;
      tmp[c] = v;
    }
    if (s.decodeInverted && model.kind === 'gray' && s.bpc === 1) {
      // ImageMask with inverted decode: handled by toRGB semantics.
    }
    model.toRGB(tmp, out, i * 4);
    out[i * 4 + 3] = 255;
  }
  return { width, height, data: out };
}

async function applySMask(ctx: PDFContext, stream: PDFStream, img: RGBAImage, codec?: ImageCodec | null) {
  const sm = lookup(ctx, stream.dict.get(N('SMask')));
  if (!(sm instanceof PDFStream)) return;
  const alpha = await decodeToRGBA(ctx, sm, codec, false);
  if (!alpha) return;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const ax = Math.min(alpha.width - 1, Math.floor((x * alpha.width) / img.width));
      const ay = Math.min(alpha.height - 1, Math.floor((y * alpha.height) / img.height));
      img.data[(y * img.width + x) * 4 + 3] = alpha.data[(ay * alpha.width + ax) * 4];
    }
  }
}

export async function decodeToRGBA(ctx: PDFContext, stream: PDFStream, codec?: ImageCodec | null, withAlpha = true): Promise<RGBAImage | null> {
  const filters = filterNames(stream.dict);
  let img: RGBAImage | null = null;
  if (filters.includes('DCTDecode') || filters.includes('DCT')) {
    if (!codec) return null;
    const raw = streamBytes(stream);
    img = await codec.decode(raw, 'image/jpeg');
    // Adobe CMYK JPEGs are often inverted; codecs typically handle them.
  } else {
    const s = decodeSamples(ctx, stream);
    if (!s) return null;
    img = samplesToRGBA(s);
  }
  if (img && withAlpha) await applySMask(ctx, stream, img, codec);
  return img;
}

/** Extract an image as a downloadable file. */
export async function extractImage(ctx: PDFContext, stream: PDFStream, codec?: ImageCodec | null): Promise<{ bytes: Uint8Array; mime: string; ext: string }> {
  const filters = filterNames(stream.dict);
  const cs = getName(ctx, stream.dict, 'ColorSpace');
  const hasSMask = !!stream.dict.get(N('SMask'));
  if (filters.length === 1 && filters[0] === 'DCTDecode' && !hasSMask && cs !== 'DeviceCMYK') {
    return { bytes: (stream as PDFRawStream).contents, mime: 'image/jpeg', ext: 'jpg' };
  }
  if (filters.includes('JPXDecode') && !hasSMask) return { bytes: (stream as PDFRawStream).contents, mime: 'image/jp2', ext: 'jp2' };
  const img = await decodeToRGBA(ctx, stream, codec);
  if (!img) throw new Error(`Unsupported image encoding (${filters.join(', ') || 'raw'})`);
  return { bytes: encodePNG(img), mime: 'image/png', ext: 'png' };
}

/** Build an inline-image stream from its BI dict (so inline images can be extracted). */
export function inlineToStream(ctx: PDFContext, dict: [string, PdfValue][], data: Uint8Array): PDFRawStream {
  const ABBR: Record<string, string> = { W: 'Width', H: 'Height', BPC: 'BitsPerComponent', CS: 'ColorSpace', F: 'Filter', DP: 'DecodeParms', IM: 'ImageMask', D: 'Decode', I: 'Interpolate' };
  const VAL: Record<string, string> = { G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed', AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode', RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode', DCT: 'DCTDecode' };
  const toObj = (v: PdfValue): unknown => {
    switch (v.t) {
      case 'num': return v.v;
      case 'name': return PDFName.of(VAL[v.v] ?? v.v);
      case 'bool': return v.v;
      case 'arr': return v.v.map(toObj);
      default: return null;
    }
  };
  const d = ctx.obj({}) as PDFDict;
  for (const [k, v] of dict) d.set(N(ABBR[k] ?? k), ctx.obj(toObj(v) as never));
  d.set(N('Length'), PDFNumber.of(data.length));
  return PDFRawStream.of(d, data);
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export async function embedNewImage(doc: PDFDocument, img: NewImage): Promise<{ ref: PDFRef; width: number; height: number }> {
  const im = img.mime === 'image/png' ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
  await im.embed();
  return { ref: im.ref, width: im.width, height: im.height };
}

/** Matrix (in image unit space) that fits an image of aspect `a` into the current box. */
export function fitMatrix(fit: FitMode, imgW: number, imgH: number, box: Matrix): { S: Matrix | null; clip: boolean } {
  if (fit === 'stretch' || fit === 'keep') return { S: null, clip: false };
  const W = Math.hypot(box[0], box[1]);
  const H = Math.hypot(box[2], box[3]);
  const a = imgW / imgH;
  const b = W / H;
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) < 1e-3) return { S: null, clip: false };
  if (fit === 'contain') {
    if (a > b) {
      const sy = b / a;
      return { S: [1, 0, 0, sy, 0, (1 - sy) / 2], clip: false };
    }
    const sx = a / b;
    return { S: [sx, 0, 0, 1, (1 - sx) / 2, 0], clip: false };
  }
  // cover
  if (a > b) {
    const sx = a / b;
    return { S: [sx, 0, 0, 1, (1 - sx) / 2, 0], clip: true };
  }
  const sy = b / a;
  return { S: [1, 0, 0, sy, 0, (1 - sy) / 2], clip: true };
}

export function replaceImageOps(editor: PageEditor, image: InternalImage, resName: string, newW: number, newH: number, fit: FitMode) {
  const { S, clip } = fitMatrix(fit, newW, newH, image.matrix);
  const ops: Op[] = [mkop('q')];
  if (clip) ops.push(nums('re', 0, 0, 1, 1), mkop('W'), mkop('n'));
  if (S) ops.push(matrixOp('cm', S));
  ops.push(mkop('Do', name(resName)), mkop('Q'));
  editor.replace(image.opIndex, ops);
}

/** Wrap an image draw in a transform / clip / alpha. */
export function wrapImageOp(editor: PageEditor, image: InternalImage, opts: { D?: Matrix; crop?: Rect; alpha?: number }) {
  const original = editor.ops[image.opIndex];
  const ops: Op[] = [mkop('q')];
  if (opts.D) ops.push(matrixOp('cm', cmForPageTransform(image.matrix, opts.D)));
  if (opts.alpha !== undefined) ops.push(mkop('gs', name(editor.alphaState(opts.alpha))));
  if (opts.crop) ops.push(nums('re', opts.crop.x, opts.crop.y, opts.crop.width, opts.crop.height), mkop('W'), mkop('n'));
  ops.push(original.op === 'BI' ? { op: 'BI', args: [], inline: original.inline } : { op: original.op, args: original.args });
  ops.push(mkop('Q'));
  editor.replace(image.opIndex, ops);
}

export function insertImageOps(resName: string, rect: Rect, rotation = 0, alphaGs?: string): Op[] {
  const ops: Op[] = [mkop('q')];
  if (alphaGs) ops.push(mkop('gs', name(alphaGs)));
  if (rotation) {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const r = (rotation * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    ops.push(nums('cm', c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy));
  }
  ops.push(nums('cm', rect.width, 0, 0, rect.height, rect.x, rect.y), mkop('Do', name(resName)), mkop('Q'));
  return ops;
}

/** Page rect -> pixel rect of the image (top-left origin), clamped. */
export function pageRectToPixels(image: { matrix: Matrix; width: number; height: number }, r: Rect): { x0: number; y0: number; x1: number; y1: number } | null {
  const inv = invert(image.matrix);
  const pts = [
    apply(inv, r.x, r.y), apply(inv, r.x + r.width, r.y),
    apply(inv, r.x, r.y + r.height), apply(inv, r.x + r.width, r.y + r.height),
  ];
  const us = pts.map((p) => p[0]);
  const vs = pts.map((p) => p[1]);
  const u0 = Math.max(0, Math.min(...us)), u1 = Math.min(1, Math.max(...us));
  const v0 = Math.max(0, Math.min(...vs)), v1 = Math.min(1, Math.max(...vs));
  if (u1 <= u0 || v1 <= v0) return null;
  return {
    x0: Math.floor(u0 * image.width),
    x1: Math.ceil(u1 * image.width),
    y0: Math.floor((1 - v1) * image.height),
    y1: Math.ceil((1 - v0) * image.height),
  };
}

/**
 * Paint pixel regions of an image XObject and return a replacement stream.
 * Works natively for Flate/raw images; DCT images need a codec. Returns null
 * if the image cannot be modified.
 */
export async function paintImageRegions(
  ctx: PDFContext,
  stream: PDFStream,
  regions: { x0: number; y0: number; x1: number; y1: number; rgb?: [number, number, number] }[],
  codec?: ImageCodec | null,
): Promise<PDFRawStream | null> {
  const filters = filterNames(stream.dict);
  const isDct = filters.includes('DCTDecode') || filters.includes('DCT');
  if (isDct) {
    if (!codec) return null;
    const img = await codec.decode(streamBytes(stream), 'image/jpeg');
    for (const r of regions) {
      const [cr, cg, cb] = r.rgb ?? [0, 0, 0];
      for (let y = Math.max(0, r.y0); y < Math.min(img.height, r.y1); y++)
        for (let x = Math.max(0, r.x0); x < Math.min(img.width, r.x1); x++) {
          const o = (y * img.width + x) * 4;
          img.data[o] = cr;
          img.data[o + 1] = cg;
          img.data[o + 2] = cb;
        }
    }
    const jpg = await codec.encodeJpeg(img, 0.92);
    const d = ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: img.width, Height: img.height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode', Length: jpg.length }) as PDFDict;
    const sm = stream.dict.get(N('SMask'));
    if (sm) d.set(N('SMask'), sm);
    return PDFRawStream.of(d, jpg);
  }
  const s = decodeSamples(ctx, stream);
  if (!s || (s.bpc !== 8 && s.model.kind !== 'gray')) return null;
  const { width, height, model } = s;
  const comps = model.comps;
  // Pick the "black" (or requested colour) value in the native colour space.
  const native = (rgb?: [number, number, number]): number[] => {
    const [r, g, b] = rgb ?? [0, 0, 0];
    if (model.kind === 'gray') return [s.decodeInverted ? 255 - Math.round((r + g + b) / 3) : Math.round((r + g + b) / 3)];
    if (model.kind === 'rgb') return [r, g, b];
    if (model.kind === 'cmyk') {
      const k = 1 - Math.max(r, g, b) / 255;
      const f = (c: number) => (k >= 1 ? 0 : Math.round(((1 - c / 255 - k) / (1 - k)) * 255));
      return [f(r), f(g), f(b), Math.round(k * 255)];
    }
    // indexed: nearest palette entry
    const pal = model.palette!;
    const bc = model.baseComps!;
    let best = 0, bestD = Infinity;
    const tmp = new Uint8ClampedArray(4);
    for (let i = 0; i * bc < pal.length; i++) {
      const base = colorModel(ctx, PDFName.of(bc === 1 ? 'DeviceGray' : bc === 4 ? 'DeviceCMYK' : 'DeviceRGB'), false)!;
      base.toRGB(Array.from(pal.subarray(i * bc, i * bc + bc)), tmp, 0);
      const dd = (tmp[0] - r) ** 2 + (tmp[1] - g) ** 2 + (tmp[2] - b) ** 2;
      if (dd < bestD) { bestD = dd; best = i; }
    }
    return [best];
  };
  const samples = s.samples;
  const isMask = !!dictGet(ctx, stream.dict, 'ImageMask');
  for (const r of regions) {
    // For stencil masks "removing" means not painting: sample 1 (or 0 when Decode is inverted).
    const val = isMask ? [s.decodeInverted ? 0 : 255] : native(r.rgb);
    for (let y = Math.max(0, r.y0); y < Math.min(height, r.y1); y++)
      for (let x = Math.max(0, r.x0); x < Math.min(width, r.x1); x++)
        for (let c = 0; c < comps; c++) samples[(y * width + x) * comps + c] = val[c];
  }
  const d = ctx.obj({}) as PDFDict;
  for (const [k, v] of stream.dict.entries()) {
    const key = k.decodeText();
    if (['Filter', 'DecodeParms', 'Length', 'DP', 'F'].includes(key)) continue;
    d.set(k, v);
  }
  let packed: Uint8Array;
  if (isMask) {
    const rowBytes = Math.ceil(width / 8);
    packed = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) if (samples[y * width + x] !== 0) packed[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  } else if (model.kind === 'indexed' && s.bpc !== 8) {
    const bpc = s.bpc;
    const rowBytes = Math.ceil((width * bpc) / 8);
    packed = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const bit = y * rowBytes * 8 + x * bpc;
        packed[bit >> 3] |= (samples[y * width + x] & ((1 << bpc) - 1)) << (8 - bpc - (bit & 7));
      }
  } else {
    // Samples were expanded to 8 bits per component; Decode arrays keep their meaning.
    packed = samples;
    d.set(N('BitsPerComponent'), PDFNumber.of(8));
  }
  const data = pako.deflate(packed);
  d.set(N('Filter'), N('FlateDecode'));
  d.set(N('Length'), PDFNumber.of(data.length));
  return PDFRawStream.of(d, data);
}

export function inlineImageInfo(op: Op) {
  const inl = op.inline!;
  const g = (k: string) => inlineDictGet(inl.dict, k);
  return { width: g('Width'), height: g('Height') };
}
