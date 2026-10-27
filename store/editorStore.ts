'use client';
import { create } from 'zustand';
import { getEngine, type EngineClient } from '@/lib/client/engineClient';
import { setBaseDocument } from '@/lib/client/pdfjs';
import { saveDraft } from '@/lib/client/drafts';
import type { DocInfo, EditResult, NewImage, PageModel, Rect, RGB, SearchHit } from '@/lib/pdf/types';

export type Tool = 'select' | 'editText' | 'editImage' | 'addText' | 'shapes' | 'annotate' | 'forms' | 'sign' | 'redact';
export type ShapeTool = 'rect' | 'ellipse' | 'line' | 'arrow' | 'freehand';
export type AnnotTool = 'Highlight' | 'Underline' | 'StrikeOut' | 'Text' | 'FreeText' | 'Ink' | 'Link';
export type FieldTool = 'fill' | 'text' | 'checkbox' | 'radio' | 'dropdown' | 'signature';

export interface Selection {
  pageUid: string;
  ids: string[];
}

export interface InlineEdit {
  pageUid: string;
  /** Existing block being edited, or null for a new text box. */
  blockId: string | null;
  /** Page-space rect of the editor box. */
  rect: Rect;
  text: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'warning' | 'error' | 'success';
  text: string;
}

interface State {
  draftId: string | null;
  fileName: string;
  info: DocInfo | null;
  models: Record<string, PageModel>;
  zoom: number;
  fit: 'width' | 'page' | null;
  currentPage: number;
  tool: Tool;
  shapeTool: ShapeTool;
  annotTool: AnnotTool;
  fieldTool: FieldTool;
  selection: Selection | null;
  editing: InlineEdit | null;
  busy: string | null;
  toasts: Toast[];
  dialog: string | null;
  dialogArgs: Record<string, unknown>;
  redactions: { pageUid: string; rect: Rect }[];
  pendingImage: (NewImage & { width: number; height: number; purpose: 'signature' | 'image' }) | null;
  searchHits: SearchHit[];
  activeHit: number;
  textDefaults: { fontFamily: string; fontSize: number; color: RGB; bold: boolean; italic: boolean };
  shapeDefaults: { stroke: RGB | null; fill: RGB | null; lineWidth: number };
  annotColor: RGB;
  dark: boolean;
  dirtySinceSave: boolean;
  lastSaved: number | null;
}

interface Actions {
  set: (p: Partial<State>) => void;
  engine: () => EngineClient;
  openBytes: (bytes: Uint8Array, name: string, draftId: string, password?: string) => Promise<void>;
  refresh: () => Promise<void>;
  ensureModel: (uid: string) => Promise<PageModel | null>;
  act: <T>(label: string, fn: (e: EngineClient) => Promise<T>) => Promise<T | undefined>;
  toast: (kind: Toast['kind'], text: string) => void;
  dismiss: (id: number) => void;
  select: (sel: Selection | null) => void;
  setTool: (t: Tool) => void;
  openDialog: (name: string, args?: Record<string, unknown>) => void;
  closeDialog: () => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  autosave: () => void;
  saveNow: () => Promise<Uint8Array | null>;
}

let toastId = 1;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
const modelLoads = new Map<string, Promise<PageModel | null>>();

