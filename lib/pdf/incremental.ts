/**
 * Incremental save: the original file bytes are kept untouched and only
 * new / modified objects are appended, followed by a new cross-reference
 * section whose /Prev points at the original one.
 */
import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNull,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import pako from 'pako';
import { concatBytes, latin1Bytes, refKey } from './objects';

interface Fingerprint {
  text: string;
  contents?: Uint8Array;
  hash?: number;
}

function fingerprint(obj: PDFObject): Fingerprint {
  if (obj instanceof PDFRawStream) return { text: obj.dict.toString(), contents: obj.contents };
  return { text: obj.toString() };
}

function fnv(bytes: Uint8Array): number {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
  return h >>> 0;
}

/** Same object content? Streams compare by identity first, then by length + hash (survives reloads). */
function sameAs(before: Fingerprint, now: Fingerprint): boolean {
  if (now.text !== before.text) return false;
  if (!before.contents && !now.contents) return true;
  if (!before.contents || !now.contents) return false;
  if (before.contents === now.contents) return true;
  if (before.contents.length !== now.contents.length) return false;
  before.hash ??= fnv(before.contents);
  return before.hash === fnv(now.contents);
}

export class ChangeTracker {
  private prints = new Map<string, Fingerprint>();
  readonly startxref: number;
  readonly usesXrefStream: boolean;

  constructor(private doc: PDFDocument, private original: Uint8Array) {
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) this.prints.set(refKey(ref), fingerprint(obj));
    const info = findStartXref(original);
    this.startxref = info.offset;
    this.usesXrefStream = info.isStream;
  }

  get originalBytes(): Uint8Array {
    return this.original;
  }

  /** Objects that differ from the original file. */
  changes(reachable?: Set<string>): { changed: [PDFRef, PDFObject][]; deleted: PDFRef[] } {
    const changed: [PDFRef, PDFObject][] = [];
    const seen = new Set<string>();
    for (const [ref, obj] of this.doc.context.enumerateIndirectObjects()) {
      const k = refKey(ref);
      seen.add(k);
      const before = this.prints.get(k);
      if (!before) {
        if (!reachable || reachable.has(k)) changed.push([ref, obj]);
        continue;
      }
      if (!sameAs(before, fingerprint(obj))) changed.push([ref, obj]);
    }
    const deleted: PDFRef[] = [];
    for (const k of this.prints.keys()) {
      if (!seen.has(k)) {
        const [n, g] = k.split('_').map(Number);
        deleted.push(PDFRef.of(n, g));
      }
    }
    return { changed, deleted };
  }

  hasChanges(): boolean {
    const { changed, deleted } = this.changes();
    return changed.length > 0 || deleted.length > 0;
  }
}

