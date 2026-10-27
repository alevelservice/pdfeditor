'use client';
import { useState } from 'react';
import { useEditor } from '@/store/editorStore';
import { downloadBytes, fileToPdfImage, pickFile } from '@/lib/client/imageUtils';
import type { FitMode, ImageObject, Matrix } from '@/lib/pdf/types';

/** Replace / transform / crop / extract an embedded image. */
export default function ImageReplacer({ uid, image }: { uid: string; image: ImageObject }) {
  const act = useEditor((s) => s.act);
  const toast = useEditor((s) => s.toast);
  const [fit, setFit] = useState<FitMode>('contain');
  const [opacity, setOpacity] = useState(1);
  const [crop, setCrop] = useState({ l: 0, r: 0, t: 0, b: 0 });
  const b = image.bbox;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const about = (m: Matrix): Matrix => {
    // Transform about the image centre: T(-c) × m × T(c)
    return [m[0], m[1], m[2], m[3], cx - m[0] * cx - m[2] * cy, cy - m[1] * cx - m[3] * cy];
  };
  const transform = (m: Matrix, label: string) => act(label, (e) => e.transformObjects(uid, [image.id], about(m)));

  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-500">
        {image.width}×{image.height}px · {image.colorSpace} · {image.filter || 'raw'} {image.inline ? '· inline' : ''} {image.hasAlpha ? '· alpha' : ''}
      </div>
      {!image.editable && <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">{image.readOnlyReason}</p>}
      <div>
        <label className="label">Replace</label>
        <div className="flex gap-1">
          <select className="input" value={fit} onChange={(e) => setFit(e.target.value as FitMode)}>
            <option value="keep">Keep box (stretch)</option>
            <option value="contain">Fit inside (contain)</option>
            <option value="cover">Fill box (cover, cropped)</option>
          </select>
          <button
            className="btn btn-primary"
            disabled={!image.editable}
            data-testid="replace-image"
            onClick={async () => {
              const [f] = await pickFile('image/png,image/jpeg,image/webp,image/svg+xml,image/gif,image/bmp');
              if (!f) return;
              try {
                const img = await fileToPdfImage(f);
                await act('Replace image', (e) => e.replaceImage(uid, image.id, { bytes: img.bytes, mime: img.mime }, fit));
              } catch (err) {
                toast('error', (err as Error).message);
              }
            }}
          >
            Upload…
          </button>
        </div>
      </div>
      <div>
        <label className="label">Transform</label>
        <div className="grid grid-cols-4 gap-1">
          <button className="btn" title="Rotate left" onClick={() => transform([0, 1, -1, 0, 0, 0], 'Rotate image')}>⟲</button>
          <button className="btn" title="Rotate right" onClick={() => transform([0, -1, 1, 0, 0, 0], 'Rotate image')}>⟳</button>
          <button className="btn" title="Flip horizontal" onClick={() => transform([-1, 0, 0, 1, 0, 0], 'Flip image')}>⇋</button>
          <button className="btn" title="Flip vertical" onClick={() => transform([1, 0, 0, -1, 0, 0], 'Flip image')}>⇵</button>
        </div>
      </div>
      <div>
        <label className="label">Opacity {Math.round(opacity * 100)}%</label>
        <input type="range" min={0.05} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} onMouseUp={() => act('Image opacity', (e) => e.setImageOpacity(uid, image.id, opacity))} className="w-full" />
      </div>
      <div>
        <label className="label">Crop (% from each edge)</label>
        <div className="grid grid-cols-4 gap-1 text-xs">
          {(['l', 'r', 't', 'b'] as const).map((k) => (
            <label key={k} className="flex flex-col">
              {{ l: 'Left', r: 'Right', t: 'Top', b: 'Bottom' }[k]}
              <input className="input" type="number" min={0} max={90} value={crop[k]} onChange={(e) => setCrop({ ...crop, [k]: Number(e.target.value) })} />
            </label>
          ))}
        </div>
        <button
          className="btn mt-1 w-full"
          onClick={() =>
            act('Crop image', (e) =>
              e.cropImage(uid, image.id, {
                x: b.x + (b.width * crop.l) / 100,
                y: b.y + (b.height * crop.b) / 100,
                width: b.width * (1 - (crop.l + crop.r) / 100),
                height: b.height * (1 - (crop.t + crop.b) / 100),
              }),
            )
          }
        >
          Apply crop
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1">
        <button
          className="btn"
          onClick={async () => {
            try {
              const x = await useEditor.getState().engine().extractImage(uid, image.id);
              downloadBytes(x.bytes, `image-${image.name ?? 'inline'}.${x.ext}`, x.mime);
            } catch (err) {
              toast('error', (err as Error).message);
            }
          }}
        >
          Download
        </button>
        <button className="btn" onClick={() => act('Delete image', (e) => e.deleteObjects(uid, [image.id]))}>Delete</button>
      </div>
    </div>
  );
}
