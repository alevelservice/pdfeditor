/**
 * Page-level operations built on pdf-lib's page tree support.
 */
import { degrees, PDFArray, PDFDict, PDFDocument, PDFName, PDFPage, PDFPageLeaf, PDFRef } from 'pdf-lib';
import { asDict, cloneDict, lookup, N } from './objects';

export function pageIndexOf(doc: PDFDocument, ref: PDFRef): number {
  return doc.getPages().findIndex((p) => p.ref === ref || (p.ref.objectNumber === ref.objectNumber && p.ref.generationNumber === ref.generationNumber));
}

/** All Pages-tree node refs (for undo snapshots of structural changes). */
export function pageTreeRefs(doc: PDFDocument): PDFRef[] {
  const ctx = doc.context;
  const out: PDFRef[] = [];
  const rootRef = doc.catalog.get(N('Pages'));
  const visit = (ref: unknown, depth: number) => {
    if (!(ref instanceof PDFRef) || depth > 64) return;
    out.push(ref);
    const node = asDict(ctx.lookup(ref));
    const kids = node ? lookup(ctx, node.get(N('Kids'))) : undefined;
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) visit(kids.get(i), depth + 1);
  };
  visit(rootRef, 0);
  const catRef = ctx.trailerInfo.Root;
  if (catRef instanceof PDFRef) out.push(catRef);
  return out;
}

/** pdf-lib caches pages and the page count; removePage() (1.17.1) does not invalidate the cache. */
export function invalidatePageCache(doc: PDFDocument) {
  const d = doc as unknown as { pageCache?: { invalidate(): void }; pageCount?: number };
  d.pageCache?.invalidate();
  d.pageCount = undefined;
}

export function movePage(doc: PDFDocument, from: number, to: number) {
  const page = doc.getPage(from);
  doc.removePage(from);
  invalidatePageCache(doc);
  doc.insertPage(Math.max(0, Math.min(to, doc.getPageCount())), page);
}

export function rotatePage(page: PDFPage, delta: number) {
  const cur = page.getRotation().angle;
  page.setRotation(degrees((((cur + delta) % 360) + 360) % 360));
}

export function deletePages(doc: PDFDocument, indices: number[]) {
  if (indices.length >= doc.getPageCount()) throw new Error('A document must keep at least one page');
  for (const i of [...indices].sort((a, b) => b - a)) {
    doc.removePage(i);
    invalidatePageCache(doc);
  }
}

/** Duplicate a page sharing its (immutable) content and resources. */
export function duplicatePage(doc: PDFDocument, index: number): PDFRef {
  const ctx = doc.context;
  const src = doc.getPage(index);
  const newLeaf = PDFPageLeaf.fromMapWithContext(new Map(src.node.entries()), ctx);
  const ref = ctx.register(newLeaf);
  // Inheritable attributes must be explicit (the new leaf may get a different parent).
  for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
    const v = src.node.getInheritableAttribute(N(key));
    if (v && !newLeaf.get(N(key))) newLeaf.set(N(key), v);
  }
  // Annotations cannot be shared between pages; copy non-widget ones.
  const annots = lookup(ctx, src.node.get(N('Annots')));
  if (annots instanceof PDFArray) {
    const copy = ctx.obj([]) as PDFArray;
    for (let i = 0; i < annots.size(); i++) {
      const a = asDict(lookup(ctx, annots.get(i)));
      if (!a) continue;
      const st = a.get(N('Subtype'));
      if (st instanceof PDFName && (st.decodeText() === 'Widget' || st.decodeText() === 'Popup')) continue;
      const na = cloneDict(ctx, a);
      na.set(N('P'), ref);
      na.delete(N('Popup'));
      copy.push(ctx.register(na));
    }
    newLeaf.set(N('Annots'), copy);
  }
  const page = PDFPage.of(newLeaf, ref, doc);
  doc.insertPage(index + 1, page);
  return ref;
}

export function insertBlankPage(doc: PDFDocument, index: number, size: [number, number]): PDFRef {
  const page = doc.insertPage(index, size);
  return page.ref;
}

export async function extractPages(doc: PDFDocument, indices: number[]): Promise<Uint8Array> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const pages = await out.copyPages(doc, indices);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

export { parseRange } from './ranges';
import { parseRange } from './ranges';

export async function splitDocument(doc: PDFDocument, ranges: string[]): Promise<Uint8Array[]> {
  const count = doc.getPageCount();
  const out: Uint8Array[] = [];
  for (const r of ranges) {
    const idx = parseRange(r, count);
    if (idx.length) out.push(await extractPages(doc, idx));
  }
  return out;
}

/** Insert pages of another PDF at `index` (all pages by default). Returns new page refs. */
export async function insertFromPdf(doc: PDFDocument, bytes: Uint8Array, index: number, range?: string): Promise<PDFRef[]> {
  const other = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false });
  const indices = range ? parseRange(range, other.getPageCount()) : other.getPageIndices();
  const copied = await doc.copyPages(other, indices);
  copied.forEach((p, k) => doc.insertPage(index + k, p));
  return copied.map((p) => p.ref);
}

export function setPageBox(leaf: PDFDict, doc: PDFDocument, box: 'MediaBox' | 'CropBox' | 'TrimBox' | 'BleedBox', rect: [number, number, number, number]) {
  leaf.set(N(box), doc.context.obj(rect));
}
