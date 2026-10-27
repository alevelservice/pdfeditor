/**
 * Low-level helpers on top of pdf-lib's object layer.
 *
 * Mutation rule used across the engine: existing PDF objects are never
 * mutated in place when the change must be undoable. Instead a shallow clone
 * is created and assigned to the page leaf. Undo then only has to restore
 * the page leaf dictionary entries (see history.ts).
 */
import {
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFPageLeaf,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';
import pako from 'pako';

export const N = (s: string) => PDFName.of(s);

export function lookup(ctx: PDFContext, obj: PDFObject | undefined): PDFObject | undefined {
  if (obj instanceof PDFRef) return ctx.lookup(obj);
  return obj;
}

export function dictGet(ctx: PDFContext, dict: PDFDict | undefined, key: string): PDFObject | undefined {
  if (!dict) return undefined;
  return lookup(ctx, dict.get(N(key)));
}

export function asDict(o: PDFObject | undefined): PDFDict | undefined {
  if (o instanceof PDFDict) return o;
  if (o instanceof PDFStream) return o.dict;
  return undefined;
}

export function getDict(ctx: PDFContext, dict: PDFDict | undefined, key: string): PDFDict | undefined {
  return asDict(dictGet(ctx, dict, key));
}

export function getArray(ctx: PDFContext, dict: PDFDict | undefined, key: string): PDFArray | undefined {
  const o = dictGet(ctx, dict, key);
  return o instanceof PDFArray ? o : undefined;
}

export function getNumber(ctx: PDFContext, dict: PDFDict | undefined, key: string, def = 0): number {
  const o = dictGet(ctx, dict, key);
  return o instanceof PDFNumber ? o.asNumber() : def;
}

export function getName(ctx: PDFContext, dict: PDFDict | undefined, key: string): string | undefined {
  const o = dictGet(ctx, dict, key);
  return o instanceof PDFName ? o.decodeText() : undefined;
}

export function getBool(ctx: PDFContext, dict: PDFDict | undefined, key: string): boolean | undefined {
  const o = dictGet(ctx, dict, key);
  return o instanceof PDFBool ? o.asBoolean() : undefined;
}

export function numArray(ctx: PDFContext, o: PDFObject | undefined): number[] {
  const a = lookup(ctx, o);
  if (!(a instanceof PDFArray)) return [];
  const out: number[] = [];
  for (let i = 0; i < a.size(); i++) {
    const v = lookup(ctx, a.get(i));
    out.push(v instanceof PDFNumber ? v.asNumber() : 0);
  }
  return out;
}

export function textOf(o: PDFObject | undefined): string {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  if (o instanceof PDFName) return o.decodeText();
  return '';
}

/** Raw bytes of a string object (without text decoding). */
export function bytesOf(o: PDFObject | undefined): Uint8Array {
  if (o instanceof PDFString) {
    return o.asBytes();
  }
  if (o instanceof PDFHexString) return o.asBytes();
  return new Uint8Array();
}

/** Decode stream data applying its filters. Image filters (DCT/JPX/CCITT/JBIG2) are left encoded. */
export function streamBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) {
    try {
      const filters = filterNames(stream.dict);
      const imageFilter = filters.find((f) => f === 'DCTDecode' || f === 'JPXDecode' || f === 'CCITTFaxDecode' || f === 'JBIG2Decode');
      if (imageFilter) {
        // Decode only the non-image filters preceding it (rare).
        if (filters[0] === imageFilter) return stream.contents;
      }
      return decodePDFRawStream(stream).decode();
    } catch {
      // Fall back to raw zlib with error tolerance.
      try {
        return pako.inflate(stream.contents);
      } catch {
        return stream.contents;
      }
    }
  }
  return stream.getContents();
}

export function filterNames(dict: PDFDict): string[] {
  const f = dict.lookup(N('Filter'));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) {
    const out: string[] = [];
    for (let i = 0; i < f.size(); i++) {
      const x = f.lookup(i);
      if (x instanceof PDFName) out.push(x.decodeText());
    }
    return out;
  }
  return [];
}

/** Create a Flate-compressed stream. */
export function flateStream(ctx: PDFContext, data: Uint8Array, dict: Record<string, PDFObject> = {}): PDFRawStream {
  const compressed = pako.deflate(data);
  const d = ctx.obj({}) as PDFDict;
  for (const [k, v] of Object.entries(dict)) d.set(N(k), v);
  d.set(N('Filter'), N('FlateDecode'));
  d.set(N('Length'), PDFNumber.of(compressed.length));
  return PDFRawStream.of(d, compressed);
}