export function findStartXref(bytes: Uint8Array): { offset: number; isStream: boolean } {
  const tailStart = Math.max(0, bytes.length - 2048);
  let s = '';
  for (let i = tailStart; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  const idx = s.lastIndexOf('startxref');
  if (idx < 0) return { offset: -1, isStream: false };
  const m = /startxref\s+(\d+)/.exec(s.slice(idx));
  const offset = m ? parseInt(m[1], 10) : -1;
  let isStream = false;
  if (offset >= 0 && offset < bytes.length) {
    let head = '';
    for (let i = offset; i < Math.min(bytes.length, offset + 32); i++) head += String.fromCharCode(bytes[i]);
    isStream = !/^\s*xref/.test(head);
  }
  return { offset, isStream };
}

function serialize(obj: PDFObject): Uint8Array {
  const size = obj.sizeInBytes();
  const buf = new Uint8Array(size);
  obj.copyBytesInto(buf, 0);
  return buf;
}

/** Set of reachable object keys starting from the trailer. */
export function reachableRefs(ctx: PDFContext): Set<string> {
  const seen = new Set<string>();
  const stack: PDFObject[] = [];
  const t = ctx.trailerInfo;
  for (const r of [t.Root, t.Info, t.Encrypt]) if (r) stack.push(r as PDFObject);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      const k = refKey(o);
      if (seen.has(k)) continue;
      seen.add(k);
      const v = ctx.lookup(o);
      if (v) stack.push(v);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  return seen;
}

/** Append an incremental update to the original bytes. */
export function saveIncremental(doc: PDFDocument, tracker: ChangeTracker): Uint8Array {
  const ctx = doc.context;
  const original = tracker.originalBytes;
  if (tracker.startxref < 0) throw new Error('Original file has no startxref; incremental save not possible');
  const reach = reachableRefs(ctx);
  const { changed, deleted } = tracker.changes(reach);
  if (!changed.length && !deleted.length) return original;

  const parts: Uint8Array[] = [original];
  let offset = original.length;
  if (original[original.length - 1] !== 10 && original[original.length - 1] !== 13) {
    parts.push(latin1Bytes('\n'));
    offset += 1;
  }
  const entries: { num: number; gen: number; offset: number; free: boolean }[] = [];
  changed.sort((a, b) => a[0].objectNumber - b[0].objectNumber);
  for (const [ref, obj] of changed) {
    const head = latin1Bytes(`${ref.objectNumber} ${ref.generationNumber} obj\n`);
    const body = serialize(obj);
    const tail = latin1Bytes('\nendobj\n');
    entries.push({ num: ref.objectNumber, gen: ref.generationNumber, offset, free: false });
    parts.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  }
  for (const ref of deleted) entries.push({ num: ref.objectNumber, gen: ref.generationNumber + 1, offset: 0, free: true });

  const t = ctx.trailerInfo;
  const size = Math.max(ctx.largestObjectNumber + 1, ...entries.map((e) => e.num + 1));
  const xrefOffset = offset;

  if (tracker.usesXrefStream) {
    const xrefNum = size;
    entries.push({ num: xrefNum, gen: 0, offset: xrefOffset, free: false });
    entries.sort((a, b) => a.num - b.num);
    const rows: number[] = [];
    const index: number[] = [];
    let i = 0;
    while (i < entries.length) {
      let j = i;
      while (j + 1 < entries.length && entries[j + 1].num === entries[j].num + 1) j++;
      index.push(entries[i].num, j - i + 1);
      for (let k = i; k <= j; k++) {
        const e = entries[k];
        rows.push(e.free ? 0 : 1, (e.offset >>> 24) & 0xff, (e.offset >>> 16) & 0xff, (e.offset >>> 8) & 0xff, e.offset & 0xff, (e.gen >> 8) & 0xff, e.gen & 0xff);
      }
      i = j + 1;
    }
    const data = pako.deflate(Uint8Array.from(rows));
    const dict = ctx.obj({ Type: 'XRef', Size: xrefNum + 1, W: [1, 4, 2], Index: index, Filter: 'FlateDecode', Length: data.length, Prev: tracker.startxref }) as PDFDict;
    if (t.Root) dict.set(PDFName.of('Root'), t.Root as PDFObject);
    if (t.Info) dict.set(PDFName.of('Info'), t.Info as PDFObject);
    if (t.ID) dict.set(PDFName.of('ID'), t.ID as PDFObject);
    const stream = PDFRawStream.of(dict, data);
    parts.push(latin1Bytes(`${xrefNum} 0 obj\n`), serialize(stream), latin1Bytes(`\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`));
    return concatBytes(parts);
  }

  entries.sort((a, b) => a.num - b.num);
  let xref = 'xref\n';
  let i = 0;
  // Always include the free head entry for object 0 when starting a section at 0.
  while (i < entries.length) {
    let j = i;
    while (j + 1 < entries.length && entries[j + 1].num === entries[j].num + 1) j++;
    xref += `${entries[i].num} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) {
      const e = entries[k];
      xref += `${String(e.offset).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} ${e.free ? 'f' : 'n'}\r\n`;
    }
    i = j + 1;
  }
  const trailer = ctx.obj({ Size: size, Prev: tracker.startxref }) as PDFDict;
  if (t.Root) trailer.set(PDFName.of('Root'), t.Root as PDFObject);
  if (t.Info) trailer.set(PDFName.of('Info'), t.Info as PDFObject);
  if (t.ID) trailer.set(PDFName.of('ID'), t.ID as PDFObject);
  xref += `trailer\n${trailer.toString()}\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(latin1Bytes(xref));
  return concatBytes(parts);
}

/**
 * Full save that omits unreachable objects (left behind by undo history),
 * without disturbing the in-memory document.
 */
export async function saveFull(doc: PDFDocument, opts: { useObjectStreams?: boolean } = {}): Promise<Uint8Array> {
  const ctx = doc.context;
  const reach = reachableRefs(ctx);
  const removed: [PDFRef, PDFObject][] = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!reach.has(refKey(ref))) removed.push([ref, obj]);
  }
  // Unreachable objects and unused numbers become tiny `null` objects so the
  // cross-reference table stays contiguous (strict readers walk every number < /Size).
  const filled: PDFRef[] = [];
  for (const [ref] of removed) ctx.assign(ref, PDFNull);
  const present = new Set(Array.from(ctx.enumerateIndirectObjects(), ([r]) => r.objectNumber));
  for (let n = 1; n <= ctx.largestObjectNumber; n++) {
    if (present.has(n)) continue;
    const ref = PDFRef.of(n, 0);
    ctx.assign(ref, PDFNull);
    filled.push(ref);
  }
  try {
    return await doc.save({ useObjectStreams: opts.useObjectStreams ?? false, addDefaultPage: false, updateFieldAppearances: false });
  } finally {
    for (const ref of filled) ctx.delete(ref);
    for (const [ref, obj] of removed) ctx.assign(ref, obj);
  }
}
