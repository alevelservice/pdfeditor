'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useEditor, type AnnotTool, type FieldTool, type ShapeTool, type Tool } from '@/store/editorStore';
import { downloadBytes, fileToPdfImage, pickFile } from '@/lib/client/imageUtils';

const TOOLS: { id: Tool; label: string; icon: string; key: string }[] = [
  { id: 'select', label: 'Select', icon: '➤', key: 'V' },
  { id: 'editText', label: 'Edit Text', icon: 'T̲', key: 'T' },
  { id: 'editImage', label: 'Edit Image', icon: '🖼', key: 'I' },
  { id: 'addText', label: 'Add Text', icon: 'T+', key: 'A' },
  { id: 'shapes', label: 'Shapes', icon: '◻', key: 'S' },
  { id: 'annotate', label: 'Annotate', icon: '🖍', key: 'N' },
  { id: 'forms', label: 'Forms', icon: '☑', key: 'F' },
  { id: 'sign', label: 'Sign', icon: '✍', key: 'G' },
  { id: 'redact', label: 'Redact', icon: '▇', key: 'R' },
];

function Menu({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <button className="btn" onClick={() => setOpen((o) => !o)} data-testid={testId}>
        {label} ▾
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-60 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-800" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

export default function Toolbar({ onFit }: { onFit: (mode: 'width' | 'page') => void }) {
  const s = useEditor();
  const info = s.info;

  const save = async (incremental: boolean) => {
    const bytes = await s.act('Saving', (e) => e.save({ incremental }));
    if (bytes) {
      downloadBytes(bytes, s.fileName.replace(/\.pdf$/i, '') + '-edited.pdf');
      await s.saveNow();
    }
  };

  const sub = (() => {
    if (s.tool === 'shapes')
      return (['rect', 'ellipse', 'line', 'arrow', 'freehand'] as ShapeTool[]).map((t) => (
        <button key={t} className={`tool ${s.shapeTool === t ? 'tool-active' : ''}`} onClick={() => s.set({ shapeTool: t })}>
          {{ rect: '▭ Rect', ellipse: '◯ Ellipse', line: '╱ Line', arrow: '→ Arrow', freehand: '✎ Freehand' }[t]}
        </button>
      ));
    if (s.tool === 'annotate')
      return (['Highlight', 'Underline', 'StrikeOut', 'Text', 'FreeText', 'Ink', 'Link'] as AnnotTool[]).map((t) => (
        <button key={t} className={`tool ${s.annotTool === t ? 'tool-active' : ''}`} onClick={() => s.set({ annotTool: t })} data-testid={`annot-${t}`}>
          {{ Highlight: '🖍 Highlight', Underline: 'U̲ Underline', StrikeOut: 'S̶ Strike', Text: '🗨 Note', FreeText: '💬 Comment', Ink: '✎ Ink', Link: '🔗 Link' }[t]}
        </button>
      ));
    if (s.tool === 'forms')
      return (
        <>
          {(['fill', 'text', 'checkbox', 'radio', 'dropdown', 'signature'] as FieldTool[]).map((t) => (
            <button key={t} className={`tool ${s.fieldTool === t ? 'tool-active' : ''}`} onClick={() => s.set({ fieldTool: t })}>
              {{ fill: '✏ Fill', text: '▭ Text field', checkbox: '☑ Checkbox', radio: '◉ Radio', dropdown: '▾ Dropdown', signature: '✍ Signature field' }[t]}
            </button>
          ))}
          <button className="tool" onClick={() => s.act('Flatten form', (e) => e.flattenForm())}>Flatten form</button>
        </>
      );
    if (s.tool === 'redact')
      return (
        <>
          <span className="text-xs text-slate-500">{s.redactions.length} area(s) marked</span>
          <button
            className="btn btn-danger"
            disabled={!s.redactions.length}
            data-testid="apply-redactions"
            onClick={async () => {
              const groups = new Map<string, typeof s.redactions>();
              for (const r of s.redactions) groups.set(r.pageUid, [...(groups.get(r.pageUid) ?? []), r]);
              const stats = await s.act('Apply redactions', (e) => e.redact([...groups].map(([pageUid, list]) => ({ pageUid, rects: list.map((x) => x.rect) }))));
              if (stats) {
                s.set({ redactions: [] });
                s.toast('success', `Removed ${stats.glyphs} glyphs, ${stats.paths} paths; ${stats.images} images redacted pixel-wise${stats.imagesRemoved ? `, ${stats.imagesRemoved} removed` : ''}.`);
                stats.warnings.slice(0, 2).forEach((w) => s.toast('warning', w));
              }
            }}
          >
            Apply redactions
          </button>
          <button className="btn" onClick={() => s.set({ redactions: [] })}>Clear marks</button>
        </>
      );
    if (s.tool === 'sign')
      return (
        <>
          <button className="btn" onClick={() => s.openDialog('signature')}>Create signature…</button>
          {s.pendingImage && <span className="text-xs text-brand-600">Click on the page to place it</span>}
        </>
      );
    if (s.tool === 'addText' || s.tool === 'editText') return <span className="text-xs text-slate-500">{s.tool === 'addText' ? 'Click (or drag a box) to add text. Ctrl+Enter to finish.' : 'Click any text to edit it in place.'}</span>;
    if (s.tool === 'editImage')
      return (
        <button
          className="btn"
          onClick={async () => {
            const [f] = await pickFile('image/png,image/jpeg,image/webp,image/svg+xml');
            if (!f) return;
            const img = await fileToPdfImage(f);
            s.set({ pendingImage: { ...img, purpose: 'image' } });
            s.toast('info', 'Click on a page to place the image.');
          }}
        >
          Insert image…
        </button>
      );
    return null;
  })();

  return (
    <div className="panel z-30 border-b">
      <div className="flex flex-wrap items-center gap-1 px-2 py-1.5">
        <Link href="/" className="tool font-semibold" title="Home">⌂</Link>
        <span className="mr-2 hidden max-w-[16rem] truncate text-sm font-medium sm:inline" title={s.fileName}>{s.fileName}</span>
        <div className="flex flex-wrap items-center gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
          {TOOLS.map((t) => (
            <button key={t.id} className={`tool ${s.tool === t.id ? 'tool-active' : ''}`} title={`${t.label} (${t.key})`} onClick={() => s.setTool(t.id)} data-testid={`tool-${t.id}`}>
              <span>{t.icon}</span>
              <span className="hidden 2xl:inline">{t.label}</span>
            </button>
          ))}
        </div>
        <div className="mx-1 h-6 w-px bg-slate-300 dark:bg-slate-700" />
        <button className="tool" title={`Undo ${info?.undoLabel ?? ''} (Ctrl+Z)`} disabled={!info?.canUndo} onClick={() => s.undo()} data-testid="undo">↶</button>
        <button className="tool" title={`Redo ${info?.redoLabel ?? ''} (Ctrl+Y)`} disabled={!info?.canRedo} onClick={() => s.redo()} data-testid="redo">↷</button>
        <div className="mx-1 h-6 w-px bg-slate-300 dark:bg-slate-700" />
        <button className="tool" title="Zoom out" onClick={() => s.set({ zoom: Math.max(0.25, +(s.zoom / 1.2).toFixed(3)), fit: null })}>−</button>
        <select className="input w-24" value={s.fit ?? String(s.zoom)} onChange={(e) => {
          const v = e.target.value;
          if (v === 'width' || v === 'page') onFit(v);
          else s.set({ zoom: Number(v), fit: null });
        }} aria-label="Zoom">
          <option value="width">Fit width</option>
          <option value="page">Fit page</option>
          {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
          {!s.fit && ![0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].includes(s.zoom) && <option value={s.zoom}>{Math.round(s.zoom * 100)}%</option>}
        </select>
        <button className="tool" title="Zoom in" onClick={() => s.set({ zoom: Math.min(4, +(s.zoom * 1.2).toFixed(3)), fit: null })}>＋</button>
        <div className="ml-auto flex items-center gap-1">
          <button className="tool" title="Find & Replace (Ctrl+F)" onClick={() => s.openDialog('find')} data-testid="open-find">🔍</button>
          <Menu label="Document">
            <button className="menu-item" onClick={() => s.openDialog('stamp', { kind: 'watermark' })}>Watermark…</button>
            <button className="menu-item" onClick={() => s.openDialog('stamp', { kind: 'header' })}>Header / footer…</button>
            <button className="menu-item" onClick={() => s.openDialog('stamp', { kind: 'pageNumbers' })}>Page numbers…</button>
            <button className="menu-item" onClick={() => s.openDialog('stamp', { kind: 'bates' })}>Bates numbering…</button>
            <hr className="my-1 border-slate-200 dark:border-slate-700" />
            <button className="menu-item" onClick={() => s.openDialog('ocr')}>OCR scanned pages…</button>
            <button className="menu-item" onClick={() => s.openDialog('pages')}>Merge / split / insert…</button>
            <button className="menu-item" onClick={() => s.openDialog('pageBox')}>Crop / resize page…</button>
            <button className="menu-item" onClick={() => s.act('Flatten annotations', (e) => e.flattenAnnotations())}>Flatten annotations</button>
            <button className="menu-item" onClick={() => s.act('Flatten form', (e) => e.flattenForm())}>Flatten form fields</button>
            <button className="menu-item" onClick={() => s.openDialog('metadata')}>Properties / metadata…</button>
            <button className="menu-item" onClick={() => s.openDialog('fonts')}>Upload a font…</button>
          </Menu>
          <Menu label="Save" testId="save-menu">
            <button className="menu-item" onClick={() => save(false)} data-testid="save-pdf">Download PDF</button>
            <button className="menu-item" disabled={!info?.canIncrementalSave} onClick={() => save(true)}>Download (incremental save)</button>
            <button className="menu-item" onClick={() => s.openDialog('export', { mode: 'compress' })}>Compress…</button>
            <button className="menu-item" onClick={() => s.openDialog('export', { mode: 'protect' })}>Password protect…</button>
            <hr className="my-1 border-slate-200 dark:border-slate-700" />
            <button className="menu-item" onClick={() => s.openDialog('export', { mode: 'images' })}>Export pages as PNG / JPG…</button>
            <button
              className="menu-item"
              onClick={async () => {
                const bytes = await s.act('Exporting DOCX', (e) => e.exportDocx());
                if (bytes) downloadBytes(bytes, s.fileName.replace(/\.pdf$/i, '') + '.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
              }}
            >
              Export as DOCX (best effort)
            </button>
          </Menu>
          <button
            className="tool"
            title="Toggle dark mode"
            onClick={() => {
              const dark = document.documentElement.classList.toggle('dark');
              localStorage.setItem('theme', dark ? 'dark' : 'light');
              s.set({ dark });
            }}
          >
            ◐
          </button>
        </div>
      </div>
      {sub && <div className="flex flex-wrap items-center gap-1 border-t border-slate-200 px-2 py-1 dark:border-slate-800">{sub}</div>}
    </div>
  );
}
