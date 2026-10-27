/**
 * Undo / redo using the command pattern.
 *
 * Two command kinds:
 *  - SnapshotCommand: captures the entries of a set of indirect dictionaries
 *    (page leaves, page-tree nodes, form fields, Info...) before and after a
 *    mutation. Because edits never mutate shared objects in place (see
 *    objects.ts), restoring those dictionaries restores the document state.
 *    Snapshots address objects by reference number and deep-copy direct
 *    values, so they stay valid after the document is reloaded from bytes.
 *  - BytesCommand: whole-document operations (merge, OCR, compress,
 *    encryption...) store serialized bytes before and after.
 */
import { PDFArray, PDFContext, PDFDict, PDFName, PDFObject, PDFRef, PDFStream } from 'pdf-lib';
import { refKey } from './objects';

type Entries = [string, PDFObject][];

export interface ObjSnapshot {
  ref: PDFRef;
  kind: 'dict' | 'array' | 'missing';
  entries?: Entries;
  items?: PDFObject[];
}

/** Deep-copy direct containers into `ctx` (refs and primitives are shared). */
export function rehome(v: PDFObject, ctx: PDFContext): PDFObject {
  if (v instanceof PDFDict && !(v instanceof PDFStream)) {
    const d = ctx.obj({}) as PDFDict;
    for (const [k, x] of v.entries()) d.set(k, rehome(x, ctx));
    return d;
  }
  if (v instanceof PDFArray) {
    const a = ctx.obj([]) as PDFArray;
    for (let i = 0; i < v.size(); i++) a.push(rehome(v.get(i), ctx));
    return a;
  }
  return v;
}

export function capture(ctx: PDFContext, refs: PDFRef[]): ObjSnapshot[] {
  const seen = new Set<string>();
  const out: ObjSnapshot[] = [];
  for (const ref of refs) {
    const k = refKey(ref);
    if (seen.has(k)) continue;
    seen.add(k);
    const o = ctx.lookup(ref);
    if (o instanceof PDFDict) {
      out.push({ ref, kind: 'dict', entries: o.entries().map(([key, v]) => [key.decodeText(), rehome(v, ctx)]) });
    } else if (o instanceof PDFArray) {
      const items: PDFObject[] = [];
      for (let i = 0; i < o.size(); i++) items.push(rehome(o.get(i), ctx));
      out.push({ ref, kind: 'array', items });
    } else out.push({ ref, kind: 'missing' });
  }
  return out;
}

export function restore(ctx: PDFContext, snaps: ObjSnapshot[]) {
  for (const s of snaps) {
    const o = ctx.lookup(s.ref);
    if (s.kind === 'dict') {
      let d = o instanceof PDFDict ? o : null;
      if (!d) {
        d = ctx.obj({}) as PDFDict;
        ctx.assign(s.ref, d);
      }
      for (const k of d.keys()) d.delete(k);
      for (const [k, v] of s.entries!) d.set(PDFName.of(k), rehome(v, ctx));
    } else if (s.kind === 'array') {
      let a = o instanceof PDFArray ? o : null;
      if (!a) {
        a = ctx.obj([]) as PDFArray;
        ctx.assign(s.ref, a);
      }
      while (a.size()) a.remove(0);
      for (const v of s.items!) a.push(rehome(v, ctx));
    }
  }
}

export interface SnapshotCommand {
  kind: 'snapshot';
  label: string;
  before: ObjSnapshot[];
  after: ObjSnapshot[];
  /** Page leaf keys whose rendering changed. */
  pages: string[];
  structural: boolean;
}

export interface BytesCommand {
  kind: 'bytes';
  label: string;
  before: Uint8Array;
  after: Uint8Array;
}

export type Command = SnapshotCommand | BytesCommand;

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  /** Soft cap on memory held by byte snapshots (oldest byte commands are dropped first). */
  maxBytes = 1024 * 1024 * 1024;

  push(cmd: Command) {
    this.undoStack.push(cmd);
    this.redoStack = [];
    this.trim();
  }

  private trim() {
    let total = 0;
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      const c = this.undoStack[i];
      if (c.kind === 'bytes') {
        total += c.before.length + c.after.length;
        if (total > this.maxBytes) {
          // Everything older than this point can no longer be undone safely.
          this.undoStack = this.undoStack.slice(i + 1);
          break;
        }
      }
    }
  }

  popUndo(): Command | undefined {
    const c = this.undoStack.pop();
    if (c) this.redoStack.push(c);
    return c;
  }

  popRedo(): Command | undefined {
    const c = this.redoStack.pop();
    if (c) this.undoStack.push(c);
    return c;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get undoLabel() {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }
  get redoLabel() {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }
  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}
