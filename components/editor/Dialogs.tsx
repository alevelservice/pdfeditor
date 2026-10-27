'use client';
import { useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';
import { useEditor } from '@/store/editorStore';
import { FAMILY_LABELS } from '@/lib/pdf/fontList';
import { downloadBytes, fileToPdfImage, hexToRgb, pickFile, rgbToHex, typedSignaturePng } from '@/lib/client/imageUtils';
import { getPdfPage, openTemporary, renderForOcr, renderToBlob } from '@/lib/client/pdfjs';
import type { Rect, StampOptions } from '@/lib/pdf/types';

export function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`max-h-[90vh] w-full ${wide ? 'max-w-2xl' : 'max-w-md'} overflow-y-auto rounded-lg bg-white p-4 shadow-2xl dark:bg-slate-900`} role="dialog" aria-label={title}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button className="tool" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------

function LinkDialog({ args, close }: { args: { pageUid: string; rect: Rect }; close: () => void }) {
  const { act, info } = useEditor.getState();
  const [mode, setMode] = useState<'uri' | 'page'>('uri');
  const [uri, setUri] = useState('https://');
  const [page, setPage] = useState(1);
  return (
    <Modal title="Add link" onClose={close}>
      <div className="space-y-3">
        <div className="flex gap-3 text-sm">
          <label><input type="radio" checked={mode === 'uri'} onChange={() => setMode('uri')} /> Web address</label>
          <label><input type="radio" checked={mode === 'page'} onChange={() => setMode('page')} /> Page in this document</label>
        </div>
        {mode === 'uri' ? <input className="input" value={uri} onChange={(e) => setUri(e.target.value)} autoFocus /> : <input className="input" type="number" min={1} max={info?.pageCount} value={page} onChange={(e) => setPage(Number(e.target.value))} />}
        <button
          className="btn btn-primary w-full"
          onClick={async () => {
            close();
            await act('Add link', (e) => e.addAnnotation(args.pageUid, { type: 'Link', rects: [args.rect], ...(mode === 'uri' ? { uri } : { destPage: page - 1 }) }));
          }}
        >
          Add link
        </button>
      </div>
    </Modal>
  );
}

function AnnotTextDialog({ args, close }: { args: { pageUid: string; rect: Rect; type: 'Text' | 'FreeText' }; close: () => void }) {
  const { act } = useEditor.getState();
  const [text, setText] = useState('');
  const [color, setColor] = useState(args.type === 'Text' ? '#ffd833' : '#d81b1b');
  return (
    <Modal title={args.type === 'Text' ? 'Sticky note' : 'Comment box'} onClose={close}>
      <div className="space-y-3">
        <textarea className="input h-28" autoFocus value={text} onChange={(e) => setText(e.target.value)} data-testid="annot-text" />
        <Field label="Color"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></Field>
        <button
          className="btn btn-primary w-full"
          onClick={async () => {
            close();
            await act('Add comment', (e) => e.addAnnotation(args.pageUid, { type: args.type, rects: [args.rect], contents: text, color: hexToRgb(color) }));
          }}
        >
          Add
        </button>
      </div>
    </Modal>
  );
}

function NewFieldDialog({ args, close }: { args: { pageUid: string; rect: Rect; type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'signature' }; close: () => void }) {
  const { act } = useEditor.getState();
  const [name, setName] = useState(`${args.type}_${Math.random().toString(36).slice(2, 6)}`);
  const [options, setOptions] = useState('Option 1, Option 2');
  const [value, setValue] = useState('');
  const [multiline, setMultiline] = useState(false);
  return (
    <Modal title={`New ${args.type} field`} onClose={close}>
      <div className="space-y-3">
        <Field label="Field name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        {args.type === 'dropdown' && <Field label="Options (comma separated)"><input className="input" value={options} onChange={(e) => setOptions(e.target.value)} /></Field>}
        {args.type === 'radio' && <Field label="Option value (reuse the name to add buttons to a group)"><input className="input" value={value} onChange={(e) => setValue(e.target.value)} /></Field>}
        {args.type === 'text' && (
          <>
            <Field label="Default value"><input className="input" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
            <label className="text-sm"><input type="checkbox" checked={multiline} onChange={(e) => setMultiline(e.target.checked)} /> Multi-line</label>
          </>
        )}
        <button
          className="btn btn-primary w-full"
          onClick={async () => {
            close();
            await act('Add field', (e) => e.createField(args.pageUid, { type: args.type, name, rect: args.rect, options: options.split(',').map((o) => o.trim()).filter(Boolean), value: value || undefined, multiline }));
            window.dispatchEvent(new CustomEvent('fields-changed'));
          }}
        >
          Create field
        </button>
      </div>
    </Modal>
  );
}

