'use client';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useEditor } from '@/store/editorStore';
import { getPdfPage, renderToCanvas } from '@/lib/client/pdfjs';
import { PageCoords } from '@/lib/client/coords';
import type { FormField, PageInfo } from '@/lib/pdf/types';
import TextEditor from './TextEditor';

const PageOverlay = dynamic(() => import('./PageOverlay'), { ssr: false });

interface Props {
  info: PageInfo;
  zoom: number;
  /** Render when visible (virtualized). */
  visible: boolean;
  fields: FormField[];
}

function PageCanvasInner({ info, zoom, visible, fields }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const model = useEditor((s) => s.models[info.uid]);
  const editing = useEditor((s) => s.editing);
  const tool = useEditor((s) => s.tool);
  const fieldTool = useEditor((s) => s.fieldTool);
  const ensureModel = useEditor((s) => s.ensureModel);
  const [rendered, setRendered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const coords = useMemo(() => new PageCoords(info, zoom), [info, zoom]);

  useEffect(() => {
    if (visible) ensureModel(info.uid);
  }, [visible, info.uid, info.version, ensureModel]);

  useEffect(() => {
    if (!visible || !canvasRef.current) return;
    let cancelled = false;
    let handle: { cancel(): void } | null = null;
    const key = `${info.uid}@${info.version}@${zoom}`;
    (async () => {
      try {
        const src = await useEditor.getState().engine().getRenderSource(info.uid);
        if (cancelled) return;
        const page = await getPdfPage(src);
        if (cancelled || !canvasRef.current) return;
        const h = renderToCanvas(page, canvasRef.current, zoom);
        handle = h;
        await h.promise;
        if (!cancelled) {
          setRendered(key);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      handle?.cancel();
    };
  }, [visible, info.uid, info.version, zoom]);

  const w = info.width * zoom;
  const h = info.height * zoom;
  const pageFields = tool === 'forms' && fieldTool === 'fill' ? fields.filter((f) => f.widgets.some((wd) => wd.pageUid === info.uid)) : [];

  return (
    <div className="relative mx-auto bg-white shadow-md ring-1 ring-black/5" style={{ width: w, height: h }} data-page-uid={info.uid} data-testid="page">
      <canvas ref={canvasRef} className="absolute inset-0" style={{ width: w, height: h }} />
      {!rendered && visible && !error && <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400">Rendering…</div>}
      {error && <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-red-600">Render error: {error}</div>}
      {visible && model && model.version === info.version && <PageOverlay model={model} coords={coords} />}
      {model?.degraded && (
        <div className="absolute left-1 top-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800" title={model.warnings.join('\n')}>
          Partially interpreted
        </div>
      )}
      {editing && editing.pageUid === info.uid && <TextEditor coords={coords} model={model ?? null} />}
      {pageFields.map((f) => (
        <FieldInputs key={f.name} field={f} uid={info.uid} coords={coords} />
      ))}
    </div>
  );
}

function FieldInputs({ field, uid, coords }: { field: FormField; uid: string; coords: PageCoords }) {
  const act = useEditor((s) => s.act);
  const refreshFields = () => window.dispatchEvent(new CustomEvent('fields-changed'));
  const commit = async (v: string | boolean | string[]) => {
    await act('Fill field', (e) => e.setFieldValue(field.name, v));
    refreshFields();
  };
  return (
    <>
      {field.widgets
        .filter((wd) => wd.pageUid === uid)
        .map((wd, i) => {
          const r = coords.rectToView(wd.rect);
          const style: React.CSSProperties = { position: 'absolute', left: r.x, top: r.y, width: r.width, height: r.height, fontSize: Math.max(8, Math.min(r.height * 0.6, 14 * coords.zoom)) };
          const common = 'border border-brand-500/60 bg-brand-50/80 text-slate-900 outline-none focus:ring-2 focus:ring-brand-500';
          if (field.readOnly) return null;
          if (field.type === 'checkbox')
            return <input key={i} type="checkbox" style={style} className="accent-brand-600" defaultChecked={field.value === true} onChange={(e) => commit(e.target.checked)} title={field.name} />;
          if (field.type === 'radio')
            return (
              <select key={i} style={style} className={common} defaultValue={String(field.value)} onChange={(e) => commit(e.target.value)} title={field.name}>
                <option value="">—</option>
                {field.options.map((o) => <option key={o}>{o}</option>)}
              </select>
            );
          if (field.type === 'dropdown' || field.type === 'optionlist')
            return (
              <select key={i} style={style} className={common} defaultValue={String(field.value)} onChange={(e) => commit(e.target.value)} title={field.name}>
                <option value="">—</option>
                {field.options.map((o) => <option key={o}>{o}</option>)}
              </select>
            );
          if (field.type === 'text')
            return field.multiline ? (
              <textarea key={i} style={style} className={common} defaultValue={String(field.value)} onBlur={(e) => e.target.value !== field.value && commit(e.target.value)} title={field.name} />
            ) : (
              <input key={i} style={style} className={common} defaultValue={String(field.value)} onBlur={(e) => e.target.value !== field.value && commit(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} title={field.name} />
            );
          if (field.type === 'signature')
            return (
              <button key={i} style={style} className={`${common} text-xs`} onClick={() => useEditor.getState().openDialog('signature', { rect: wd.rect, pageUid: uid })}>
                ✍ Sign here
              </button>
            );
          return null;
        })}
    </>
  );
}

export default memo(PageCanvasInner);
