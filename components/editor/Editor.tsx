'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useEditor } from '@/store/editorStore';
import { loadDraft } from '@/lib/client/drafts';
import { downloadBytes } from '@/lib/client/imageUtils';
import type { FormField, Matrix } from '@/lib/pdf/types';
import Toolbar from './Toolbar';
import ThumbnailSidebar from './ThumbnailSidebar';
import PropertiesPanel from './PropertiesPanel';
import PageCanvas from './PageCanvas';
import FindReplaceDialog from './FindReplaceDialog';
import Dialogs, { PasswordDialog } from './Dialogs';
import { PageCoords } from '@/lib/client/coords';

type Clip =
  | { kind: 'image'; bytes: Uint8Array; mime: 'image/png' | 'image/jpeg'; rect: { x: number; y: number; width: number; height: number } }
  | { kind: 'text'; text: string; x: number; y: number; width: number; fontSize: number; color?: { r: number; g: number; b: number } };

const PAGE_GAP = 16;

export default function Editor({ draftId }: { draftId: string }) {
  const s = useEditor();
  const info = s.info;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'password' | 'error'>('loading');
  const [pwError, setPwError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [showThumbs, setShowThumbs] = useState(true);
  const [showProps, setShowProps] = useState(true);
  const [fields, setFields] = useState<FormField[]>([]);
  const pendingBytes = useRef<{ bytes: Uint8Array; name: string } | null>(null);
  const clip = useRef<Clip | null>(null);

  // ------------------------------------------------------------- loading
  const open = useCallback(async (password?: string) => {
    const p = pendingBytes.current!;
    try {
      await useEditor.getState().openBytes(p.bytes, p.name, draftId, password);
      setStatus('ready');
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (/password/i.test(msg)) {
        setStatus('password');
        setPwError(password ? 'Incorrect password' : undefined);
      } else {
        setStatus('error');
        setLoadError(msg);
      }
    }
  }, [draftId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const d = await loadDraft(draftId);
      if (!alive) return;
      if (!d) {
        setStatus('missing');
        return;
      }
      pendingBytes.current = { bytes: d.bytes, name: d.name };
      await open();
    })();
    return () => {
      alive = false;
    };
  }, [draftId, open]);

  useEffect(() => {
    useEditor.setState({ dark: document.documentElement.classList.contains('dark') });
    const onResize = () => {
      if (window.innerWidth < 900) {
        setShowThumbs(false);
        setShowProps(false);
      }
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ------------------------------------------------------------- forms
  const loadFields = useCallback(async () => {
    if (!useEditor.getState().info) return;
    setFields(await useEditor.getState().engine().getFields());
  }, []);
  useEffect(() => {
    if (s.tool === 'forms') loadFields();
    const h = () => loadFields();
    window.addEventListener('fields-changed', h);
    return () => window.removeEventListener('fields-changed', h);
  }, [s.tool, info?.pageCount, loadFields]);

  // ------------------------------------------------------------- fit zoom
  const fit = useCallback((mode: 'width' | 'page') => {
    const el = scrollRef.current;
    const st = useEditor.getState();
    if (!el || !st.info) return;
    const maxW = Math.max(...st.info.pages.map((p) => p.width));
    const page = st.info.pages[st.currentPage] ?? st.info.pages[0];
    const zw = (el.clientWidth - 48) / maxW;
    const zp = Math.min(zw, (el.clientHeight - 32) / page.height);
    st.set({ zoom: Math.max(0.25, Math.min(4, mode === 'width' ? zw : zp)), fit: mode });
  }, []);

  useEffect(() => {
    if (status !== 'ready') return;
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const f = useEditor.getState().fit;
      if (f) fit(f);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [status, fit]);

  // ------------------------------------------------------------- virtualization
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !info) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const uid = (e.target as HTMLElement).dataset.uid!;
            if (e.isIntersecting) next.add(uid);
            else next.delete(uid);
          }
          return next;
        });
        // Current page = the most visible one.
        const best = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (best) {
          const idx = Number((best.target as HTMLElement).dataset.index);
          if (!Number.isNaN(idx)) useEditor.setState({ currentPage: idx });
        }
      },
      { root, rootMargin: '600px 0px', threshold: [0, 0.25, 0.5, 0.75] },
    );
    root.querySelectorAll('[data-slot]').forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [info, s.zoom]);

  const navigate = useCallback((index: number) => {
    const el = scrollRef.current?.querySelector(`[data-index="${index}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    useEditor.setState({ currentPage: index });
  }, []);

  // ------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const st = useEditor.getState();
      const target = e.target as HTMLElement;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        const bytes = await st.act('Saving', (en) => en.save({}));
        if (bytes) {
          downloadBytes(bytes, st.fileName.replace(/\.pdf$/i, '') + '-edited.pdf');
          await st.saveNow();
        }
        return;
      }
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        st.openDialog('find');
        return;
      }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        await st.undo();
        return;
      }
      if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        await st.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'c' && st.selection) {
        e.preventDefault();
        await copySelection();
        return;
      }
      if (mod && e.key.toLowerCase() === 'v' && clip.current) {
        e.preventDefault();
        await paste();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && st.selection) {
        e.preventDefault();
        const sel = st.selection;
        st.select(null);
        await st.act('Delete', (en) => en.deleteObjects(sel.pageUid, sel.ids));
        return;
      }
      if (e.key.startsWith('Arrow') && st.selection && st.info) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const page = st.info.pages.find((p) => p.uid === st.selection!.pageUid)!;
        const c = new PageCoords(page, 1);
        const dv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] as [number, number];
        const D = c.viewToUserTransform([1, 0, 0, 1, dv[0], dv[1]] as Matrix);
        await st.act('Nudge', (en) => en.transformObjects(st.selection!.pageUid, st.selection!.ids, D));
        return;
      }
      if (e.key === 'Escape') {
        st.set({ selection: null, editing: null, pendingImage: null });
        return;
      }
      if (!mod && !e.altKey) {
        const map: Record<string, Parameters<typeof st.setTool>[0]> = { v: 'select', t: 'editText', i: 'editImage', a: 'addText', s: 'shapes', n: 'annotate', f: 'forms', g: 'sign', r: 'redact' };
        const t = map[e.key.toLowerCase()];
        if (t) st.setTool(t);
        if (e.key === '+' || e.key === '=') st.set({ zoom: Math.min(4, st.zoom * 1.2), fit: null });
        if (e.key === '-') st.set({ zoom: Math.max(0.25, st.zoom / 1.2), fit: null });
      }
    };
    const copySelection = async () => {
      const st = useEditor.getState();
      const sel = st.selection!;
      const m = st.models[sel.pageUid];
      const id = sel.ids[0];
      if (!m) return;
      if (id.startsWith('i')) {
        const im = m.images.find((x) => x.id === id)!;
        const x = await st.engine().extractImage(sel.pageUid, id);
        if (x.mime === 'image/png' || x.mime === 'image/jpeg') clip.current = { kind: 'image', bytes: x.bytes, mime: x.mime, rect: im.bbox };
      } else if (id.startsWith('b')) {
        const b = m.blocks.find((x) => x.id === id)!;
        const run = m.texts.find((t) => t.id === m.lines.find((l) => l.id === b.lineIds[0])?.runIds[0]);
        clip.current = { kind: 'text', text: b.text, x: b.bbox.x, y: b.bbox.y + b.bbox.height, width: b.bbox.width, fontSize: b.fontSize, color: run?.color.rgb ?? undefined };
        try {
          await navigator.clipboard?.writeText(b.text);
        } catch {
          /* clipboard permission denied */
        }
      } else st.toast('info', 'Copy supports text blocks and images.');
      if (clip.current) st.toast('info', 'Copied');
    };
    const paste = async () => {
      const st = useEditor.getState();
      const c = clip.current!;
      const page = st.info!.pages[st.currentPage];
      if (c.kind === 'image') await st.act('Paste image', (en) => en.insertImage(page.uid, { bytes: c.bytes, mime: c.mime }, { ...c.rect, x: c.rect.x + 12, y: c.rect.y - 12 }));
      else await st.act('Paste text', (en) => en.addText(page.uid, { x: c.x + 12, y: c.y - 12, width: c.width + 2, text: c.text.replace(/\n/g, ' '), style: { fontSize: c.fontSize, color: c.color } }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (useEditor.getState().dirtySinceSave) {
        useEditor.getState().saveNow();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  // ------------------------------------------------------------- render
  if (status === 'missing')
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p>This draft no longer exists in this browser.</p>
        <Link className="btn btn-primary" href="/">Open a PDF</Link>
      </div>
    );
  if (status === 'error')
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-red-600">The document could not be opened: {loadError}</p>
        <Link className="btn" href="/">Back</Link>
      </div>
    );
  if (status === 'password') return <PasswordDialog error={pwError} onSubmit={(pw) => open(pw)} />;
  if (status === 'loading' || !info) return <div className="flex h-full items-center justify-center text-slate-500">{s.busy ?? 'Loading…'}</div>;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Toolbar onFit={fit} />
      <div className="relative flex min-h-0 flex-1">
        {showThumbs && <ThumbnailSidebar onNavigate={navigate} />}
        <div ref={scrollRef} className="relative min-w-0 flex-1 overflow-auto bg-slate-200 dark:bg-slate-800" data-testid="viewer">
          <div className="flex min-w-fit flex-col items-center px-6 py-4" style={{ gap: PAGE_GAP }}>
            {info.pages.map((p) => (
              <div key={p.uid} data-slot data-uid={p.uid} data-index={p.index} style={{ width: p.width * s.zoom, height: p.height * s.zoom }}>
                <PageCanvas info={p} zoom={s.zoom} visible={visible.has(p.uid)} fields={fields} />
              </div>
            ))}
          </div>
        </div>
        {showProps && <PropertiesPanel />}
        <div className="pointer-events-none absolute bottom-2 left-1/2 z-40 flex -translate-x-1/2 gap-2">
          <button className="btn pointer-events-auto shadow" onClick={() => setShowThumbs((v) => !v)} title="Toggle pages">☰ Pages</button>
          <span className="pointer-events-auto rounded-md bg-white/90 px-2 py-1.5 text-sm shadow dark:bg-slate-900/90">
            <button className="px-1" onClick={() => navigate(Math.max(0, s.currentPage - 1))}>◀</button>
            <input
              className="w-10 bg-transparent text-center"
              value={s.currentPage + 1}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (n >= 1 && n <= info.pageCount) navigate(n - 1);
              }}
              aria-label="Page number"
            />
            / {info.pageCount}
            <button className="px-1" onClick={() => navigate(Math.min(info.pageCount - 1, s.currentPage + 1))}>▶</button>
          </span>
          <button className="btn pointer-events-auto shadow" onClick={() => setShowProps((v) => !v)} title="Toggle properties">⚙ Properties</button>
        </div>
      </div>
      {s.dialog === 'find' && <FindReplaceDialog onNavigate={navigate} />}
      <Dialogs />
      <div className="fixed bottom-14 right-4 z-50 flex w-80 flex-col gap-2" data-testid="toasts">
        {s.toasts.map((t) => (
          <div
            key={t.id}
            onClick={() => s.dismiss(t.id)}
            className={`cursor-pointer rounded-md px-3 py-2 text-sm shadow-lg ${t.kind === 'error' ? 'bg-red-600 text-white' : t.kind === 'warning' ? 'bg-amber-100 text-amber-900' : t.kind === 'success' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-white'}`}
          >
            {t.text}
          </div>
        ))}
      </div>
      {s.busy && (
        <div className="fixed left-1/2 top-16 z-50 -translate-x-1/2 rounded-full bg-slate-900/85 px-4 py-1.5 text-sm text-white shadow" data-testid="busy">
          {s.busy}…
        </div>
      )}
      <div className="panel flex items-center justify-between border-t px-3 py-1 text-xs text-slate-500">
        <span>
          {info.pageCount} pages · {Math.round(s.zoom * 100)}% {info.canIncrementalSave ? '· incremental save available' : ''}
        </span>
        <span>{s.lastSaved ? `Draft saved ${new Date(s.lastSaved).toLocaleTimeString()}` : s.dirtySinceSave ? 'Unsaved changes' : 'No changes'}</span>
      </div>
    </div>
  );
}
