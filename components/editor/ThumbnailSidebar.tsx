'use client';
import { memo, useEffect, useRef, useState } from 'react';
import { useEditor } from '@/store/editorStore';
import { getPdfPage, renderToCanvas, type RenderHandle } from '@/lib/client/pdfjs';
import { downloadBytes, pickFile } from '@/lib/client/imageUtils';
import type { PageInfo } from '@/lib/pdf/types';

const THUMB_W = 132;

const Thumb = memo(function Thumb({ info, active, selected, onClick, onDragTo }: { info: PageInfo; active: boolean; selected: boolean; onClick: (e: React.MouseEvent) => void; onDragTo: (from: string, toIndex: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [over, setOver] = useState(false);
  const zoom = THUMB_W / info.width;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setVisible(es.some((e) => e.isIntersecting)), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !ref.current) return;
    let cancelled = false;
    let h: RenderHandle | null = null;
    (async () => {
      const src = await useEditor.getState().engine().getRenderSource(info.uid);
      const page = await getPdfPage(src);
      if (cancelled || !ref.current) return;
      const handle = renderToCanvas(page, ref.current, zoom, { maxPixels: 400_000 });
      h = handle;
      await handle.promise.catch(() => undefined);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      h?.cancel();
    };
  }, [visible, info.uid, info.version, zoom]);

  return (
    <div
      ref={box}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/page-uid', info.uid)}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const from = e.dataTransfer.getData('text/page-uid');
        if (from && from !== info.uid) onDragTo(from, info.index);
      }}
      onClick={onClick}
      className={`group relative cursor-pointer rounded p-1 ${active ? 'bg-brand-100 dark:bg-brand-700/40' : ''} ${selected ? 'ring-2 ring-brand-500' : ''} ${over ? 'border-t-4 border-brand-500' : ''}`}
      data-testid="thumb"
    >
      <div className="mx-auto bg-white shadow" style={{ width: THUMB_W, height: info.height * zoom }}>
        <canvas ref={ref} />
      </div>
      <div className="mt-1 text-center text-xs text-slate-500">{info.index + 1}</div>
    </div>
  );
});

export default function ThumbnailSidebar({ onNavigate }: { onNavigate: (index: number) => void }) {
  const info = useEditor((s) => s.info);
  const current = useEditor((s) => s.currentPage);
  const act = useEditor((s) => s.act);
  const [selected, setSelected] = useState<string[]>([]);
  if (!info) return null;
  const targets = selected.length ? selected : [info.pages[current]?.uid].filter(Boolean);

  return (
    <aside className="panel flex h-full w-[168px] shrink-0 flex-col border-r" data-testid="thumbnails">
      <div className="flex flex-wrap gap-1 border-b border-slate-200 p-1.5 dark:border-slate-800">
        <button className="tool" title="Rotate left" onClick={() => act('Rotate', (e) => e.rotatePages(targets, -90))}>⟲</button>
        <button className="tool" title="Rotate right" onClick={() => act('Rotate', (e) => e.rotatePages(targets, 90))}>⟳</button>
        <button className="tool" title="Duplicate" onClick={() => targets[0] && act('Duplicate', (e) => e.duplicatePage(targets[0]))}>⧉</button>
        <button
          className="tool"
          title="Delete"
          data-testid="delete-page"
          onClick={async () => {
            if (targets.length >= info.pageCount) return useEditor.getState().toast('warning', 'A document needs at least one page.');
            await act('Delete pages', (e) => e.deletePages(targets));
            setSelected([]);
          }}
        >
          🗑
        </button>
        <button className="tool" title="Insert blank page after" onClick={() => act('Insert page', (e) => e.insertBlankPage(current + 1))}>＋</button>
        <button
          className="tool"
          title="Insert pages from PDF"
          onClick={async () => {
            const [f] = await pickFile('application/pdf');
            if (f) await act('Insert PDF', async (e) => e.insertPdf(current + 1, new Uint8Array(await f.arrayBuffer())));
          }}
        >
          ⤓
        </button>
        <button
          className="tool"
          title="Extract selected pages"
          onClick={async () => {
            const bytes = await useEditor.getState().engine().extractPages(targets);
            downloadBytes(bytes, `pages-${targets.length}.pdf`);
          }}
        >
          ⇪
        </button>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {info.pages.map((p) => (
          <Thumb
            key={p.uid}
            info={p}
            active={p.index === current}
            selected={selected.includes(p.uid)}
            onClick={(e) => {
              if (e.ctrlKey || e.metaKey || e.shiftKey) setSelected((s) => (s.includes(p.uid) ? s.filter((x) => x !== p.uid) : [...s, p.uid]));
              else {
                setSelected([]);
                onNavigate(p.index);
              }
            }}
            onDragTo={(from, to) => act('Move page', (e) => e.movePage(from, to))}
          />
        ))}
      </div>
    </aside>
  );
}
