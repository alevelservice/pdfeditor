'use client';
import { useEffect, useMemo, useState } from 'react';
import { useEditor } from '@/store/editorStore';
import { FAMILY_LABELS } from '@/lib/pdf/fontList';
import { hexToRgb, rgbToHex } from '@/lib/client/imageUtils';
import type { Matrix, PageModel, RGB, TextStyle } from '@/lib/pdf/types';
import ImageReplacer from './ImageReplacer';

function ColorInput({ value, onChange, allowNone, label }: { value: RGB | null; onChange: (c: RGB | null) => void; allowNone?: boolean; label: string }) {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex items-center gap-2">
        <input type="color" value={rgbToHex(value ?? { r: 0, g: 0, b: 0 })} disabled={value === null} onChange={(e) => onChange(hexToRgb(e.target.value))} className="h-8 w-12 cursor-pointer rounded border border-slate-300 dark:border-slate-600" />
        {allowNone && (
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={value === null} onChange={(e) => onChange(e.target.checked ? null : { r: 0, g: 0, b: 0 })} /> none
          </label>
        )}
      </div>
    </div>
  );
}

function Arrange({ uid, id }: { uid: string; id: string }) {
  const act = useEditor((s) => s.act);
  return (
    <div>
      <label className="label">Arrange</label>
      <div className="grid grid-cols-4 gap-1">
        {(['front', 'forward', 'backward', 'back'] as const).map((w) => (
          <button key={w} className="btn px-1 text-xs" title={`Bring ${w}`} onClick={() => act('Arrange', (e) => e.reorderObject(uid, id, w))}>
            {{ front: '⤒ Front', forward: '↑ Fwd', backward: '↓ Back', back: '⤓ Bottom' }[w]}
          </button>
        ))}
      </div>
    </div>
  );
}