/** Concatenated, decoded bytes of a page's /Contents (stream or array of streams). */
export function pageContentBytes(ctx: PDFContext, leaf: PDFDict): Uint8Array {
  const c = leaf.get(N('Contents'));
  const parts: Uint8Array[] = [];
  const collect = (o: PDFObject | undefined) => {
    const r = lookup(ctx, o);
    if (r instanceof PDFStream) parts.push(streamBytes(r));
    else if (r instanceof PDFArray) for (let i = 0; i < r.size(); i++) collect(r.get(i));
  };
  collect(c);
  return joinWithNewlines(parts);
}

export function joinWithNewlines(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length + 1, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
    out[p++] = 10;
  }
  return out;
}

/** Look up an inheritable page attribute (Resources, MediaBox, CropBox, Rotate). */
export function inherited(ctx: PDFContext, leaf: PDFDict, key: string): PDFObject | undefined {
  let node: PDFDict | undefined = leaf;
  let guard = 0;
  while (node && guard++ < 64) {
    const v = node.get(N(key));
    if (v !== undefined) return lookup(ctx, v);
    node = asDict(lookup(ctx, node.get(N('Parent'))));
  }
  return undefined;
}

export function pageResources(ctx: PDFContext, leaf: PDFDict): PDFDict {
  const r = asDict(inherited(ctx, leaf, 'Resources'));
  return r ?? (ctx.obj({}) as PDFDict);
}

/** Shallow clone of a dict (values shared). */
export function cloneDict(ctx: PDFContext, d: PDFDict): PDFDict {
  const out = ctx.obj({}) as PDFDict;
  for (const [k, v] of d.entries()) out.set(k, v);
  return out;
}

/**
 * Clone-on-write the page resources so that a subdictionary (Font, XObject,
 * ExtGState, ColorSpace) can be extended without touching shared objects.
 * Returns the writable subdictionary.
 */
export function writableResourceCategory(ctx: PDFContext, leaf: PDFDict, category: string): PDFDict {
  const res = cloneDict(ctx, pageResources(ctx, leaf));
  const existing = asDict(lookup(ctx, res.get(N(category))));
  const cat = existing ? cloneDict(ctx, existing) : (ctx.obj({}) as PDFDict);
  res.set(N(category), cat);
  leaf.set(N('Resources'), res);
  return cat;
}

export function uniqueResourceName(cat: PDFDict, prefix: string): string {
  let i = 1;
  const keys = new Set(cat.keys().map((k) => k.decodeText()));
  while (keys.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

/** Add an object to a resource category of the page (clone-on-write) and return its resource name. */
export function addPageResource(ctx: PDFContext, leaf: PDFDict, category: string, prefix: string, ref: PDFObject): string {
  const cat = writableResourceCategory(ctx, leaf, category);
  // Reuse existing entry pointing at the same ref
  if (ref instanceof PDFRef) {
    for (const [k, v] of cat.entries()) if (v instanceof PDFRef && v === ref) return k.decodeText();
  }
  const name = uniqueResourceName(cat, prefix);
  cat.set(N(name), ref);
  return name;
}

/** Replace the page content with a single new Flate stream. */
export function setPageContent(ctx: PDFContext, leaf: PDFDict, bytes: Uint8Array): PDFRef {
  const stream = flateStream(ctx, bytes);
  const ref = ctx.register(stream);
  leaf.set(N('Contents'), ref);
  return ref;
}

export function rectArray(ctx: PDFContext, o: PDFObject | undefined, fallback: [number, number, number, number]): [number, number, number, number] {
  const a = numArray(ctx, o);
  if (a.length < 4) return fallback;
  return [Math.min(a[0], a[2]), Math.min(a[1], a[3]), Math.max(a[0], a[2]), Math.max(a[1], a[3])];
}

export function refKey(ref: PDFRef): string {
  return `${ref.objectNumber}_${ref.generationNumber}`;
}

export function getPageLeafRefs(doc: PDFDocument): PDFRef[] {
  return doc.getPages().map((p) => p.ref);
}

export function leafOf(doc: PDFDocument, ref: PDFRef): PDFPageLeaf {
  return doc.context.lookup(ref) as PDFPageLeaf;
}

export function pdfDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export const latin1Bytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
