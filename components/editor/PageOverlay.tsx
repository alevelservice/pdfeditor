'use client';
/**
 * Interactive Konva layer over a rendered page: hit areas for every object
 * of the page model, selection / multi-select, move / resize / rotate with
 * snapping guides, and drawing for the shape, annotation, form, redaction,
 * signature and add-text tools.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Layer, Line, Path, Rect as KRect, Stage, Transformer } from 'react-konva';
import type Konva from 'konva';
import { useEditor } from '@/store/editorStore';
import { normRect, type PageCoords } from '@/lib/client/coords';
import { invert, mul } from '@/lib/pdf/geom';
import type { Matrix, PageModel, Rect } from '@/lib/pdf/types';

interface Obj {
  id: string;
  kind: 'text' | 'image' | 'path' | 'annotation';
  rect: Rect;
  editable: boolean;
  reason?: string;
}

const MIN_HIT = 6;
const SNAP = 5;

function rgbCss(c: { r: number; g: number; b: number }, a = 1) {
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
}

export default function PageOverlay({ model, coords }: { model: PageModel; coords: PageCoords }) {
  const tool = useEditor((s) => s.tool);
  const shapeTool = useEditor((s) => s.shapeTool);
  const annotTool = useEditor((s) => s.annotTool);
  const fieldTool = useEditor((s) => s.fieldTool);
  const selection = useEditor((s) => s.selection);
  const editing = useEditor((s) => s.editing);
  const redactions = useEditor((s) => s.redactions);
  const pendingImage = useEditor((s) => s.pendingImage);
  const searchHits = useEditor((s) => s.searchHits);
  const activeHit = useEditor((s) => s.activeHit);
  const shapeDefaults = useEditor((s) => s.shapeDefaults);
  const annotColor = useEditor((s) => s.annotColor);
  const { select, set, act, openDialog, toast } = useEditor.getState();

  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const nodes = useRef(new Map<string, Konva.Rect>());
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number; pts: number[] } | null>(null);
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });
  const dragStart = useRef<{ id: string; x: number; y: number; others: Map<string, { x: number; y: number }> } | null>(null);
  const uid = model.uid;

  const editableRuns = useMemo(() => new Map(model.texts.map((t) => [t.id, t])), [model]);

  const objects = useMemo<Obj[]>(() => {
    const list: Obj[] = [];
    const showText = tool === 'select' || tool === 'editText';
    const showImages = tool === 'select' || tool === 'editImage';
    const showOthers = tool === 'select';
    if (showOthers) {
      for (const p of model.paths.slice(0, 4000)) {
        if (p.bbox.width * p.bbox.height > 0.85 * model.info.width * model.info.height) continue; // page backgrounds
        list.push({ id: p.id, kind: 'path', rect: coords.rectToView(p.bbox), editable: p.editable, reason: p.readOnlyReason });
      }
    }
    if (showImages) for (const im of model.images) list.push({ id: im.id, kind: 'image', rect: coords.rectToView(im.bbox), editable: im.editable, reason: im.readOnlyReason });
    if (showText) {
      for (const b of model.blocks) {
        const lineRuns = b.lineIds.flatMap((lid) => model.lines.find((l) => l.id === lid)?.runIds ?? []);
        const locked = lineRuns.map((r) => editableRuns.get(r)).find((r) => r && !r.editable);
        list.push({ id: b.id, kind: 'text', rect: coords.rectToView(b.bbox), editable: !locked, reason: locked?.readOnlyReason });
      }
    }
    if (showOthers || tool === 'annotate') for (const a of model.annotations) if (a.subtype !== 'Widget') list.push({ id: a.id, kind: 'annotation', rect: coords.rectToView(a.rect), editable: true });
    return list;
  }, [model, coords, tool, editableRuns]);

  const selectedIds = selection?.pageUid === uid ? selection.ids : [];

  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const sel = selectedIds.map((id) => nodes.current.get(id)).filter((n): n is Konva.Rect => !!n);
    const editable = sel.filter((n) => objects.find((o) => o.id === n.id())?.editable);
    tr.nodes(editable);
    tr.getLayer()?.batchDraw();
  }, [selectedIds, objects]);

  const pointer = () => stageRef.current?.getPointerPosition() ?? { x: 0, y: 0 };
  const userRect = (r: Rect) => coords.rectToUser(r);

  // ---------------------------------------------------------------- transforms
  const commitTransform = async (node: Konva.Node, ids: string[]) => {
    const o = objects.find((x) => x.id === node.id());
    if (!o) return;
    const m = node.getTransform().getMatrix() as Matrix;
    const T0: Matrix = [1, 0, 0, 1, o.rect.x, o.rect.y];
    const A = mul(invert(T0), m);
    // Reset visual state; the refreshed model re-renders the object at its new place.
    node.setAttrs({ x: o.rect.x, y: o.rect.y, scaleX: 1, scaleY: 1, rotation: 0 });
    if (Math.abs(A[0] - 1) < 1e-4 && Math.abs(A[3] - 1) < 1e-4 && Math.abs(A[1]) < 1e-4 && Math.abs(A[2]) < 1e-4 && Math.abs(A[4]) < 0.5 && Math.abs(A[5]) < 0.5) return;
    const D = coords.viewToUserTransform(A);
    await act('Transform', (e) => e.transformObjects(uid, ids, D));
  };

  const snapTargets = useMemo(() => {
    const v = [0, coords.width / 2, coords.width];
    const h = [0, coords.height / 2, coords.height];
    for (const o of objects) {
      if (selectedIds.includes(o.id)) continue;
      v.push(o.rect.x, o.rect.x + o.rect.width);
      h.push(o.rect.y, o.rect.y + o.rect.height);
    }
    return { v, h };
  }, [objects, coords, selectedIds]);

  const onDragMove = (e: Konva.KonvaEventObject<DragEvent>) => {
    const n = e.target;
    const w = n.width() * n.scaleX();
    const h = n.height() * n.scaleY();
    let x = n.x();
    let y = n.y();
    const gv: number[] = [];
    const gh: number[] = [];
    for (const [edge, off] of [[x, 0], [x + w / 2, w / 2], [x + w, w]] as const) {
      const t = snapTargets.v.find((v) => Math.abs(v - edge) < SNAP);
      if (t !== undefined) {
        x = t - off;
        gv.push(t);
        break;
      }
    }
    for (const [edge, off] of [[y, 0], [y + h / 2, h / 2], [y + h, h]] as const) {
      const t = snapTargets.h.find((v) => Math.abs(v - edge) < SNAP);
      if (t !== undefined) {
        y = t - off;
        gh.push(t);
        break;
      }
    }
    n.position({ x, y });
    setGuides({ v: gv, h: gh });
    const ds = dragStart.current;
    if (ds && ds.id === n.id()) {
      for (const [id, p] of ds.others) nodes.current.get(id)?.position({ x: p.x + (x - ds.x), y: p.y + (y - ds.y) });
    }
  };

  // ---------------------------------------------------------------- drawing
  const drawingTool =
    tool === 'shapes' ||
    tool === 'redact' ||
    (tool === 'annotate' && annotTool !== 'Text') ||
    (tool === 'forms' && fieldTool !== 'fill') ||
    tool === 'addText' ||
    tool === 'select' ||
    tool === 'editText' ||
    tool === 'editImage';

  const onStageDown = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (e.target !== e.target.getStage() && !(e.target.name() === 'bg')) return;
    const p = pointer();
    if (tool === 'select' || tool === 'editText' || tool === 'editImage') select(null);
    if (drawingTool) setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y, pts: [p.x, p.y] });
  };

  const onStageMove = () => {
    if (!draft) return;
    const p = pointer();
    const freehand = (tool === 'shapes' && shapeTool === 'freehand') || (tool === 'annotate' && annotTool === 'Ink');
    setDraft({ ...draft, x1: p.x, y1: p.y, pts: freehand ? [...draft.pts, p.x, p.y] : draft.pts });
  };

  const textRectsUnder = (r: Rect): Rect[] => {
    const ur = userRect(r);
    const out: Rect[] = [];
    for (const line of model.lines) {
      let lr: Rect | null = null;
      for (const rid of line.runIds) {
        const run = editableRuns.get(rid);
        if (!run) continue;
        for (const g of run.glyphs) {
          const b = g.bbox;
          const cx = b.x + b.width / 2;
          const cy = b.y + b.height / 2;
          if (cx >= ur.x && cx <= ur.x + ur.width && cy >= ur.y && cy <= ur.y + ur.height) {
            lr = lr ? normRect(Math.min(lr.x, b.x), Math.min(lr.y, b.y), Math.max(lr.x + lr.width, b.x + b.width), Math.max(lr.y + lr.height, b.y + b.height)) : { ...b };
          }
        }
      }
      if (lr) out.push(lr);
    }
    return out;
  };

  const onStageUp = async () => {
    const d = draft;
    setDraft(null);
    setGuides({ v: [], h: [] });
    if (!d) return;
    const r = normRect(d.x0, d.y0, d.x1, d.y1);
    const isClick = r.width < 4 && r.height < 4;
    const ur = userRect(r);
    const [ux, uy] = coords.pointToUser(d.x0, d.y0);

    if (tool === 'select' || tool === 'editText' || tool === 'editImage') {
      if (isClick) return;
      const ids = objects.filter((o) => o.rect.x >= r.x && o.rect.y >= r.y && o.rect.x + o.rect.width <= r.x + r.width && o.rect.y + o.rect.height <= r.y + r.height).map((o) => o.id);
      select({ pageUid: uid, ids });
      return;
    }
    if (tool === 'addText') {
      const width = isClick ? 0 : ur.width;
      set({ editing: { pageUid: uid, blockId: null, rect: { x: isClick ? ux : ur.x, y: isClick ? uy : ur.y + ur.height, width, height: 0 }, text: '' } });
      return;
    }
    if (tool === 'redact') {
      if (isClick) return;
      set({ redactions: [...useEditor.getState().redactions, { pageUid: uid, rect: ur }] });
      return;
    }
    if (tool === 'shapes') {
      const pts: number[] = [];
      if (shapeTool === 'freehand') {
        for (let i = 0; i + 1 < d.pts.length; i += 2) pts.push(...coords.pointToUser(d.pts[i], d.pts[i + 1]));
        if (pts.length < 4) return;
      } else {
        if (isClick) return;
        const a = coords.pointToUser(d.x0, d.y0);
        const b = coords.pointToUser(d.x1, d.y1);
        pts.push(a[0], a[1], b[0], b[1]);
      }
      await act('Draw shape', (e) => e.addShape(uid, { kind: shapeTool, points: pts, stroke: shapeDefaults.stroke, fill: shapeDefaults.fill, lineWidth: shapeDefaults.lineWidth }));
      return;
    }
    if (tool === 'annotate') {
      if (annotTool === 'Ink') {
        const pts: number[] = [];
        for (let i = 0; i + 1 < d.pts.length; i += 2) pts.push(...coords.pointToUser(d.pts[i], d.pts[i + 1]));
        if (pts.length >= 4) await act('Ink', (e) => e.addAnnotation(uid, { type: 'Ink', rects: [ur], ink: [pts], color: annotColor.r === 1 && annotColor.g > 0.9 ? { r: 0.1, g: 0.2, b: 0.9 } : annotColor }));
        return;
      }
      if (annotTool === 'Highlight' || annotTool === 'Underline' || annotTool === 'StrikeOut') {
        const rects = textRectsUnder(r);
        if (!rects.length) {
          toast('info', 'Drag across text to mark it up.');
          return;
        }
        await act('Markup', (e) => e.addAnnotation(uid, { type: annotTool, rects, color: annotTool === 'Highlight' ? annotColor : { r: 0.9, g: 0.1, b: 0.1 } }));
        return;
      }
      if (isClick) return;
      if (annotTool === 'Link') openDialog('link', { pageUid: uid, rect: ur });
      else if (annotTool === 'FreeText') openDialog('annotText', { pageUid: uid, rect: ur, type: 'FreeText' });
      return;
    }
    if (tool === 'forms' && fieldTool !== 'fill' && !isClick) {
      openDialog('newField', { pageUid: uid, rect: ur, type: fieldTool });
    }
  };

  const onStageClick = async () => {
    const p = pointer();
    const [ux, uy] = coords.pointToUser(p.x, p.y);
    if (tool === 'annotate' && annotTool === 'Text') {
      openDialog('annotText', { pageUid: uid, rect: { x: ux, y: uy - 20, width: 20, height: 20 }, type: 'Text' });
      return;
    }
    if ((tool === 'sign' || pendingImage) && pendingImage) {
      const maxW = pendingImage.purpose === 'signature' ? 160 : 240;
      const w = Math.min(maxW, pendingImage.width * 0.75);
      const h = (w * pendingImage.height) / pendingImage.width;
      const img = pendingImage;
      set({ pendingImage: null });
      await act(img.purpose === 'signature' ? 'Sign' : 'Insert image', (e) => e.insertImage(uid, { bytes: img.bytes, mime: img.mime }, { x: ux, y: uy - h, width: w, height: h }));
      return;
    }
    if (tool === 'sign' && !pendingImage) openDialog('signature');
  };

  const onObjectDown = (o: Obj, e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (!(tool === 'select' || tool === 'editText' || tool === 'editImage' || (tool === 'annotate' && o.kind === 'annotation'))) return;
    e.cancelBubble = true;
    const shift = (e.evt as MouseEvent).shiftKey || (e.evt as MouseEvent).metaKey || (e.evt as MouseEvent).ctrlKey;
    if (shift && selection?.pageUid === uid) {
      const ids = selectedIds.includes(o.id) ? selectedIds.filter((i) => i !== o.id) : [...selectedIds, o.id];
      select({ pageUid: uid, ids });
    } else if (!selectedIds.includes(o.id)) select({ pageUid: uid, ids: [o.id] });
    if (!o.editable && o.reason) toast('info', o.reason);
  };

  const startEditing = (o: Obj) => {
    if (o.kind !== 'text') return;
    if (!o.editable) {
      toast('warning', o.reason ?? 'This text cannot be edited');
      return;
    }
    const b = model.blocks.find((x) => x.id === o.id)!;
    set({ editing: { pageUid: uid, blockId: b.id, rect: b.bbox, text: b.text } });
  };

  const freehandDraft = draft && ((tool === 'shapes' && shapeTool === 'freehand') || (tool === 'annotate' && annotTool === 'Ink'));
  const draftRect = draft ? normRect(draft.x0, draft.y0, draft.x1, draft.y1) : null;
  const cursor = tool === 'select' ? 'default' : tool === 'editText' ? 'text' : tool === 'addText' ? 'text' : tool === 'editImage' ? 'default' : 'crosshair';
  const pageHits = searchHits.map((h, i) => ({ h, i })).filter(({ h }) => h.pageUid === uid);
  const hasAnnotSelected = selectedIds.some((id) => id.startsWith('a'));

  return (
    <Stage
      ref={stageRef}
      width={coords.width}
      height={coords.height}
      style={{ position: 'absolute', inset: 0, cursor }}
      onMouseDown={onStageDown}
      onTouchStart={onStageDown}
      onMouseMove={onStageMove}
      onTouchMove={onStageMove}
      onMouseUp={onStageUp}
      onTouchEnd={onStageUp}
      onClick={(e) => {
        if (e.target === e.target.getStage() || e.target.name() === 'bg') onStageClick();
      }}
    >
      <Layer>
        <KRect name="bg" x={0} y={0} width={coords.width} height={coords.height} fill="rgba(0,0,0,0)" />
        {pageHits.map(({ h, i }) => {
          const r = coords.rectToView(h.bbox);
          return <KRect key={`hit${i}`} x={r.x} y={r.y} width={r.width} height={r.height} fill={i === activeHit ? 'rgba(255,140,0,0.45)' : 'rgba(255,230,0,0.35)'} listening={false} />;
        })}
        {redactions.filter((x) => x.pageUid === uid).map((x, i) => {
          const r = coords.rectToView(x.rect);
          return <KRect key={`red${i}`} x={r.x} y={r.y} width={r.width} height={r.height} stroke="#dc2626" strokeWidth={2} dash={[6, 3]} fill="rgba(220,38,38,0.15)" listening={false} />;
        })}
        {objects.map((o) => {
          const sel = selectedIds.includes(o.id);
          const w = Math.max(o.rect.width, MIN_HIT);
          const h = Math.max(o.rect.height, MIN_HIT);
          const x = o.rect.x - (w - o.rect.width) / 2;
          const y = o.rect.y - (h - o.rect.height) / 2;
          const isEditingThis = editing?.blockId === o.id && editing.pageUid === uid;
          if (isEditingThis) return null;
          return (
            <KRect
              key={`${o.id}@${model.version}`}
              id={o.id}
              ref={(n) => {
                if (n) nodes.current.set(o.id, n);
                else nodes.current.delete(o.id);
              }}
              x={x}
              y={y}
              width={w}
              height={h}
              fill="rgba(59,110,245,0.001)"
              stroke={sel ? (o.editable ? '#3b6ef5' : '#f59e0b') : 'transparent'}
              strokeWidth={1}
              dash={o.editable ? undefined : [4, 3]}
              draggable={sel && o.editable && (tool === 'select' || tool === 'editImage' || tool === 'annotate')}
              onMouseEnter={(e) => {
                if (!sel) (e.target as Konva.Rect).stroke(o.editable ? 'rgba(59,110,245,0.6)' : 'rgba(245,158,11,0.7)');
                e.target.getLayer()?.batchDraw();
              }}
              onMouseLeave={(e) => {
                if (!sel) (e.target as Konva.Rect).stroke('transparent');
                e.target.getLayer()?.batchDraw();
              }}
              onMouseDown={(e) => onObjectDown(o, e)}
              onTouchStart={(e) => onObjectDown(o, e)}
              onClick={() => {
                if (tool === 'editText') startEditing(o);
              }}
              onDblClick={() => startEditing(o)}
              onDblTap={() => startEditing(o)}
              onDragStart={(e) => {
                const others = new Map<string, { x: number; y: number }>();
                for (const id of selectedIds) if (id !== o.id) {
                  const n = nodes.current.get(id);
                  if (n) others.set(id, n.position());
                }
                dragStart.current = { id: o.id, x: e.target.x(), y: e.target.y(), others };
              }}
              onDragMove={onDragMove}
              onDragEnd={async (e) => {
                setGuides({ v: [], h: [] });
                dragStart.current = null;
                await commitTransform(e.target, selectedIds.length ? selectedIds : [o.id]);
              }}
              onTransformEnd={async (e) => {
                await commitTransform(e.target, selectedIds.length ? selectedIds : [o.id]);
              }}
            />
          );
        })}
        <Transformer
          ref={trRef}
          rotateEnabled={!hasAnnotSelected}
          keepRatio={false}
          flipEnabled
          ignoreStroke
          boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4 ? oldBox : newBox)}
          anchorSize={8}
          borderStroke="#3b6ef5"
          anchorStroke="#3b6ef5"
        />
        {guides.v.map((x, i) => <Line key={`gv${i}`} points={[x, 0, x, coords.height]} stroke="#ec4899" strokeWidth={1} dash={[4, 4]} listening={false} />)}
        {guides.h.map((y, i) => <Line key={`gh${i}`} points={[0, y, coords.width, y]} stroke="#ec4899" strokeWidth={1} dash={[4, 4]} listening={false} />)}
        {draftRect && !freehandDraft && tool !== 'shapes' && (
          <KRect x={draftRect.x} y={draftRect.y} width={draftRect.width} height={draftRect.height} stroke={tool === 'redact' ? '#dc2626' : '#3b6ef5'} dash={[5, 3]} strokeWidth={1} fill={tool === 'redact' ? 'rgba(220,38,38,0.15)' : 'rgba(59,110,245,0.08)'} listening={false} />
        )}
        {draft && tool === 'shapes' && !freehandDraft && (
          shapeTool === 'line' || shapeTool === 'arrow' ? (
            <Line points={[draft.x0, draft.y0, draft.x1, draft.y1]} stroke={shapeDefaults.stroke ? rgbCss(shapeDefaults.stroke) : '#000'} strokeWidth={shapeDefaults.lineWidth * coords.zoom} listening={false} />
          ) : shapeTool === 'ellipse' && draftRect ? (
            <Path data={ellipsePath(draftRect)} stroke={shapeDefaults.stroke ? rgbCss(shapeDefaults.stroke) : undefined} fill={shapeDefaults.fill ? rgbCss(shapeDefaults.fill) : undefined} strokeWidth={shapeDefaults.lineWidth * coords.zoom} listening={false} />
          ) : draftRect ? (
            <KRect x={draftRect.x} y={draftRect.y} width={draftRect.width} height={draftRect.height} stroke={shapeDefaults.stroke ? rgbCss(shapeDefaults.stroke) : undefined} fill={shapeDefaults.fill ? rgbCss(shapeDefaults.fill) : undefined} strokeWidth={shapeDefaults.lineWidth * coords.zoom} listening={false} />
          ) : null
        )}
        {freehandDraft && draft && <Line points={draft.pts} stroke={tool === 'annotate' ? '#2246ab' : shapeDefaults.stroke ? rgbCss(shapeDefaults.stroke) : '#000'} strokeWidth={Math.max(1, shapeDefaults.lineWidth * coords.zoom)} lineCap="round" lineJoin="round" listening={false} />}
      </Layer>
    </Stage>
  );
}

function ellipsePath(r: Rect): string {
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2, rx = r.width / 2, ry = r.height / 2;
  return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
}