function SignatureDialog({ args, close }: { args: { pageUid?: string; rect?: Rect }; close: () => void }) {
  const { set, act, toast } = useEditor.getState();
  const [tab, setTab] = useState<'draw' | 'type' | 'upload'>('draw');
  const [text, setText] = useState('');
  const [font, setFont] = useState('"Brush Script MT", "Segoe Script", "Lucida Handwriting", cursive');
  const [color, setColor] = useState('#1a2b8c');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, [tab]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) * e.currentTarget.width) / r.width, ((e.clientY - r.top) * e.currentTarget.height) / r.height];
  };

  const finish = async (img: { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg'; width: number; height: number }) => {
    close();
    if (args.rect && args.pageUid) {
      const r = args.rect;
      const scaleF = Math.min(r.width / img.width, r.height / img.height);
      const w = img.width * scaleF, h = img.height * scaleF;
      await act('Sign', (e) => e.insertImage(args.pageUid!, { bytes: img.bytes, mime: img.mime }, { x: r.x + (r.width - w) / 2, y: r.y + (r.height - h) / 2, width: w, height: h }));
    } else {
      set({ pendingImage: { ...img, purpose: 'signature' }, tool: 'sign' });
      toast('info', 'Click on the page where the signature should go.');
    }
  };

  const fromCanvas = async () => {
    const c = canvasRef.current!;
    // Trim transparent margins.
    const ctx = c.getContext('2d')!;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 0) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    if (x1 <= x0) return;
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 8;
    out.height = y1 - y0 + 8;
    out.getContext('2d')!.drawImage(c, x0 - 4, y0 - 4, out.width, out.height, 0, 0, out.width, out.height);
    const blob = await new Promise<Blob>((r) => out.toBlob((b) => r(b!), 'image/png'));
    await finish({ bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', width: out.width, height: out.height });
  };

  return (
    <Modal title="Signature" onClose={close} wide>
      <div className="mb-3 flex gap-1">
        {(['draw', 'type', 'upload'] as const).map((t) => (
          <button key={t} className={`tool ${tab === t ? 'tool-active' : ''}`} onClick={() => setTab(t)}>{{ draw: 'Draw', type: 'Type', upload: 'Upload' }[t]}</button>
        ))}
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="ml-auto" />
      </div>
      {tab === 'draw' && (
        <div className="space-y-2">
          <canvas
            ref={canvasRef}
            width={900}
            height={260}
            className="w-full touch-none rounded border border-dashed border-slate-400 bg-white"
            onPointerDown={(e) => {
              drawing.current = true;
              const ctx = e.currentTarget.getContext('2d')!;
              ctx.strokeStyle = color;
              const [x, y] = pos(e);
              ctx.beginPath();
              ctx.moveTo(x, y);
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drawing.current) return;
              const ctx = e.currentTarget.getContext('2d')!;
              const [x, y] = pos(e);
              ctx.lineTo(x, y);
              ctx.stroke();
              setHasInk(true);
            }}
            onPointerUp={() => (drawing.current = false)}
          />
          <div className="flex gap-2">
            <button className="btn" onClick={() => { const c = canvasRef.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); setHasInk(false); }}>Clear</button>
            <button className="btn btn-primary ml-auto" disabled={!hasInk} onClick={fromCanvas}>Use signature</button>
          </div>
        </div>
      )}
      {tab === 'type' && (
        <div className="space-y-2">
          <input className="input text-lg" placeholder="Your name" value={text} onChange={(e) => setText(e.target.value)} />
          <select className="input" value={font} onChange={(e) => setFont(e.target.value)}>
            <option value={'"Brush Script MT", "Segoe Script", "Lucida Handwriting", cursive'}>Script</option>
            <option value={'"Snell Roundhand", "Apple Chancery", cursive'}>Calligraphy</option>
            <option value={'Georgia, serif'}>Serif</option>
          </select>
          <div className="rounded border bg-white p-4 text-4xl text-slate-900" style={{ fontFamily: font, color }}>{text || 'Preview'}</div>
          <button className="btn btn-primary w-full" disabled={!text} onClick={async () => finish(await typedSignaturePng(text, color, font))}>Use signature</button>
        </div>
      )}
      {tab === 'upload' && (
        <button
          className="btn btn-primary w-full"
          onClick={async () => {
            const [f] = await pickFile('image/png,image/jpeg,image/webp,image/svg+xml');
            if (f) await finish(await fileToPdfImage(f));
          }}
        >
          Choose image…
        </button>
      )}
    </Modal>
  );
}

