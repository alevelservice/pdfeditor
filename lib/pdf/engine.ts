/**
 * PdfEngine: owns the working document and exposes every editing operation.
 * It runs inside a Web Worker in the app (see workers/engine.worker.ts) and
 * directly in Node for tests.
 */
import { PDFDocument, PDFDict, PDFFont, PDFPage, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { FontCache } from './fontinfo';
import { FontManager, type FontLoader } from './fonts';
import type { Shaper } from './shaping';
import type { Subsetter } from './subset';
import { PageInterpreter, type InternalTextRun, type ParsedPage } from './parser';
import { groupBlocks, groupLines } from './layout';
import { PageEditor } from './writer';
import { addTextBox, deleteRuns, editBlock, editLine, editRun, recolorRuns, transformRuns, type NewTextBox, type TextEditEnv } from './textedit';
import { capture, History, restore, type Command } from './history';
import { ChangeTracker, saveFull, saveIncremental } from './incremental';
import { asDict, dictGet, N, pageContentBytes, pageResources, rectArray, refKey } from './objects';
import { invert, apply, mul, unionRect } from './geom';
import {
  decodeToRGBA,
  embedNewImage,
  encodePNG,
  extractImage,
  inlineToStream,
  insertImageOps,
  paintImageRegions,
  pageRectToPixels,
  replaceImageOps,
  wrapImageOp,
  type ImageCodec,
} from './images';
import { deletePath, reorderObject, shapeOps, stylePath, transformPath, type PathStyle } from './vector';
import {
  deletePages as deletePagesOp,
  duplicatePage as duplicatePageOp,
  extractPages as extractPagesOp,
  insertBlankPage,
  insertFromPdf,
  invalidatePageCache,
  movePage as movePageOp,
  pageTreeRefs,
  parseRange,
  rotatePage,
  setPageBox as setPageBoxOp,
  splitDocument,
} from './pages';
import { createAnnotation, flattenAnnotations, listAnnotations, removeAnnotation, updateAnnotation, writableAnnots, type AnnotationPatch, type AnnotationSpec } from './annotations';
import { clearAcroForm, createField, formRefs, hasForm, listFields, removeField, setFieldValue, updateAllAppearances, type NewFieldSpec } from './forms';
import { redactPage, type RedactStats } from './redact';
import { applyStamp, ocrTextOps, textLineOps } from './stamps';
import { estimateBackground } from './ocr';
import { compressStructure, decrypt, encrypt, PasswordRequiredError, repair, type EncryptOptions, type MupdfLoader } from './security';
import { buildDocx, type DocxImage } from './exporters';
import { inlineFormXObject } from './forminline';
import type {
  DocInfo,
  DocMetadata,
  EditResult,
  FitMode,
  FormField,
  Matrix,
  NewImage,
  OcrPageResult,
  PageInfo,
  PageModel,
  Rect,
  RenderSource,
  RGB,
  SearchHit,
  SearchOptions,
  ShapeSpec,
  StampOptions,
  TextRun,
  TextStyle,
} from './types';

export interface EngineOptions {
  fontLoader?: FontLoader | null;
  shaper?: Shaper | null;
  mupdf?: MupdfLoader | null;
  codec?: ImageCodec | null;
  subsetter?: Subsetter | null;
}

export interface SaveOptions {
  incremental?: boolean;
  compress?: boolean;
  /** Recompress images larger than this (pixels on the long side) when compressing. */
  maxImageDimension?: number;
  jpegQuality?: number;
  encrypt?: EncryptOptions;
}

interface Cached {
  version: number;
  parsed: ParsedPage;
  model: PageModel;
}

const uidOf = (ref: PDFRef) => refKey(ref);

function sanitizeRun(r: InternalTextRun): TextRun {
  const { pdfFont: _f, runGlyphs: _g, fontResName: _n, opType: _o, formPath: _p, ...rest } = r;
  void _f; void _g; void _n; void _o; void _p;
  return rest;
}

export class PdfEngine {
  private doc!: PDFDocument;
  private tracker: ChangeTracker | null = null;
  private history = new History();
  private fontCache!: FontCache;
  private fonts!: FontManager;
  private cache = new Map<string, Cached>();
  private versions = new Map<string, number>();
  private base = new Uint8Array();
  private baseVersion = 0;
  private baseIndex = new Map<string, number>();
  private dirty = new Set<string>();
  private previews = new Map<string, Uint8Array>();
  private wasEncrypted = false;
  private formFonts = new Map<string, PDFFont>();
  private fileName = 'document.pdf';

  constructor(private opts: EngineOptions = {}) {}

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  async open(bytes: Uint8Array, opts: { password?: string; name?: string } = {}): Promise<DocInfo> {
    this.fileName = opts.name ?? this.fileName;
    let data = bytes;
    let doc: PDFDocument;
    let incremental = true;
    this.wasEncrypted = false;
    try {
      doc = await PDFDocument.load(data, { updateMetadata: false });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      const encrypted = /encrypt/i.test(msg);
      if (!this.opts.mupdf) {
        if (encrypted) throw new Error('This PDF is encrypted. Decryption requires the mupdf engine, which is not available.');
        throw e;
      }
      const m = await this.opts.mupdf();
      data = encrypted ? await decrypt(m, bytes, opts.password) : await repair(m, bytes, opts.password);
      doc = await PDFDocument.load(data, { updateMetadata: false });
      this.wasEncrypted = encrypted;
      incremental = false;
    }
    this.history.clear();
    this.setDocument(doc, data, incremental);
    return this.info();
  }

  private setDocument(doc: PDFDocument, bytes: Uint8Array, incremental: boolean) {
    this.doc = doc;
    reserveObjectNumbers(doc, bytes);
    doc.registerFontkit(fontkit);
    this.fontCache = new FontCache(doc.context);
    this.fonts = new FontManager(doc.context, this.opts.fontLoader ?? null, this.opts.shaper ?? null, this.opts.subsetter ?? null);
    this.formFonts.clear();
    if (incremental) this.tracker = new ChangeTracker(doc, bytes);
    this.resetBase(bytes);
  }

  private resetBase(bytes: Uint8Array) {
    this.base = bytes;
    this.baseVersion++;
    this.baseIndex.clear();
    this.doc.getPages().forEach((p, i) => this.baseIndex.set(uidOf(p.ref), i));
    this.dirty.clear();
    this.cache.clear();
    this.previews.clear();
  }

  getBaseBytes(): { baseVersion: number; bytes: Uint8Array } {
    return { baseVersion: this.baseVersion, bytes: this.base };
  }

  registerFont(family: string, bytes: Uint8Array) {
    this.fonts.registerCustomFont(family, bytes);
  }

  // -------------------------------------------------------------------------
  // Info & models
  // -------------------------------------------------------------------------

  private refOf(uid: string): PDFRef {
    const [n, g] = uid.split('_').map(Number);
    return PDFRef.of(n, g);
  }

  private pages(): PDFPage[] {
    return this.doc.getPages();
  }

  private page(uid: string): { page: PDFPage; index: number } {
    const pages = this.pages();
    const index = pages.findIndex((p) => uidOf(p.ref) === uid);
    if (index < 0) throw new Error(`Page ${uid} not found`);
    return { page: pages[index], index };
  }

  private leaf(uid: string): PDFDict {
    return this.page(uid).page.node;
  }

  private pageInfo(page: PDFPage, index: number): PageInfo {
    const ctx = this.doc.context;
    const node = page.node;
    const media = rectArray(ctx, node.getInheritableAttribute(N('MediaBox')), [0, 0, 612, 792]);
    const crop = rectArray(ctx, node.getInheritableAttribute(N('CropBox')), media);
    const view: [number, number, number, number] = [
      Math.max(media[0], crop[0]), Math.max(media[1], crop[1]),
      Math.min(media[2], crop[2]), Math.min(media[3], crop[3]),
    ];
    if (view[2] <= view[0] || view[3] <= view[1]) view.splice(0, 4, ...media);
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const w = view[2] - view[0];
    const h = view[3] - view[1];
    const uid = uidOf(page.ref);
    return {
      uid,
      index,
      view,
      mediaBox: media,
      cropBox: crop,
      rotation,
      width: rotation % 180 === 0 ? w : h,
      height: rotation % 180 === 0 ? h : w,
      version: this.versions.get(uid) ?? 0,
    };
  }

  info(): DocInfo {
    const pages = this.pages();
    return {
      pageCount: pages.length,
      pages: pages.map((p, i) => this.pageInfo(p, i)),
      metadata: this.getMetadata(),
      hasForm: hasForm(this.doc),
      wasEncrypted: this.wasEncrypted,
      baseVersion: this.baseVersion,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      undoLabel: this.history.undoLabel,
      redoLabel: this.history.redoLabel,
      canIncrementalSave: !!this.tracker,
    };
  }

  private parse(uid: string): Cached {
    const version = this.versions.get(uid) ?? 0;
    const c = this.cache.get(uid);
    if (c && c.version === version) return c;
    const { page, index } = this.page(uid);
    const ctx = this.doc.context;
    const interp = new PageInterpreter(ctx, this.fontCache);
    let parsed: ParsedPage;
    try {
      parsed = interp.parsePage(pageContentBytes(ctx, page.node), pageResources(ctx, page.node));
    } catch (e) {
      parsed = { stream: { ops: [], source: new Uint8Array(), warnings: [] }, texts: [], images: [], paths: [], forms: [], end: { depth: 0, ctm: [1, 0, 0, 1, 0, 0] }, warnings: [`Page could not be parsed: ${(e as Error).message}`], degraded: true };
    }
    const texts = parsed.texts.map(sanitizeRun);
    const lines = groupLines(texts);
    const blocks = groupBlocks(lines);
    const pageRefs = this.pages().map((p) => p.ref);
    const model: PageModel = {
      uid,
      version,
      info: this.pageInfo(page, index),
      texts,
      lines,
      blocks,
      images: parsed.images.map(({ ref: _r, stream: _s, formPath: _f, ...rest }) => (void _r, void _s, void _f, rest)),
      paths: parsed.paths.map(({ formPath: _f, ...rest }) => (void _f, rest)),
      annotations: listAnnotations(this.doc, page.node, pageRefs),
      warnings: parsed.warnings.slice(0, 50),
      degraded: parsed.degraded,
    };
    const entry = { version, parsed, model };
    this.cache.set(uid, entry);
    return entry;
  }

  getPageModel(uid: string): PageModel {
    return this.parse(uid).model;
  }

  async getRenderSource(uid: string): Promise<RenderSource> {
    if (!this.dirty.has(uid) && this.baseIndex.has(uid)) return { kind: 'base', baseVersion: this.baseVersion, index: this.baseIndex.get(uid)! };
    const key = `${uid}@${this.versions.get(uid) ?? 0}`;
    let bytes = this.previews.get(key);
    if (!bytes) {
      const { index } = this.page(uid);
      const preview = await PDFDocument.create({ updateMetadata: false });
      const [p] = await preview.copyPages(this.doc, [index]);
      preview.addPage(p);
      bytes = await preview.save({ useObjectStreams: false });
      if (this.previews.size > 64) this.previews.delete(this.previews.keys().next().value!);
      this.previews.set(key, bytes);
    }
    return { kind: 'preview', bytes };
  }

  // -------------------------------------------------------------------------
  // Commands & history
  // -------------------------------------------------------------------------

  private touch(uids: Iterable<string>) {
    for (const u of uids) {
      this.versions.set(u, (this.versions.get(u) ?? 0) + 1);
      this.dirty.add(u);
    }
  }

  private allPageUids(): string[] {
    return this.pages().map((p) => uidOf(p.ref));
  }

  private allLeafRefs(): PDFRef[] {
    return this.pages().map((p) => p.ref);
  }

  /**
   * Run a mutation as one undoable command. `uids` are pages whose leaf
   * dictionaries change; `extra` returns additional dictionaries to snapshot.
   */
  private async command<T>(label: string, uids: string[], fn: () => Promise<T> | T, o: { structural?: boolean; extra?: () => PDFRef[] } = {}): Promise<T> {
    const ctx = this.doc.context;
    const refsBefore = [...uids.map((u) => this.refOf(u)), ...(o.structural ? [...pageTreeRefs(this.doc), ...this.allLeafRefs()] : []), ...(o.extra?.() ?? [])];
    const before = capture(ctx, refsBefore);
    let result: T;
    try {
      result = await fn();
      if (o.structural) invalidatePageCache(this.doc);
      await this.doc.flush();
      await this.fonts.finalizeAll();
    } catch (e) {
      restore(ctx, before);
      if (o.structural) invalidatePageCache(this.doc);
      this.cache.clear();
      throw e;
    }
    const refsAfter = [...refsBefore, ...(o.structural ? [...pageTreeRefs(this.doc), ...this.allLeafRefs()] : []), ...(o.extra?.() ?? [])];
    const after = capture(ctx, refsAfter);
    const pages = o.structural ? Array.from(new Set([...uids, ...this.allPageUids()])) : uids;
    this.history.push({ kind: 'snapshot', label, before, after, pages, structural: !!o.structural });
    this.touch(pages);
    if (o.structural) this.cache.clear();
    return result;
  }

  private async applyCommand(cmd: Command, dir: 'undo' | 'redo') {
    if (cmd.kind === 'bytes') {
      const bytes = dir === 'undo' ? cmd.before : cmd.after;
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      const tracker = this.tracker;
      this.setDocument(doc, bytes, false);
      this.tracker = tracker;
      return;
    }
    restore(this.doc.context, dir === 'undo' ? cmd.before : cmd.after);
    if (cmd.structural) invalidatePageCache(this.doc);
    this.cache.clear();
    this.touch(cmd.structural ? Array.from(new Set([...cmd.pages, ...this.allPageUids()])) : cmd.pages);
  }

  async undo(): Promise<DocInfo> {
    const c = this.history.popUndo();
    if (c) await this.applyCommand(c, 'undo');
    return this.info();
  }

  async redo(): Promise<DocInfo> {
    const c = this.history.popRedo();
    if (c) await this.applyCommand(c, 'redo');
    return this.info();
  }

  /** Edit one page's content stream as a command. */
  private async editPage(label: string, uid: string, fn: (ed: PageEditor, parsed: ParsedPage, env: TextEditEnv) => Promise<Partial<EditResult> | void>): Promise<EditResult> {
    return this.command(label, [uid], async () => {
      const parsed = this.parse(uid).parsed;
      const leaf = this.leaf(uid);
      const editor = new PageEditor(this.doc.context, leaf, parsed);
      const env: TextEditEnv = { editor, fonts: this.fonts, runs: new Map(parsed.texts.map((t) => [t.id, t])), warnings: [] };
      const r = (await fn(editor, parsed, env)) || {};
      if (editor.dirty) editor.commit();
      const warnings = [
        ...env.warnings.map((w) => `${w.reason} (${w.original} → ${w.substitute})`),
        ...editor.warnings,
        ...(r.warnings ?? []),
      ];
      return { warnings: Array.from(new Set(warnings)), focus: r.focus };
    });
  }

  // -------------------------------------------------------------------------
  // Object lookup helpers
  // -------------------------------------------------------------------------

  /** Resolve text ids (block b*, line l*, run t*) into runs. */
  private resolveRuns(uid: string, ids: string[]): InternalTextRun[] {
    const { parsed, model } = this.parse(uid);
    const byId = new Map(parsed.texts.map((t) => [t.id, t]));
    const out: InternalTextRun[] = [];
    for (const id of ids) {
      if (id.startsWith('b')) {
        const b = model.blocks.find((x) => x.id === id);
        b?.lineIds.forEach((lid) => model.lines.find((l) => l.id === lid)?.runIds.forEach((r) => out.push(byId.get(r)!)));
      } else if (id.startsWith('l')) {
        model.lines.find((l) => l.id === id)?.runIds.forEach((r) => out.push(byId.get(r)!));
      } else if (id.startsWith('t')) {
        const r = byId.get(id);
        if (r) out.push(r);
      }
    }
    return Array.from(new Set(out.filter(Boolean)));
  }

  private runsBBox(runs: { bbox: Rect }[]): Rect | undefined {
    let r: Rect | null = null;
    for (const x of runs) r = unionRect(r, x.bbox);
    return r ?? undefined;
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  async editLine(uid: string, lineId: string, text: string, style?: TextStyle): Promise<EditResult> {
    const line = this.parse(uid).model.lines.find((l) => l.id === lineId);
    if (!line) throw new Error('Line not found');
    return this.editPage('Edit text', uid, async (_ed, _p, env) => {
      await editLine(env, line, text, style);
      return { focus: { pageUid: uid, rect: line.bbox, kind: 'text' } };
    });
  }

  async editBlock(uid: string, blockId: string, text: string, style?: TextStyle, reflow = false): Promise<EditResult> {
    const { model } = this.parse(uid);
    const block = model.blocks.find((b) => b.id === blockId);
    if (!block) throw new Error('Text block not found');
    const lines = block.lineIds.map((id) => model.lines.find((l) => l.id === id)!).filter(Boolean);
    return this.editPage(reflow ? 'Edit paragraph' : 'Edit text', uid, async (_ed, _p, env) => {
      await editBlock(env, block, lines, text, style, reflow);
      return { focus: { pageUid: uid, rect: block.bbox, kind: 'text' } };
    });
  }

  async editRunText(uid: string, runId: string, text: string, style?: TextStyle): Promise<EditResult> {
    const [run] = this.resolveRuns(uid, [runId]);
    if (!run) throw new Error('Text run not found');
    return this.editPage('Edit text', uid, async (_ed, _p, env) => {
      await editRun(env, run, text, style);
      return { focus: { pageUid: uid, rect: run.bbox, kind: 'text' } };
    });
  }

  /** Apply a style to whole lines/blocks keeping their text. */
  async setTextStyle(uid: string, ids: string[], style: TextStyle): Promise<EditResult> {
    const { model } = this.parse(uid);
    const lineIds = new Set<string>();
    for (const id of ids) {
      if (id.startsWith('b')) model.blocks.find((b) => b.id === id)?.lineIds.forEach((l) => lineIds.add(l));
      else if (id.startsWith('l')) lineIds.add(id);
      else if (id.startsWith('t')) model.lines.filter((l) => l.runIds.includes(id)).forEach((l) => lineIds.add(l.id));
    }
    const lines = model.lines.filter((l) => lineIds.has(l.id));
    const onlyColor = Object.keys(style).every((k) => k === 'color') && style.color;
    return this.editPage('Text style', uid, async (_ed, _p, env) => {
      if (onlyColor) {
        recolorRuns(env, this.resolveRuns(uid, lines.map((l) => l.id)), style.color!);
      } else {
        // Paragraph-level properties (line height / alignment) reflow the block.
        const blockIds = ids.filter((i) => i.startsWith('b'));
        if ((style.lineHeight !== undefined || style.align !== undefined) && blockIds.length) {
          for (const bid of blockIds) {
            const b = model.blocks.find((x) => x.id === bid)!;
            const bl = b.lineIds.map((id) => model.lines.find((l) => l.id === id)!);
            await editBlock(env, b, bl, bl.map((l) => l.text).join(' '), style, true);
          }
        } else for (const l of lines) await editLine(env, l, l.text, style);
      }
      return { focus: { pageUid: uid, rect: this.runsBBox(lines.map((l) => ({ bbox: l.bbox })))!, kind: 'text' } };
    });
  }

  async addText(uid: string, box: NewTextBox): Promise<EditResult> {
    return this.editPage('Add text', uid, async (_ed, _p, env) => {
      const rect = await addTextBox(env, box);
      return { focus: { pageUid: uid, rect, kind: 'text' } };
    });
  }

  /** Delete text blocks/lines/runs, images, paths and annotations by id. */
  async deleteObjects(uid: string, ids: string[]): Promise<EditResult> {
    const { parsed } = this.parse(uid);
    const runs = this.resolveRuns(uid, ids);
    const images = parsed.images.filter((i) => ids.includes(i.id));
    const paths = parsed.paths.filter((p) => ids.includes(p.id));
    const annots = ids.filter((i) => i.startsWith('a')).map((i) => Number(i.slice(1))).sort((a, b) => b - a);
    return this.editPage('Delete', uid, async (editor, _p, env) => {
      deleteRuns(env, runs);
      for (const im of images) {
        if (!im.editable) throw new Error(`Image is not editable: ${im.readOnlyReason}`);
        editor.replace(im.opIndex, []);
      }
      for (const p of paths) deletePath(editor, p);
      for (const a of annots) removeAnnotation(this.doc.context, editor.leaf, a);
    });
  }

  /** Transform objects by D (page space; new = old × D). */
  async transformObjects(uid: string, ids: string[], D: Matrix): Promise<EditResult> {
    const { parsed, model } = this.parse(uid);
    const runs = this.resolveRuns(uid, ids);
    const images = parsed.images.filter((i) => ids.includes(i.id));
    const paths = parsed.paths.filter((p) => ids.includes(p.id));
    const annots = model.annotations.filter((a) => ids.includes(a.id));
    return this.editPage('Move / transform', uid, async (editor, _p, env) => {
      transformRuns(env, runs, D);
      for (const im of images) {
        if (!im.editable) throw new Error(`Image is not editable: ${im.readOnlyReason}`);
        wrapImageOp(editor, im, { D });
      }
      for (const p of paths) transformPath(editor, p, D);
      for (const a of annots) {
        const p0 = apply(D, a.rect.x, a.rect.y);
        const p1 = apply(D, a.rect.x + a.rect.width, a.rect.y + a.rect.height);
        updateAnnotation(this.doc, editor.leaf, a.index, { rect: { x: Math.min(p0[0], p1[0]), y: Math.min(p0[1], p1[1]), width: Math.abs(p1[0] - p0[0]), height: Math.abs(p1[1] - p0[1]) } });
      }
    });
  }

  async reorderObject(uid: string, id: string, where: 'front' | 'back' | 'forward' | 'backward'): Promise<EditResult> {
    const { parsed } = this.parse(uid);
    const obj = parsed.images.find((i) => i.id === id) ?? parsed.paths.find((p) => p.id === id) ?? this.resolveRuns(uid, [id])[0];
    if (!obj) throw new Error('Object not found');
    const runs = id.startsWith('b') || id.startsWith('l') ? this.resolveRuns(uid, [id]) : null;
    return this.editPage('Arrange', uid, async (editor) => {
      if (runs && runs.length > 1) {
        // Move all runs of a block; apply in reverse for 'back' so their relative order is kept.
        const list = where === 'back' ? [...runs].reverse() : runs;
        for (const r of list) reorderObject(editor, parsed, r, where);
      } else reorderObject(editor, parsed, obj, where);
    });
  }

  async inlineForm(uid: string, formIndex: number): Promise<EditResult> {
    const { parsed } = this.parse(uid);
    const form = parsed.forms.find((f) => f.opIndex === formIndex && f.formPath.length === 0);
    if (!form) throw new Error('Form XObject not found');
    return this.editPage('Make editable', uid, async (editor) => {
      inlineFormXObject(this.doc.context, editor, pageResources(this.doc.context, editor.leaf), form);
    });
  }

  /** Find which top-level form XObject contains an object (for "Make editable"). */
  formContaining(uid: string, objectId: string): number | null {
    const m = /^f([\d.]+)\//.exec(objectId);
    if (!m) return null;
    return Number(m[1].split('.')[0]);
  }

  // -------------------------------------------------------------------------
  // Search & replace
  // -------------------------------------------------------------------------

  private makeRegex(o: SearchOptions): RegExp {
    let src = o.regex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (o.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    return new RegExp(src, `g${o.matchCase ? '' : 'i'}u`);
  }

  private hitBBox(model: PageModel, lineId: string, start: number, end: number): Rect {
    const line = model.lines.find((l) => l.id === lineId)!;
    const runs = new Map(model.texts.map((t) => [t.id, t]));
    let r: Rect | null = null;
    for (const span of line.runSpans) {
      if (span.end <= start || span.start >= end) continue;
      const run = runs.get(span.runId)!;
      let off = span.start;
      for (const g of run.glyphs) {
        const gEnd = off + g.text.length;
        if (gEnd > start && off < end) r = unionRect(r, g.bbox);
        off = gEnd;
      }
    }
    return r ?? line.bbox;
  }

  async search(o: SearchOptions): Promise<SearchHit[]> {
    if (!o.query) return [];
    const re = this.makeRegex(o);
    const hits: SearchHit[] = [];
    const pages = this.pages();
    for (let i = 0; i < pages.length; i++) {
      const uid = uidOf(pages[i].ref);
      const model = this.parse(uid).model;
      for (const line of model.lines) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line.text))) {
          if (!m[0].length) {
            re.lastIndex++;
            continue;
          }
          hits.push({
            pageUid: uid,
            pageIndex: i,
            lineId: line.id,
            start: m.index,
            end: m.index + m[0].length,
            text: m[0],
            context: line.text,
            bbox: this.hitBBox(model, line.id, m.index, m.index + m[0].length),
          });
          if (hits.length > 5000) return hits;
        }
      }
    }
    return hits;
  }

  /** Replace every match; rewrites the content streams of all affected pages in one undo step. */
  async replaceAll(o: SearchOptions, replacement: string): Promise<{ count: number; warnings: string[] }> {
    const hits = await this.search(o);
    const byPage = new Map<string, Set<string>>();
    for (const h of hits) {
      if (!byPage.has(h.pageUid)) byPage.set(h.pageUid, new Set());
      byPage.get(h.pageUid)!.add(h.lineId);
    }
    const re = this.makeRegex(o);
    const warnings: string[] = [];
    let count = 0;
    const uids = [...byPage.keys()];
    const models = new Map(uids.map((u) => [u, this.parse(u)]));
    await this.command(`Replace all "${o.query}"`, uids, async () => {
      for (const uid of uids) {
        const { parsed, model } = models.get(uid)!;
        const editor = new PageEditor(this.doc.context, this.leaf(uid), parsed);
        const env: TextEditEnv = { editor, fonts: this.fonts, runs: new Map(parsed.texts.map((t) => [t.id, t])), warnings: [] };
        for (const lineId of byPage.get(uid)!) {
          const line = model.lines.find((l) => l.id === lineId)!;
          const n = (line.text.match(re) ?? []).length;
          const newText = o.regex ? line.text.replace(re, replacement) : line.text.replace(re, () => replacement);
          try {
            await editLine(env, line, newText);
            count += n;
          } catch (e) {
            warnings.push(`Page ${this.page(uid).index + 1}: ${(e as Error).message}`);
          }
        }
        if (editor.dirty) editor.commit();
        warnings.push(...env.warnings.map((w) => `${w.reason} (${w.original} → ${w.substitute})`));
      }
    });
    return { count, warnings: Array.from(new Set(warnings)) };
  }

  async replaceHit(hit: SearchHit, replacement: string): Promise<EditResult> {
    const line = this.parse(hit.pageUid).model.lines.find((l) => l.id === hit.lineId);
    if (!line) throw new Error('Match no longer exists');
    const text = line.text.slice(0, hit.start) + replacement + line.text.slice(hit.end);
    return this.editLine(hit.pageUid, hit.lineId, text);
  }

  // -------------------------------------------------------------------------
  // Images
  // -------------------------------------------------------------------------

  async replaceImage(uid: string, imageId: string, img: NewImage, fit: FitMode = 'keep'): Promise<EditResult> {
    const image = this.parse(uid).parsed.images.find((i) => i.id === imageId);
    if (!image) throw new Error('Image not found');
    if (!image.editable) throw new Error(`Image is not editable: ${image.readOnlyReason}`);
    return this.editPage('Replace image', uid, async (editor) => {
      const emb = await embedNewImage(this.doc, img);
      const nm = editor.addResource('XObject', 'ImN', emb.ref);
      replaceImageOps(editor, image, nm, emb.width, emb.height, fit);
      return { focus: { pageUid: uid, rect: image.bbox, kind: 'image' } };
    });
  }

  async insertImage(uid: string, img: NewImage, rect: Rect, opts: { rotation?: number; opacity?: number } = {}): Promise<EditResult> {
    return this.editPage('Insert image', uid, async (editor) => {
      const emb = await embedNewImage(this.doc, img);
      const nm = editor.addResource('XObject', 'ImN', emb.ref);
      const gs = opts.opacity !== undefined && opts.opacity < 1 ? editor.alphaState(opts.opacity) : undefined;
      editor.append(insertImageOps(nm, rect, opts.rotation ?? 0, gs));
      return { focus: { pageUid: uid, rect, kind: 'image' } };
    });
  }

  async setImageOpacity(uid: string, imageId: string, alpha: number): Promise<EditResult> {
    const image = this.parse(uid).parsed.images.find((i) => i.id === imageId);
    if (!image?.editable) throw new Error('Image not editable');
    return this.editPage('Image opacity', uid, async (editor) => wrapImageOp(editor, image, { alpha }));
  }

  /** Crop an image to a page-space rectangle (clipping; pixels are kept). */
  async cropImage(uid: string, imageId: string, pageRect: Rect): Promise<EditResult> {
    const image = this.parse(uid).parsed.images.find((i) => i.id === imageId);
    if (!image?.editable) throw new Error('Image not editable');
    const inv = invert(image.matrix);
    const p0 = apply(inv, pageRect.x, pageRect.y);
    const p1 = apply(inv, pageRect.x + pageRect.width, pageRect.y + pageRect.height);
    const crop = { x: Math.min(p0[0], p1[0]), y: Math.min(p0[1], p1[1]), width: Math.abs(p1[0] - p0[0]), height: Math.abs(p1[1] - p0[1]) };
    return this.editPage('Crop image', uid, async (editor) => {
      wrapImageOp(editor, image, { crop });
      return { focus: { pageUid: uid, rect: pageRect, kind: 'image' } };
    });
  }

  async extractImage(uid: string, imageId: string): Promise<{ bytes: Uint8Array; mime: string; ext: string }> {
    const { parsed } = this.parse(uid);
    const image = parsed.images.find((i) => i.id === imageId);
    if (!image) throw new Error('Image not found');
    let stream: PDFStream | undefined = image.stream;
    if (image.inline) {
      const op = this.findOp(parsed, image);
      if (op?.inline) stream = inlineToStream(this.doc.context, op.inline.dict, op.inline.data);
    }
    if (!stream) throw new Error('Image data not found');
    return extractImage(this.doc.context, stream, this.opts.codec);
  }

  private findOp(parsed: ParsedPage, image: { opIndex: number; formPath: number[] }) {
    if (!image.formPath.length) return parsed.stream.ops[image.opIndex];
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Shapes & paths
  // -------------------------------------------------------------------------

  async addShape(uid: string, spec: ShapeSpec): Promise<EditResult> {
    return this.editPage('Draw shape', uid, async (editor) => {
      const { ops, bbox } = shapeOps(editor, spec);
      editor.append(ops);
      return { focus: { pageUid: uid, rect: bbox, kind: 'path' } };
    });
  }

  async stylePath(uid: string, pathId: string, style: PathStyle): Promise<EditResult> {
    const path = this.parse(uid).parsed.paths.find((p) => p.id === pathId);
    if (!path) throw new Error('Path not found');
    return this.editPage('Path style', uid, async (editor) => stylePath(editor, path, style));
  }

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  async movePage(uid: string, toIndex: number): Promise<DocInfo> {
    const { index } = this.page(uid);
    await this.command('Move page', [], () => movePageOp(this.doc, index, toIndex), { structural: true });
    return this.info();
  }

  async rotatePages(uids: string[], delta: number): Promise<DocInfo> {
    await this.command('Rotate pages', uids, () => uids.forEach((u) => rotatePage(this.page(u).page, delta)));
    return this.info();
  }

  async deletePages(uids: string[]): Promise<DocInfo> {
    const idx = uids.map((u) => this.page(u).index);
    await this.command('Delete pages', [], () => deletePagesOp(this.doc, idx), { structural: true });
    return this.info();
  }

  async duplicatePage(uid: string): Promise<DocInfo> {
    const { index } = this.page(uid);
    await this.command('Duplicate page', [], () => duplicatePageOp(this.doc, index), { structural: true });
    return this.info();
  }

  async insertBlankPage(index: number, size?: [number, number]): Promise<DocInfo> {
    const pages = this.pages();
    const ref = pages[Math.min(index, pages.length - 1)] ?? pages[0];
    const s = size ?? (ref ? [ref.getWidth(), ref.getHeight()] as [number, number] : [612, 792] as [number, number]);
    await this.command('Insert page', [], () => insertBlankPage(this.doc, index, s), { structural: true });
    return this.info();
  }

  async insertPdf(index: number, bytes: Uint8Array, range?: string): Promise<DocInfo> {
    await this.command('Insert pages', [], () => insertFromPdf(this.doc, bytes, index, range), { structural: true });
    return this.info();
  }

  async mergePdfs(files: Uint8Array[]): Promise<DocInfo> {
    await this.command('Merge PDFs', [], async () => {
      for (const f of files) await insertFromPdf(this.doc, f, this.doc.getPageCount());
    }, { structural: true });
    return this.info();
  }

  async extractPages(uids: string[]): Promise<Uint8Array> {
    await this.doc.flush();
    return extractPagesOp(this.doc, uids.map((u) => this.page(u).index).sort((a, b) => a - b));
  }

  async splitDocument(ranges: string[]): Promise<Uint8Array[]> {
    await this.doc.flush();
    return splitDocument(this.doc, ranges);
  }

  async setPageBox(uid: string, box: 'MediaBox' | 'CropBox', rect: [number, number, number, number]): Promise<DocInfo> {
    await this.command(box === 'CropBox' ? 'Crop page' : 'Resize page', [uid], () => setPageBoxOp(this.leaf(uid), this.doc, box, rect));
    return this.info();
  }

  // -------------------------------------------------------------------------
  // Annotations & links
  // -------------------------------------------------------------------------

  async addAnnotation(uid: string, spec: AnnotationSpec): Promise<EditResult> {
    return this.command(`Add ${spec.type === 'Link' ? 'link' : 'annotation'}`, [uid], async () => {
      const leaf = this.leaf(uid);
      const ref = await createAnnotation(this.doc, this.refOf(uid), spec, async (text, fs, x, y) => {
        // Text appearances for FreeText use the editor's font machinery.
        const holderLeaf = this.doc.context.obj({}) as PDFDict;
        const dummy = new PageEditor(this.doc.context, holderLeaf, { stream: { ops: [], source: new Uint8Array(), warnings: [] }, texts: [], images: [], paths: [], forms: [], end: { depth: 0, ctm: [1, 0, 0, 1, 0, 0] }, warnings: [], degraded: false });
        const { ops } = await textLineOps(dummy, this.fonts, { text, fontSize: fs }, x, y);
        const res = asDict(holderLeaf.get(N('Resources')));
        const fontsDict = asDict(res?.get(N('Font')));
        const [k, v] = fontsDict?.entries()[0] ?? [];
        return { fontRef: v as PDFRef, resName: k ? k.decodeText() : 'F1', ops };
      });
      const arr = writableAnnots(this.doc.context, leaf);
      arr.push(ref);
      return { warnings: [], focus: { pageUid: uid, rect: spec.rects[0], kind: 'annotation' as const } };
    });
  }

  async updateAnnotation(uid: string, index: number, patch: AnnotationPatch): Promise<EditResult> {
    return this.command('Edit annotation', [uid], () => {
      updateAnnotation(this.doc, this.leaf(uid), index, patch);
      return { warnings: [] };
    });
  }

  async removeAnnotation(uid: string, index: number): Promise<EditResult> {
    return this.command('Delete annotation', [uid], () => {
      removeAnnotation(this.doc.context, this.leaf(uid), index);
      return { warnings: [] };
    });
  }

  async flattenAnnotations(uids?: string[]): Promise<{ count: number }> {
    const targets = uids ?? this.allPageUids();
    let count = 0;
    await this.command('Flatten annotations', targets, () => {
      for (const uid of targets) {
        const editor = new PageEditor(this.doc.context, this.leaf(uid), this.parse(uid).parsed);
        count += flattenAnnotations(this.doc.context, editor.leaf, editor, { include: (s) => s !== 'Link' && s !== 'Popup' && s !== 'Widget' });
        if (editor.dirty) editor.commit();
      }
    });
    return { count };
  }

  // -------------------------------------------------------------------------
  // Forms
  // -------------------------------------------------------------------------

  getFields(): FormField[] {
    return listFields(this.doc);
  }

  private async formFont(text: string): Promise<PDFFont | undefined> {
    // Latin-1 values work with the default Helvetica appearance.
    if (/^[\u0000-ÿ]*$/.test(text) || !this.opts.fontLoader) return undefined;
    let file = 'Arimo_400Regular.ttf';
    if (/[ঀ-৿]/.test(text)) file = 'NotoSansBengali_400Regular.ttf';
    else if (/[؀-ۿ]/.test(text)) file = 'NotoNaskhArabic_400Regular.ttf';
    else if (/[ऀ-ॿ]/.test(text)) file = 'NotoSansDevanagari_400Regular.ttf';
    else if (/[֐-׿]/.test(text)) file = 'NotoSansHebrew_400Regular.ttf';
    else if (/[　-鿿가-힯]/.test(text)) file = 'cjk:NotoSansSC_400Regular.ttf';
    let f = this.formFonts.get(file);
    if (!f) {
      // Full embedding: fontkit's subsetter (pdf-lib subset: true) corrupts outlines of some fonts.
      f = await this.doc.embedFont(await this.opts.fontLoader(file), { subset: false });
      this.formFonts.set(file, f);
    }
    return f;
  }

  async setFieldValue(name: string, value: string | boolean | string[]): Promise<DocInfo> {
    const font = typeof value === 'string' ? await this.formFont(value) : undefined;
    const pageUids = this.getFields().find((f) => f.name === name)?.widgets.map((w) => w.pageUid).filter(Boolean) ?? [];
    await this.command('Fill form field', pageUids, () => setFieldValue(this.doc, name, value, font), { extra: () => formRefs(this.doc, [name]) });
    return this.info();
  }

  async createField(uid: string, spec: Omit<NewFieldSpec, 'pageIndex'>): Promise<DocInfo> {
    const { index } = this.page(uid);
    await this.command('Add form field', [uid], () => createField(this.doc, { ...spec, pageIndex: index }), { extra: () => formRefs(this.doc) });
    return this.info();
  }

  async removeField(name: string): Promise<DocInfo> {
    await this.command('Remove form field', this.allPageUids(), () => removeField(this.doc, name), { extra: () => formRefs(this.doc) });
    return this.info();
  }

  async flattenForm(): Promise<DocInfo> {
    const uids = this.allPageUids();
    await this.command('Flatten form', uids, () => {
      if (!hasForm(this.doc)) return;
      updateAllAppearances(this.doc);
      for (const uid of uids) {
        const editor = new PageEditor(this.doc.context, this.leaf(uid), this.parse(uid).parsed);
        flattenAnnotations(this.doc.context, editor.leaf, editor, { include: (s) => s === 'Widget' });
        if (editor.dirty) editor.commit();
      }
      clearAcroForm(this.doc);
    }, { extra: () => formRefs(this.doc) });
    return this.info();
  }

  // -------------------------------------------------------------------------
  // Redaction, stamps, OCR, signatures
  // -------------------------------------------------------------------------

  async redact(areas: { pageUid: string; rects: Rect[] }[], fill: RGB | null = { r: 0, g: 0, b: 0 }): Promise<RedactStats> {
    const total: RedactStats = { glyphs: 0, images: 0, imagesRemoved: 0, paths: 0, forms: 0, warnings: [] };
    const uids = Array.from(new Set(areas.map((a) => a.pageUid)));
    await this.command('Apply redactions', uids, async () => {
      for (const area of areas) {
        const parsed = this.parse(area.pageUid).parsed;
        const leaf = this.leaf(area.pageUid);
        const editor = new PageEditor(this.doc.context, leaf, parsed);
        const s = await redactPage(this.doc.context, editor, pageResources(this.doc.context, leaf), area.rects, { fill, codec: this.opts.codec });
        // Remove annotations under the areas.
        const anns = listAnnotations(this.doc, leaf, []);
        const hitIdx = anns.filter((a) => area.rects.some((r) => a.rect.x < r.x + r.width && r.x < a.rect.x + a.rect.width && a.rect.y < r.y + r.height && r.y < a.rect.y + a.rect.height)).map((a) => a.index).sort((a, b) => b - a);
        for (const i of hitIdx) removeAnnotation(this.doc.context, leaf, i);
        if (editor.dirty) editor.commit();
        total.glyphs += s.glyphs;
        total.images += s.images;
        total.imagesRemoved += s.imagesRemoved;
        total.paths += s.paths;
        total.forms += s.forms;
        total.warnings.push(...s.warnings);
        this.cache.delete(area.pageUid);
      }
    });
    return total;
  }

  async applyStamps(o: StampOptions): Promise<DocInfo> {
    const pages = this.pages();
    const indices = parseRange(o.pageRange ?? 'all', pages.length);
    const uids = indices.map((i) => uidOf(pages[i].ref));
    await this.command(o.kind === 'watermark' ? 'Add watermark' : o.kind === 'bates' ? 'Bates numbering' : o.kind === 'pageNumbers' ? 'Page numbers' : `Add ${o.kind}`, uids, async () => {
      let imageRef: { resRef: PDFRef; width: number; height: number } | undefined;
      if (o.image) {
        const emb = await embedNewImage(this.doc, o.image);
        imageRef = { resRef: emb.ref, width: emb.width, height: emb.height };
      }
      let k = 0;
      for (const i of indices) {
        const uid = uidOf(pages[i].ref);
        const editor = new PageEditor(this.doc.context, this.leaf(uid), this.parse(uid).parsed);
        await applyStamp({ editor, fonts: this.fonts, info: this.pageInfo(pages[i], i), pageNumber: i + 1, total: pages.length, imageRef, batesNumber: (o.start ?? 1) + k }, o);
        k++;
        if (editor.dirty) editor.commit();
      }
    });
    return this.info();
  }

  /** Add an OCR text layer. 'searchable' = invisible text over the scan; 'editable' = visible text, words erased from the scan. */
  async applyOcr(uid: string, result: OcrPageResult, mode: 'searchable' | 'editable'): Promise<EditResult> {
    const { parsed } = this.parse(uid);
    const { page, index } = this.page(uid);
    const info = this.pageInfo(page, index);
    return this.editPage(mode === 'editable' ? 'OCR (editable)' : 'OCR (searchable)', uid, async (editor) => {
      const { ops, wordRects } = await ocrTextOps(editor, this.fonts, info, result, mode === 'editable');
      const warnings: string[] = [];
      if (mode === 'editable') {
        const scan = parsed.images.filter((im) => im.editable && im.stream).sort((a, b) => b.bbox.width * b.bbox.height - a.bbox.width * a.bbox.height)[0];
        if (scan?.stream) {
          const rgba = await decodeToRGBA(this.doc.context, scan.stream, this.opts.codec, false);
          if (rgba) {
            const regions = wordRects.map((r) => pageRectToPixels(scan, r)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => {
              const pad = 1;
              const rr = { x0: r.x0 - pad, y0: r.y0 - pad, x1: r.x1 + pad, y1: r.y1 + pad };
              return { ...rr, rgb: estimateBackground(rgba, rr) };
            });
            const painted = await paintImageRegions(this.doc.context, scan.stream, regions, this.opts.codec);
            if (painted) {
              const nm = editor.addResource('XObject', 'ImO', this.doc.context.register(painted));
              editor.replace(scan.opIndex, [{ op: 'Do', args: [{ t: 'name', v: nm }] }]);
            } else warnings.push('The scanned image could not be modified; OCR text was placed over it.');
          } else warnings.push('The scanned image format cannot be decoded here; OCR text was placed over it.');
        }
      }
      editor.append(ops);
      return { warnings };
    });
  }

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  getMetadata(): DocMetadata {
    const d = this.doc;
    const safe = <T>(f: () => T, def: T) => {
      try {
        return f() ?? def;
      } catch {
        return def;
      }
    };
    return {
      title: safe(() => d.getTitle() ?? '', ''),
      author: safe(() => d.getAuthor() ?? '', ''),
      subject: safe(() => d.getSubject() ?? '', ''),
      keywords: safe(() => d.getKeywords() ?? '', ''),
      creator: safe(() => d.getCreator() ?? '', ''),
      producer: safe(() => d.getProducer() ?? '', ''),
      creationDate: safe(() => d.getCreationDate()?.toISOString() ?? null, null),
      modificationDate: safe(() => d.getModificationDate()?.toISOString() ?? null, null),
    };
  }

  async setMetadata(m: Partial<DocMetadata>): Promise<DocInfo> {
    const infoRef = () => {
      const r = this.doc.context.trailerInfo.Info;
      return r instanceof PDFRef ? [r] : [];
    };
    const root = this.doc.context.trailerInfo.Root as PDFRef;
    await this.command('Edit metadata', [], () => {
      const d = this.doc;
      if (m.title !== undefined) d.setTitle(m.title);
      if (m.author !== undefined) d.setAuthor(m.author);
      if (m.subject !== undefined) d.setSubject(m.subject);
      if (m.keywords !== undefined) d.setKeywords(m.keywords.split(/[,;]\s*/).filter(Boolean));
      if (m.creator !== undefined) d.setCreator(m.creator);
      if (m.producer !== undefined) d.setProducer(m.producer);
      d.setModificationDate(new Date());
      // Keep XMP in sync: replace catalog /Metadata with a fresh packet.
      const md = this.getMetadata();
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(md.title)}</rdf:li></rdf:Alt></dc:title>
<dc:creator><rdf:Seq><rdf:li>${esc(md.author)}</rdf:li></rdf:Seq></dc:creator>
<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(md.subject)}</rdf:li></rdf:Alt></dc:description>
<pdf:Keywords>${esc(md.keywords)}</pdf:Keywords><pdf:Producer>${esc(md.producer)}</pdf:Producer><xmp:CreatorTool>${esc(md.creator)}</xmp:CreatorTool>
<xmp:ModifyDate>${new Date().toISOString()}</xmp:ModifyDate>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
      if (d.catalog.get(N('Metadata'))) {
        const s = d.context.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' });
        d.catalog.set(N('Metadata'), d.context.register(s));
      }
    }, { extra: () => [...infoRef(), root] });
    return this.info();
  }

  // -------------------------------------------------------------------------
  // Saving & export
  // -------------------------------------------------------------------------

  async save(o: SaveOptions = {}): Promise<Uint8Array> {
    await this.doc.flush();
    await this.fonts.finalizeAll();
    let bytes: Uint8Array;
    if (o.incremental && this.tracker && !o.compress && !o.encrypt) {
      bytes = saveIncremental(this.doc, this.tracker);
    } else {
      bytes = await saveFull(this.doc, { useObjectStreams: false });
    }
    if (o.compress) bytes = await this.compressBytes(bytes, o);
    if (o.encrypt) {
      if (!this.opts.mupdf) throw new Error('Encryption requires the mupdf engine');
      bytes = await encrypt(await this.opts.mupdf(), bytes, o.encrypt);
    }
    return bytes;
  }

  private async compressBytes(bytes: Uint8Array, o: SaveOptions): Promise<Uint8Array> {
    let out = bytes;
    const codec = this.opts.codec;
    if (codec) {
      // Downsample / recompress large images on a copy.
      const copy = await PDFDocument.load(bytes, { updateMetadata: false });
      const ctx = copy.context;
      const maxDim = o.maxImageDimension ?? 1600;
      const quality = o.jpegQuality ?? 0.75;
      for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFStream)) continue;
        if (dictGet(ctx, obj.dict, 'Subtype')?.toString() !== '/Image') continue;
        if (obj.dict.get(N('SMask')) || obj.dict.get(N('Mask')) || dictGet(ctx, obj.dict, 'ImageMask')) continue;
        const w = (dictGet(ctx, obj.dict, 'Width') as { asNumber?: () => number })?.asNumber?.() ?? 0;
        const h = (dictGet(ctx, obj.dict, 'Height') as { asNumber?: () => number })?.asNumber?.() ?? 0;
        if (w * h < 64 * 64) continue;
        const rgba = await decodeToRGBA(ctx, obj, codec, false);
        if (!rgba) continue;
        const scaleF = Math.min(1, maxDim / Math.max(w, h));
        const target = scaleF < 1 ? downscale(rgba, Math.max(1, Math.round(w * scaleF)), Math.max(1, Math.round(h * scaleF))) : rgba;
        const jpg = await codec.encodeJpeg(target, quality);
        const raw = (obj as unknown as { contents?: Uint8Array }).contents;
        if (raw && jpg.length >= raw.length && scaleF >= 1) continue;
        const d = ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: target.width, Height: target.height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode', Length: jpg.length });
        ctx.assign(ref, PDFRawStream.of(d as PDFDict, jpg));
      }
      out = await copy.save({ useObjectStreams: false });
    }
    if (this.opts.mupdf) {
      try {
        out = await compressStructure(await this.opts.mupdf(), out);
      } catch {
        /* structural compression is optional */
      }
    }
    return out.length < bytes.length ? out : bytes;
  }

  async exportDocx(): Promise<Uint8Array> {
    const models = this.allPageUids().map((u) => this.getPageModel(u));
    const images: DocxImage[] = [];
    for (const m of models) {
      for (const im of m.images) {
        if (im.width * im.height < 16) continue;
        try {
          const x = await this.extractImage(m.uid, im.id);
          if (x.mime === 'image/jpeg' || x.mime === 'image/png') images.push({ pageUid: m.uid, imageId: im.id, bytes: x.bytes, type: x.mime === 'image/png' ? 'png' : 'jpg' });
        } catch {
          /* unsupported image encodings are skipped */
        }
      }
    }
    return buildDocx(models, images);
  }

  /** Encode RGBA pixels as PNG (used by the UI for exports). */
  encodePng(width: number, height: number, data: Uint8ClampedArray): Uint8Array {
    return encodePNG({ width, height, data });
  }

  /** Debug / test helper: raw decoded content of a page. */
  pageContent(uid: string): string {
    return new TextDecoder('latin1').decode(pageContentBytes(this.doc.context, this.leaf(uid)));
  }

  get document(): PDFDocument {
    return this.doc;
  }

  /** Used by the inline text editor to show the font name. */
  fontName(uid: string, runId: string): string {
    const r = this.resolveRuns(uid, [runId])[0];
    return r?.font.baseFont ?? '';
  }

  /** Point in page space -> top-most object id (fallback hit-testing for the UI). */
  hitTest(uid: string, x: number, y: number): string | null {
    const { model } = this.parse(uid);
    const inside = (r: Rect) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
    const a = [...model.annotations].reverse().find((o) => inside(o.rect));
    if (a) return a.id;
    const b = model.blocks.find((o) => inside(o.bbox));
    if (b) return b.id;
    const im = [...model.images].reverse().find((o) => inside(o.bbox));
    if (im) return im.id;
    const p = [...model.paths].reverse().find((o) => inside(o.bbox));
    return p?.id ?? null;
  }

  static isPasswordError(e: unknown): boolean {
    return e instanceof PasswordRequiredError || (e as { code?: string })?.code === 'PASSWORD_REQUIRED';
  }

  /** Matrix utilities exposed for the UI. */
  static compose(a: Matrix, b: Matrix): Matrix {
    return mul(a, b);
  }

}

/**
 * pdf-lib does not register object-stream / xref-stream objects, so new
 * objects could reuse their numbers. Reserve everything below the file's /Size.
 */
function reserveObjectNumbers(doc: PDFDocument, bytes: Uint8Array) {
  let max = 0;
  const tail = Math.max(0, bytes.length - 1024 * 1024);
  let s = '';
  for (let i = tail; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  for (const m of s.matchAll(/\/Size\s+(\d+)/g)) max = Math.max(max, parseInt(m[1], 10));
  const ctx = doc.context as unknown as { largestObjectNumber: number };
  if (max - 1 > ctx.largestObjectNumber) ctx.largestObjectNumber = max - 1;
}

function downscale(img: { width: number; height: number; data: Uint8ClampedArray }, w: number, h: number) {
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Box filter
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * img.width + xx) * 4;
          r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; a += img.data[o + 3]; n++;
        }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}