function TextProps({ uid, ids, model }: { uid: string; ids: string[]; model: PageModel }) {
  const { act, set } = useEditor.getState();
  const block = model.blocks.find((b) => b.id === ids[0]);
  const line = block ? model.lines.find((l) => l.id === block.lineIds[0]) : undefined;
  const run = line ? model.texts.find((t) => t.id === line.runIds[0]) : undefined;
  const [style, setStyle] = useState<TextStyle>({});
  useEffect(() => setStyle({}), [ids.join(','), model.version]);
  if (!block || !run) return null;
  const locked = block.lineIds.flatMap((lid) => model.lines.find((l) => l.id === lid)?.runIds ?? []).map((rid) => model.texts.find((t) => t.id === rid)).find((t) => t && !t.editable);
  const formIndex = locked && /^f(\d+)/.exec(locked.id)?.[1];
  const apply = () => Object.keys(style).length && act('Text style', (e) => e.setTextStyle(uid, ids, style));
  const v = <K extends keyof TextStyle>(k: K, def: TextStyle[K]) => (style[k] ?? def) as NonNullable<TextStyle[K]>;

  return (
    <div className="space-y-3">
      <div className="rounded bg-slate-50 p-2 text-xs dark:bg-slate-800">
        <div className="font-medium">{run.font.baseFont}</div>
        <div className="text-slate-500">
          {run.font.subtype}
          {run.font.embedded ? ' · embedded' : ' · not embedded'}
          {/^[A-Z]{6}\+/.test(run.font.baseFont) ? ' · subset' : ''}
          {run.font.type3 ? ' · Type3 (edits re-set with a similar font)' : ''}
          {run.renderMode === 3 ? ' · invisible (OCR layer)' : ''}
        </div>
      </div>
      {locked && (
        <div className="rounded bg-amber-50 p-2 text-xs text-amber-800">
          {locked.readOnlyReason}
          {formIndex && (
            <button className="btn mt-1 w-full" onClick={() => act('Make editable', (e) => e.inlineForm(uid, Number(formIndex)))}>
              Make editable
            </button>
          )}
        </div>
      )}
      <button className="btn btn-primary w-full" disabled={!!locked} onClick={() => set({ editing: { pageUid: uid, blockId: block.id, rect: block.bbox, text: block.text } })}>
        ✎ Edit text
      </button>
      <div>
        <label className="label">Font</label>
        <select className="input" value={style.fontFamily ?? 'Original'} onChange={(e) => setStyle({ ...style, fontFamily: e.target.value })}>
          <option value="Original">Original ({run.font.family})</option>
          {Object.entries(FAMILY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Size (pt)</label>
          <input className="input" type="number" min={1} step={0.5} value={v('fontSize', +block.fontSize.toFixed(2))} onChange={(e) => setStyle({ ...style, fontSize: Number(e.target.value) })} />
        </div>
        <ColorInput label="Color" value={style.color ?? run.color.rgb ?? { r: 0, g: 0, b: 0 }} onChange={(c) => c && setStyle({ ...style, color: c })} />
      </div>
      <div className="flex gap-1">
        <button className={`btn flex-1 font-bold ${v('bold', run.font.bold) ? 'tool-active' : ''}`} onClick={() => setStyle({ ...style, bold: !v('bold', run.font.bold) })}>B</button>
        <button className={`btn flex-1 italic ${v('italic', run.font.italic) ? 'tool-active' : ''}`} onClick={() => setStyle({ ...style, italic: !v('italic', run.font.italic) })}>I</button>
      </div>
      <div>
        <label className="label">Alignment</label>
        <div className="grid grid-cols-4 gap-1">
          {(['left', 'center', 'right', 'justify'] as const).map((a) => (
            <button key={a} className={`btn px-1 text-xs ${v('align', block.align) === a ? 'tool-active' : ''}`} onClick={() => setStyle({ ...style, align: a })}>
              {{ left: '⇤', center: '↔', right: '⇥', justify: '☰' }[a]}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Line height</label>
          <input className="input" type="number" min={0.5} max={4} step={0.05} value={v('lineHeight', +(block.lineHeight / block.fontSize).toFixed(2))} onChange={(e) => setStyle({ ...style, lineHeight: Number(e.target.value) })} />
        </div>
        <div>
          <label className="label">Letter spacing</label>
          <input className="input" type="number" step={0.1} value={v('charSpacing', +run.charSpacing.toFixed(2))} onChange={(e) => setStyle({ ...style, charSpacing: Number(e.target.value) })} />
        </div>
      </div>
      <button className="btn btn-primary w-full" disabled={!Object.keys(style).length || !!locked} onClick={apply} data-testid="apply-style">
        Apply style
      </button>
      <div className="grid grid-cols-2 gap-1">
        <button className="btn" disabled={!!locked} onClick={() => act('Reflow paragraph', (e) => e.editBlock(uid, block.id, block.text.replace(/\n/g, ' '), undefined, true))}>Reflow</button>
        <button className="btn" disabled={!!locked} onClick={() => act('Delete text', (e) => e.deleteObjects(uid, ids))}>Delete</button>
      </div>
      <Arrange uid={uid} id={block.id} />
    </div>
  );
}

function PathProps({ uid, id, model }: { uid: string; id: string; model: PageModel }) {
  const act = useEditor((s) => s.act);
  const p = model.paths.find((x) => x.id === id);
  const [fill, setFill] = useState<RGB | null | undefined>(undefined);
  const [stroke, setStroke] = useState<RGB | null | undefined>(undefined);
  const [lw, setLw] = useState<number | undefined>(undefined);
  useEffect(() => {
    setFill(undefined);
    setStroke(undefined);
    setLw(undefined);
  }, [id, model.version]);
  if (!p) return null;
  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-500">Path · {p.ops.length} operators{p.clip ? ' · clipping' : ''}</div>
      {!p.editable && <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">{p.readOnlyReason}</p>}
      <div className="grid grid-cols-2 gap-2">
        <ColorInput label="Fill" allowNone value={fill !== undefined ? fill : p.fill?.rgb ?? null} onChange={setFill} />
        <ColorInput label="Stroke" allowNone value={stroke !== undefined ? stroke : p.stroke?.rgb ?? null} onChange={setStroke} />
      </div>
      <div>
        <label className="label">Line width</label>
        <input className="input" type="number" min={0} step={0.25} value={lw ?? p.lineWidth} onChange={(e) => setLw(Number(e.target.value))} />
      </div>
      <button className="btn btn-primary w-full" disabled={!p.editable || (fill === undefined && stroke === undefined && lw === undefined)} onClick={() => act('Path style', (e) => e.stylePath(uid, id, { fill, stroke, lineWidth: lw }))}>
        Apply
      </button>
      <button className="btn w-full" disabled={!p.editable} onClick={() => act('Delete path', (e) => e.deleteObjects(uid, [id]))}>Delete</button>
      <Arrange uid={uid} id={id} />
    </div>
  );
}

function AnnotProps({ uid, id, model }: { uid: string; id: string; model: PageModel }) {
  const act = useEditor((s) => s.act);
  const info = useEditor((s) => s.info);
  const a = model.annotations.find((x) => x.id === id);
  const [contents, setContents] = useState(a?.contents ?? '');
  const [uri, setUri] = useState(a?.uri ?? '');
  const [dest, setDest] = useState(a?.destPage !== undefined ? String(a.destPage + 1) : '');
  useEffect(() => {
    setContents(a?.contents ?? '');
    setUri(a?.uri ?? '');
    setDest(a?.destPage !== undefined ? String(a.destPage + 1) : '');
  }, [a?.id, model.version]);
  if (!a) return null;
  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-500">{a.rawSubtype} annotation{a.author ? ` · ${a.author}` : ''}</div>
      {a.subtype === 'Link' ? (
        <>
          <div>
            <label className="label">URL</label>
            <input className="input" value={uri} placeholder="https://…" onChange={(e) => setUri(e.target.value)} />
          </div>
          <div>
            <label className="label">…or go to page</label>
            <input className="input" type="number" min={1} max={info?.pageCount} value={dest} onChange={(e) => setDest(e.target.value)} />
          </div>
          <button className="btn btn-primary w-full" onClick={() => act('Edit link', (e) => e.updateAnnotation(uid, a.index, dest ? { destPage: Number(dest) - 1 } : { uri }))}>Save link</button>
        </>
      ) : (
        <>
          <div>
            <label className="label">Comment</label>
            <textarea className="input h-24" value={contents} onChange={(e) => setContents(e.target.value)} />
          </div>
          <ColorInput label="Color" value={a.color} onChange={(c) => c && act('Annotation color', (e) => e.updateAnnotation(uid, a.index, { color: c }))} />
          <button className="btn btn-primary w-full" onClick={() => act('Edit comment', (e) => e.updateAnnotation(uid, a.index, { contents }))}>Save comment</button>
        </>
      )}
      <button className="btn w-full" onClick={() => act('Delete annotation', (e) => e.removeAnnotation(uid, a.index))}>Delete</button>
    </div>
  );
}

function MultiProps({ uid, ids, model }: { uid: string; ids: string[]; model: PageModel }) {
  const act = useEditor((s) => s.act);
  const rects = useMemo(() => {
    const all = [...model.blocks.map((b) => ({ id: b.id, r: b.bbox })), ...model.images.map((i) => ({ id: i.id, r: i.bbox })), ...model.paths.map((p) => ({ id: p.id, r: p.bbox })), ...model.annotations.map((a) => ({ id: a.id, r: a.rect }))];
    return all.filter((x) => ids.includes(x.id));
  }, [ids, model]);
  const align = async (mode: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') => {
    const minX = Math.min(...rects.map((x) => x.r.x));
    const maxX = Math.max(...rects.map((x) => x.r.x + x.r.width));
    const minY = Math.min(...rects.map((x) => x.r.y));
    const maxY = Math.max(...rects.map((x) => x.r.y + x.r.height));
    await act('Align', async (e) => {
      for (const { id, r } of rects) {
        let dx = 0, dy = 0;
        if (mode === 'left') dx = minX - r.x;
        if (mode === 'right') dx = maxX - (r.x + r.width);
        if (mode === 'hcenter') dx = (minX + maxX) / 2 - (r.x + r.width / 2);
        if (mode === 'bottom') dy = minY - r.y;
        if (mode === 'top') dy = maxY - (r.y + r.height);
        if (mode === 'vcenter') dy = (minY + maxY) / 2 - (r.y + r.height / 2);
        if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) await e.transformObjects(uid, [id], [1, 0, 0, 1, dx, dy] as Matrix);
      }
      return { warnings: [] };
    });
  };
  return (
    <div className="space-y-3">
      <div className="text-sm">{ids.length} objects selected</div>
      <div>
        <label className="label">Align</label>
        <div className="grid grid-cols-3 gap-1 text-xs">
          <button className="btn" onClick={() => align('left')}>⇤ Left</button>
          <button className="btn" onClick={() => align('hcenter')}>↔ Center</button>
          <button className="btn" onClick={() => align('right')}>⇥ Right</button>
          <button className="btn" onClick={() => align('top')}>⤒ Top</button>
          <button className="btn" onClick={() => align('vcenter')}>↕ Middle</button>
          <button className="btn" onClick={() => align('bottom')}>⤓ Bottom</button>
        </div>
      </div>
      <button className="btn w-full" onClick={() => act('Delete', (e) => e.deleteObjects(uid, ids))}>Delete all</button>
    </div>
  );
}

function Defaults() {
  const s = useEditor();
  if (s.tool === 'addText')
    return (
      <div className="space-y-3">
        <div>
          <label className="label">Font</label>
          <select className="input" value={s.textDefaults.fontFamily} onChange={(e) => s.set({ textDefaults: { ...s.textDefaults, fontFamily: e.target.value } })}>
            {Object.entries(FAMILY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Size</label>
            <input className="input" type="number" min={1} value={s.textDefaults.fontSize} onChange={(e) => s.set({ textDefaults: { ...s.textDefaults, fontSize: Number(e.target.value) } })} />
          </div>
          <ColorInput label="Color" value={s.textDefaults.color} onChange={(c) => c && s.set({ textDefaults: { ...s.textDefaults, color: c } })} />
        </div>
        <div className="flex gap-1">
          <button className={`btn flex-1 font-bold ${s.textDefaults.bold ? 'tool-active' : ''}`} onClick={() => s.set({ textDefaults: { ...s.textDefaults, bold: !s.textDefaults.bold } })}>B</button>
          <button className={`btn flex-1 italic ${s.textDefaults.italic ? 'tool-active' : ''}`} onClick={() => s.set({ textDefaults: { ...s.textDefaults, italic: !s.textDefaults.italic } })}>I</button>
        </div>
      </div>
    );
  if (s.tool === 'shapes')
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <ColorInput label="Stroke" allowNone value={s.shapeDefaults.stroke} onChange={(c) => s.set({ shapeDefaults: { ...s.shapeDefaults, stroke: c } })} />
          <ColorInput label="Fill" allowNone value={s.shapeDefaults.fill} onChange={(c) => s.set({ shapeDefaults: { ...s.shapeDefaults, fill: c } })} />
        </div>
        <div>
          <label className="label">Line width</label>
          <input className="input" type="number" min={0.25} step={0.25} value={s.shapeDefaults.lineWidth} onChange={(e) => s.set({ shapeDefaults: { ...s.shapeDefaults, lineWidth: Number(e.target.value) } })} />
        </div>
      </div>
    );
  if (s.tool === 'annotate') return <ColorInput label="Highlight color" value={s.annotColor} onChange={(c) => c && s.set({ annotColor: c })} />;
  return null;
}

function PageProps() {
  const s = useEditor();
  const page = s.info?.pages[s.currentPage];
  const model = page ? s.models[page.uid] : undefined;
  if (!page) return null;
  return (
    <div className="space-y-2 text-sm">
      <div className="font-medium">Page {page.index + 1}</div>
      <div className="text-xs text-slate-500">
        {page.width.toFixed(1)} × {page.height.toFixed(1)} pt ({((page.width / 72) * 25.4).toFixed(0)} × {((page.height / 72) * 25.4).toFixed(0)} mm) · rotation {page.rotation}°
      </div>
      {model && (
        <div className="text-xs text-slate-500">
          {model.blocks.length} text blocks · {model.images.length} images · {model.paths.length} paths · {model.annotations.length} annotations
        </div>
      )}
      {model?.warnings.length ? (
        <details className="text-xs text-amber-700">
          <summary>{model.warnings.length} parser warnings</summary>
          <ul className="list-disc pl-4">{model.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}

export default function PropertiesPanel() {
  const selection = useEditor((s) => s.selection);
  const model = useEditor((s) => (selection ? s.models[selection.pageUid] : undefined));
  let body: React.ReactNode = null;
  if (selection && model) {
    const { ids, pageUid } = selection;
    if (ids.length > 1) body = <MultiProps uid={pageUid} ids={ids} model={model} />;
    else {
      const id = ids[0];
      if (id.startsWith('b')) body = <TextProps uid={pageUid} ids={ids} model={model} />;
      else if (id.startsWith('i')) {
        const img = model.images.find((i) => i.id === id);
        body = img ? (
          <>
            <ImageReplacer uid={pageUid} image={img} />
            <div className="mt-3">
              <Arrange uid={pageUid} id={id} />
            </div>
          </>
        ) : null;
      } else if (id.startsWith('p')) body = <PathProps uid={pageUid} id={id} model={model} />;
      else if (id.startsWith('a')) body = <AnnotProps uid={pageUid} id={id} model={model} />;
    }
  }
  return (
    <aside className="panel h-full w-72 shrink-0 overflow-y-auto border-l p-3" data-testid="properties">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Properties</h2>
      {body ?? (
        <div className="space-y-4">
          <Defaults />
          <PageProps />
        </div>
      )}
    </aside>
  );
}