function StampDialog({ args, close }: { args: { kind: StampOptions['kind'] }; close: () => void }) {
  const { act } = useEditor.getState();
  const [o, setO] = useState<StampOptions>(() => ({
    kind: args.kind,
    text: args.kind === 'watermark' ? 'CONFIDENTIAL' : args.kind === 'header' || args.kind === 'footer' ? 'Page {page} of {total}' : '',
    format: 'Page {page} of {total}',
    fontSize: args.kind === 'watermark' ? 60 : 10,
    opacity: args.kind === 'watermark' ? 0.3 : 1,
    rotation: args.kind === 'watermark' ? 45 : 0,
    position: args.kind === 'bates' ? 'right' : 'center',
    prefix: 'DOC',
    digits: 6,
    start: 1,
    pageRange: 'all',
    behind: false,
    margin: 36,
    color: args.kind === 'watermark' ? { r: 0.6, g: 0.6, b: 0.6 } : { r: 0, g: 0, b: 0 },
    fontFamily: 'Arimo',
  }));
  const [where, setWhere] = useState<'header' | 'footer'>(args.kind === 'footer' ? 'footer' : 'header');
  const title = { watermark: 'Watermark', header: 'Header / footer', footer: 'Header / footer', pageNumbers: 'Page numbers', bates: 'Bates numbering' }[args.kind];
  const up = (p: Partial<StampOptions>) => setO({ ...o, ...p });
  return (
    <Modal title={title} onClose={close} wide>
      <div className="grid grid-cols-2 gap-3">
        {(args.kind === 'watermark' || args.kind === 'header' || args.kind === 'footer') && (
          <div className="col-span-2">
            <Field label="Text (tokens: {page} {total} {date})"><input className="input" value={o.text} onChange={(e) => up({ text: e.target.value })} /></Field>
          </div>
        )}
        {(args.kind === 'header' || args.kind === 'footer') && (
          <Field label="Placement">
            <select className="input" value={where} onChange={(e) => setWhere(e.target.value as 'header' | 'footer')}>
              <option value="header">Header (top)</option>
              <option value="footer">Footer (bottom)</option>
            </select>
          </Field>
        )}
        {args.kind === 'pageNumbers' && <div className="col-span-2"><Field label="Format"><input className="input" value={o.format} onChange={(e) => up({ format: e.target.value })} /></Field></div>}
        {args.kind === 'bates' && (
          <>
            <Field label="Prefix"><input className="input" value={o.prefix} onChange={(e) => up({ prefix: e.target.value })} /></Field>
            <Field label="Suffix"><input className="input" value={o.suffix ?? ''} onChange={(e) => up({ suffix: e.target.value })} /></Field>
            <Field label="Start number"><input className="input" type="number" value={o.start} onChange={(e) => up({ start: Number(e.target.value) })} /></Field>
            <Field label="Digits"><input className="input" type="number" min={1} max={12} value={o.digits} onChange={(e) => up({ digits: Number(e.target.value) })} /></Field>
          </>
        )}
        <Field label="Font">
          <select className="input" value={o.fontFamily} onChange={(e) => up({ fontFamily: e.target.value })}>
            {Object.entries(FAMILY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Size"><input className="input" type="number" min={4} value={o.fontSize} onChange={(e) => up({ fontSize: Number(e.target.value) })} /></Field>
        <Field label="Color"><input type="color" value={rgbToHex(o.color)} onChange={(e) => up({ color: hexToRgb(e.target.value) })} /></Field>
        <Field label={`Opacity ${Math.round((o.opacity ?? 1) * 100)}%`}><input type="range" min={0.05} max={1} step={0.05} value={o.opacity} onChange={(e) => up({ opacity: Number(e.target.value) })} className="w-full" /></Field>
        {args.kind === 'watermark' ? (
          <>
            <Field label="Rotation (°)"><input className="input" type="number" value={o.rotation} onChange={(e) => up({ rotation: Number(e.target.value) })} /></Field>
            <label className="flex items-end gap-2 text-sm"><input type="checkbox" checked={o.behind} onChange={(e) => up({ behind: e.target.checked })} /> Behind page content</label>
            <div className="col-span-2">
              <button
                className="btn w-full"
                onClick={async () => {
                  const [f] = await pickFile('image/png,image/jpeg,image/webp,image/svg+xml');
                  if (f) {
                    const img = await fileToPdfImage(f);
                    up({ image: { bytes: img.bytes, mime: img.mime } });
                  }
                }}
              >
                {o.image ? 'Image selected ✓ (replaces text)' : 'Use an image instead…'}
              </button>
            </div>
          </>
        ) : (
          <>
            <Field label="Alignment">
              <select className="input" value={o.position} onChange={(e) => up({ position: e.target.value as StampOptions['position'] })}>
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </Field>
            <Field label="Margin (pt)"><input className="input" type="number" value={o.margin} onChange={(e) => up({ margin: Number(e.target.value) })} /></Field>
          </>
        )}
        <div className="col-span-2"><Field label="Pages (e.g. all, 1-3,5)"><input className="input" value={o.pageRange} onChange={(e) => up({ pageRange: e.target.value })} /></Field></div>
      </div>
      <button
        className="btn btn-primary mt-4 w-full"
        data-testid="apply-stamp"
        onClick={async () => {
          close();
          const kind = args.kind === 'header' || args.kind === 'footer' ? where : args.kind;
          await act(title, (e) => e.applyStamps({ ...o, kind }));
        }}
      >
        Apply
      </button>
    </Modal>
  );
}

function OcrDialog({ close }: { close: () => void }) {
  const s = useEditor();
  const [range, setRange] = useState(String((s.currentPage ?? 0) + 1));
  const [lang, setLang] = useState('eng');
  const [mode, setMode] = useState<'searchable' | 'editable'>('searchable');
  const [progress, setProgress] = useState<string | null>(null);
  const run = async () => {
    const info = s.info!;
    const { parseRange: parseRangeClient } = await import('@/lib/pdf/ranges');
    const indices = parseRangeClient(range, info.pageCount);
    const { recognizePage } = await import('@/lib/pdf/ocr');
    try {
      for (let k = 0; k < indices.length; k++) {
        const p = info.pages[indices[k]];
        setProgress(`Recognizing page ${indices[k] + 1} (${k + 1}/${indices.length})…`);
        const page = await getPdfPage(await s.engine().getRenderSource(p.uid));
        const canvas = await renderForOcr(page, 200);
        const result = await recognizePage(canvas, canvas.width, canvas.height, lang);
        setProgress(`Writing text layer for page ${indices[k] + 1}…`);
        await s.act('OCR', (e) => e.applyOcr(p.uid, result, mode));
      }
      s.toast('success', `OCR finished for ${indices.length} page(s).`);
      close();
    } catch (e) {
      s.toast('error', `OCR failed: ${(e as Error).message}`);
      setProgress(null);
    }
  };
  return (
    <Modal title="OCR scanned pages" onClose={close}>
      <div className="space-y-3">
        <Field label="Pages"><input className="input" value={range} onChange={(e) => setRange(e.target.value)} /></Field>
        <Field label="Language">
          <select className="input" value={lang} onChange={(e) => setLang(e.target.value)}>
            {[['eng', 'English'], ['deu', 'German'], ['fra', 'French'], ['spa', 'Spanish'], ['ita', 'Italian'], ['por', 'Portuguese'], ['ben', 'Bengali'], ['hin', 'Hindi'], ['ara', 'Arabic'], ['heb', 'Hebrew'], ['chi_sim', 'Chinese (simplified)'], ['jpn', 'Japanese'], ['rus', 'Russian']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <div className="space-y-1 text-sm">
          <label className="block"><input type="radio" checked={mode === 'searchable'} onChange={() => setMode('searchable')} /> Searchable — invisible text over the scan</label>
          <label className="block"><input type="radio" checked={mode === 'editable'} onChange={() => setMode('editable')} /> Editable — real text; recognized words are erased from the scan image</label>
        </div>
        {progress && <p className="text-sm text-brand-600">{progress}</p>}
        <button className="btn btn-primary w-full" disabled={!!progress} onClick={run}>Run OCR</button>
        <p className="text-xs text-slate-500">Runs locally with tesseract.js. Language data is downloaded once per language.</p>
      </div>
    </Modal>
  );
}

function PagesDialog({ close }: { close: () => void }) {
  const s = useEditor();
  const [splitRanges, setSplitRanges] = useState('1-1, 2-');
  const [insertAt, setInsertAt] = useState((s.info?.pageCount ?? 0) + 1);
  const [insertRange, setInsertRange] = useState('');
  return (
    <Modal title="Merge, split & insert" onClose={close} wide>
      <div className="space-y-5">
        <section>
          <h4 className="mb-1 font-medium">Merge</h4>
          <button
            className="btn"
            onClick={async () => {
              const files = await pickFile('application/pdf', true);
              if (!files.length) return;
              const data = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())));
              close();
              await s.act('Merge', (e) => e.mergePdfs(data));
            }}
          >
            Append PDF files…
          </button>
        </section>
        <section className="grid grid-cols-3 items-end gap-2">
          <Field label="Insert before page"><input className="input" type="number" min={1} value={insertAt} onChange={(e) => setInsertAt(Number(e.target.value))} /></Field>
          <Field label="Pages from other file (blank = all)"><input className="input" value={insertRange} onChange={(e) => setInsertRange(e.target.value)} /></Field>
          <button
            className="btn"
            onClick={async () => {
              const [f] = await pickFile('application/pdf');
              if (!f) return;
              const bytes = new Uint8Array(await f.arrayBuffer());
              close();
              await s.act('Insert pages', (e) => e.insertPdf(Math.max(0, insertAt - 1), bytes, insertRange || undefined));
            }}
          >
            Insert from PDF…
          </button>
        </section>
        <section className="grid grid-cols-3 items-end gap-2">
          <div className="col-span-2"><Field label="Split into ranges (comma separated: 1-3, 4-6, 7-)"><input className="input" value={splitRanges} onChange={(e) => setSplitRanges(e.target.value)} /></Field></div>
          <button
            className="btn"
            onClick={async () => {
              const ranges = splitRanges.split(',').map((r) => r.trim()).filter(Boolean);
              const parts = await s.engine().splitDocument(ranges);
              const zip = new JSZip();
              parts.forEach((p, i) => zip.file(`${s.fileName.replace(/\.pdf$/i, '')}-part${i + 1}.pdf`, p));
              downloadBytes(await zip.generateAsync({ type: 'blob' }), 'split.zip', 'application/zip');
            }}
          >
            Split & download
          </button>
        </section>
      </div>
    </Modal>
  );
}

function PageBoxDialog({ close }: { close: () => void }) {
  const s = useEditor();
  const page = s.info!.pages[s.currentPage];
  const [box, setBox] = useState<'CropBox' | 'MediaBox'>('CropBox');
  const src = box === 'CropBox' ? page.cropBox : page.mediaBox;
  const [vals, setVals] = useState(src.map((v) => +v.toFixed(2)) as [number, number, number, number]);
  useEffect(() => setVals((box === 'CropBox' ? page.cropBox : page.mediaBox).map((v) => +v.toFixed(2)) as [number, number, number, number]), [box, page]);
  return (
    <Modal title={`Crop / resize page ${page.index + 1}`} onClose={close}>
      <div className="space-y-3">
        <select className="input" value={box} onChange={(e) => setBox(e.target.value as 'CropBox' | 'MediaBox')}>
          <option value="CropBox">CropBox (visible area)</option>
          <option value="MediaBox">MediaBox (page size)</option>
        </select>
        <div className="grid grid-cols-4 gap-2">
          {['Left', 'Bottom', 'Right', 'Top'].map((l, i) => (
            <Field key={l} label={l}><input className="input" type="number" value={vals[i]} onChange={(e) => { const v = [...vals] as [number, number, number, number]; v[i] = Number(e.target.value); setVals(v); }} /></Field>
          ))}
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={() => setVals([page.mediaBox[0] + 36, page.mediaBox[1] + 36, page.mediaBox[2] - 36, page.mediaBox[3] - 36])}>Inset ½ inch</button>
          <button className="btn" onClick={() => setVals([0, 0, 595.28, 841.89])}>A4</button>
          <button className="btn" onClick={() => setVals([0, 0, 612, 792])}>Letter</button>
        </div>
        <button className="btn btn-primary w-full" onClick={async () => { close(); await s.act('Page box', (e) => e.setPageBox(page.uid, box, vals)); }}>Apply</button>
      </div>
    </Modal>
  );
}

function MetadataDialog({ close }: { close: () => void }) {
  const s = useEditor();
  const [m, setM] = useState(s.info!.metadata);
  return (
    <Modal title="Document properties" onClose={close}>
      <div className="space-y-2">
        {(['title', 'author', 'subject', 'keywords', 'creator', 'producer'] as const).map((k) => (
          <Field key={k} label={k}><input className="input" value={m[k]} onChange={(e) => setM({ ...m, [k]: e.target.value })} /></Field>
        ))}
        <p className="text-xs text-slate-500">Created {m.creationDate ? new Date(m.creationDate).toLocaleString() : '—'} · Modified {m.modificationDate ? new Date(m.modificationDate).toLocaleString() : '—'}</p>
        <button className="btn btn-primary w-full" onClick={async () => { close(); await s.act('Metadata', (e) => e.setMetadata(m)); }}>Save</button>
      </div>
    </Modal>
  );
}

function ExportDialog({ args, close }: { args: { mode: 'compress' | 'protect' | 'images' }; close: () => void }) {
  const s = useEditor();
  const [maxDim, setMaxDim] = useState(1600);
  const [quality, setQuality] = useState(0.75);
  const [userPw, setUserPw] = useState('');
  const [ownerPw, setOwnerPw] = useState('');
  const [perm, setPerm] = useState({ allowPrint: true, allowCopy: true, allowModify: false, allowAnnotate: true });
  const [fmt, setFmt] = useState<'image/png' | 'image/jpeg'>('image/png');
  const [dpi, setDpi] = useState(150);
  const [range, setRange] = useState('all');
  const [progress, setProgress] = useState<string | null>(null);
  const base = s.fileName.replace(/\.pdf$/i, '');

  if (args.mode === 'compress')
    return (
      <Modal title="Compress PDF" onClose={close}>
        <div className="space-y-3">
          <Field label="Downsample images larger than (px)"><input className="input" type="number" value={maxDim} onChange={(e) => setMaxDim(Number(e.target.value))} /></Field>
          <Field label={`JPEG quality ${Math.round(quality * 100)}%`}><input type="range" min={0.3} max={0.95} step={0.05} value={quality} onChange={(e) => setQuality(Number(e.target.value))} className="w-full" /></Field>
          {progress && <p className="text-sm text-brand-600">{progress}</p>}
          <button
            className="btn btn-primary w-full"
            onClick={async () => {
              setProgress('Compressing…');
              const before = (await s.engine().save({})).length;
              const bytes = await s.act('Compress', (e) => e.save({ compress: true, maxImageDimension: maxDim, jpegQuality: quality }));
              setProgress(null);
              if (bytes) {
                s.toast('success', `Compressed ${(before / 1024).toFixed(0)} KB → ${(bytes.length / 1024).toFixed(0)} KB`);
                downloadBytes(bytes, `${base}-compressed.pdf`);
                close();
              }
            }}
          >
            Compress & download
          </button>
        </div>
      </Modal>
    );
  if (args.mode === 'protect')
    return (
      <Modal title="Password protect (AES-256)" onClose={close}>
        <div className="space-y-3">
          <Field label="Password to open"><input className="input" type="password" value={userPw} onChange={(e) => setUserPw(e.target.value)} /></Field>
          <Field label="Owner password (permissions)"><input className="input" type="password" value={ownerPw} onChange={(e) => setOwnerPw(e.target.value)} placeholder="defaults to the open password" /></Field>
          <div className="grid grid-cols-2 gap-1 text-sm">
            {(Object.keys(perm) as (keyof typeof perm)[]).map((k) => (
              <label key={k}><input type="checkbox" checked={perm[k]} onChange={(e) => setPerm({ ...perm, [k]: e.target.checked })} /> {k.replace('allow', 'Allow ')}</label>
            ))}
          </div>
          <button
            className="btn btn-primary w-full"
            disabled={!userPw}
            onClick={async () => {
              const bytes = await s.act('Encrypting', (e) => e.save({ encrypt: { userPassword: userPw, ownerPassword: ownerPw || undefined, ...perm } }));
              if (bytes) {
                downloadBytes(bytes, `${base}-protected.pdf`);
                close();
              }
            }}
          >
            Encrypt & download
          </button>
          <p className="text-xs text-slate-500">To remove a password, open the protected file (you will be asked for it) and download it again.</p>
        </div>
      </Modal>
    );
  return (
    <Modal title="Export pages as images" onClose={close}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <Field label="Format">
            <select className="input" value={fmt} onChange={(e) => setFmt(e.target.value as 'image/png' | 'image/jpeg')}>
              <option value="image/png">PNG</option>
              <option value="image/jpeg">JPG</option>
            </select>
          </Field>
          <Field label="DPI"><input className="input" type="number" min={36} max={600} value={dpi} onChange={(e) => setDpi(Number(e.target.value))} /></Field>
          <Field label="Pages"><input className="input" value={range} onChange={(e) => setRange(e.target.value)} /></Field>
        </div>
        {progress && <p className="text-sm text-brand-600">{progress}</p>}
        <button
          className="btn btn-primary w-full"
          disabled={!!progress}
          onClick={async () => {
            const { parseRange: parseRangeClient } = await import('@/lib/pdf/ranges');
            const bytes = await s.engine().save({});
            const doc = await openTemporary(bytes);
            const idx = parseRangeClient(range, doc.numPages);
            const ext = fmt === 'image/png' ? 'png' : 'jpg';
            const zip = new JSZip();
            for (let k = 0; k < idx.length; k++) {
              setProgress(`Rendering page ${idx[k] + 1}…`);
              const blob = await renderToBlob(await doc.getPage(idx[k] + 1), dpi, fmt);
              if (idx.length === 1) {
                downloadBytes(blob, `${base}-p${idx[k] + 1}.${ext}`, fmt);
              } else zip.file(`${base}-p${String(idx[k] + 1).padStart(3, '0')}.${ext}`, blob);
            }
            if (idx.length > 1) downloadBytes(await zip.generateAsync({ type: 'blob' }), `${base}-${ext}.zip`, 'application/zip');
            await doc.destroy();
            setProgress(null);
            close();
          }}
        >
          Export
        </button>
      </div>
    </Modal>
  );
}

function FontsDialog({ close }: { close: () => void }) {
  const s = useEditor();
  const [name, setName] = useState('My Font');
  return (
    <Modal title="Upload a font (TTF / OTF)" onClose={close}>
      <div className="space-y-3">
        <Field label="Family name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <button
          className="btn btn-primary w-full"
          onClick={async () => {
            const [f] = await pickFile('.ttf,.otf,font/ttf,font/otf');
            if (!f) return;
            await s.engine().registerFont(name, new Uint8Array(await f.arrayBuffer()));
            FAMILY_LABELS[name] = `${name} (uploaded)`;
            s.toast('success', `Font "${name}" is available in the font lists.`);
            close();
          }}
        >
          Choose font file…
        </button>
      </div>
    </Modal>
  );
}

export function PasswordDialog({ onSubmit, error }: { onSubmit: (pw: string) => void; error?: string }) {
  const [pw, setPw] = useState('');
  return (
    <Modal title="Password required" onClose={() => history.back()}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSubmit(pw); }}>
        <p className="text-sm">This document is encrypted. Enter its password to edit it.</p>
        <input className="input" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn btn-primary w-full" type="submit">Open</button>
      </form>
    </Modal>
  );
}

export default function Dialogs() {
  const dialog = useEditor((s) => s.dialog);
  const args = useEditor((s) => s.dialogArgs);
  const close = useEditor((s) => s.closeDialog);
  switch (dialog) {
    case 'link': return <LinkDialog args={args as never} close={close} />;
    case 'annotText': return <AnnotTextDialog args={args as never} close={close} />;
    case 'newField': return <NewFieldDialog args={args as never} close={close} />;
    case 'signature': return <SignatureDialog args={args as never} close={close} />;
    case 'stamp': return <StampDialog args={args as never} close={close} />;
    case 'ocr': return <OcrDialog close={close} />;
    case 'pages': return <PagesDialog close={close} />;
    case 'pageBox': return <PageBoxDialog close={close} />;
    case 'metadata': return <MetadataDialog close={close} />;
    case 'export': return <ExportDialog args={args as never} close={close} />;
    case 'fonts': return <FontsDialog close={close} />;
    default: return null;
  }
}