export const useEditor = create<State & Actions>((set, get) => ({
  draftId: null,
  fileName: 'document.pdf',
  info: null,
  models: {},
  zoom: 1,
  fit: 'width',
  currentPage: 0,
  tool: 'select',
  shapeTool: 'rect',
  annotTool: 'Highlight',
  fieldTool: 'fill',
  selection: null,
  editing: null,
  busy: null,
  toasts: [],
  dialog: null,
  dialogArgs: {},
  redactions: [],
  pendingImage: null,
  searchHits: [],
  activeHit: -1,
  textDefaults: { fontFamily: 'Arimo', fontSize: 12, color: { r: 0, g: 0, b: 0 }, bold: false, italic: false },
  shapeDefaults: { stroke: { r: 0.85, g: 0.1, b: 0.1 }, fill: null, lineWidth: 2 },
  annotColor: { r: 1, g: 0.92, b: 0.23 },
  dark: false,
  dirtySinceSave: false,
  lastSaved: null,

  set: (p) => set(p),
  engine: () => getEngine(),

  async openBytes(bytes, name, draftId, password) {
    const e = getEngine();
    set({ busy: 'Opening document…', fileName: name, draftId, models: {}, selection: null, editing: null, redactions: [], searchHits: [] });
    try {
      const info = await e.open(bytes, { password, name });
      const base = await e.getBaseBytes();
      setBaseDocument(base.baseVersion, base.bytes);
      set({ info, currentPage: 0 });
      if (info.wasEncrypted) get().toast('info', 'The document was decrypted for editing. Use Save → Protect to add a password again.');
    } finally {
      set({ busy: null });
    }
  },

  async refresh() {
    const e = getEngine();
    const prev = get().info;
    const info = await e.info();
    if (!prev || prev.baseVersion !== info.baseVersion) {
      const base = await e.getBaseBytes();
      setBaseDocument(base.baseVersion, base.bytes);
    }
    // Drop stale models; PageCanvas re-requests them when visible.
    const models = { ...get().models };
    const live = new Map(info.pages.map((p) => [p.uid, p.version]));
    for (const uid of Object.keys(models)) if (live.get(uid) !== models[uid].version) delete models[uid];
    set({ info, models });
  },

  async ensureModel(uid) {
    const info = get().info;
    const page = info?.pages.find((p) => p.uid === uid);
    if (!page) return null;
    const cur = get().models[uid];
    if (cur && cur.version === page.version) return cur;
    const key = `${uid}@${page.version}`;
    let p = modelLoads.get(key);
    if (!p) {
      p = getEngine()
        .getPageModel(uid)
        .then((m) => {
          set({ models: { ...get().models, [uid]: m } });
          return m;
        })
        .catch(() => null)
        .finally(() => modelLoads.delete(key));
      modelLoads.set(key, p);
    }
    return p;
  },

  async act(label, fn) {
    set({ busy: label });
    try {
      const r = await fn(getEngine());
      await get().refresh();
      const warnings = (r as unknown as EditResult | undefined)?.warnings;
      if (Array.isArray(warnings) && warnings.length) for (const w of warnings.slice(0, 3)) get().toast('warning', w);
      set({ dirtySinceSave: true });
      get().autosave();
      return r;
    } catch (e) {
      get().toast('error', (e as Error)?.message ?? String(e));
      return undefined;
    } finally {
      set({ busy: null });
    }
  },

  toast(kind, text) {
    const id = toastId++;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    setTimeout(() => get().dismiss(id), kind === 'error' ? 9000 : 6000);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  select(sel) {
    set({ selection: sel && sel.ids.length ? sel : null });
  },
  setTool(t) {
    set({ tool: t, selection: null, editing: null });
  },
  openDialog(name, args = {}) {
    set({ dialog: name, dialogArgs: args });
  },
  closeDialog() {
    set({ dialog: null, dialogArgs: {} });
  },
  async undo() {
    if (!get().info?.canUndo) return;
    await get().act('Undo', (e) => e.undo());
    set({ selection: null, editing: null });
  },
  async redo() {
    if (!get().info?.canRedo) return;
    await get().act('Redo', (e) => e.redo());
    set({ selection: null, editing: null });
  },
  autosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      get().saveNow().catch(() => undefined);
    }, 2500);
  },
  async saveNow() {
    const { draftId, fileName, info } = get();
    if (!draftId || !info) return null;
    const bytes = await getEngine().save({});
    await saveDraft(draftId, fileName, bytes, info.pageCount);
    set({ dirtySinceSave: false, lastSaved: Date.now() });
    return bytes;
  },
}));
