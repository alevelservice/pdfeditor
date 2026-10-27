/**
 * "Make editable": replace a Form XObject invocation by its content
 * (q Matrix cm BBox-clip ... Q), merging its resources into the page with
 * renamed keys. Afterwards text/images/paths inside become ordinary page
 * objects that the editor can rewrite.
 */
import { PDFContext, PDFDict, PDFStream } from 'pdf-lib';
import { mkop, nums, parseContentStream, type Op, type PdfValue } from './lexer';
import { asDict, dictGet, lookup, N, numArray, streamBytes } from './objects';
import { matrixOp, PageEditor } from './writer';
import type { FormUse } from './parser';
import type { Matrix } from './types';

const CATEGORIES = ['Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'Properties'] as const;
const DEVICE_CS = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern', 'G', 'RGB', 'CMYK', 'I', 'Indexed']);

export function inlineFormXObject(ctx: PDFContext, editor: PageEditor, pageResources: PDFDict, form: FormUse) {
  const xobjs = asDict(dictGet(ctx, pageResources, 'XObject'));
  const xo = lookup(ctx, xobjs?.get(N(form.name)));
  if (!(xo instanceof PDFStream)) throw new Error('Form XObject not found');
  const formRes = asDict(dictGet(ctx, xo.dict, 'Resources')) ?? pageResources;
  const rename: Record<string, Map<string, string>> = {};
  for (const cat of CATEGORIES) {
    rename[cat] = new Map();
    const d = asDict(dictGet(ctx, formRes, cat));
    if (!d) continue;
    for (const [k, v] of d.entries()) {
      const nm = k.decodeText();
      rename[cat].set(nm, editor.addResource(cat, `${cat.slice(0, 2)}x`, v));
    }
  }
  const ren = (cat: string, v: PdfValue | undefined): PdfValue | undefined => {
    if (!v || v.t !== 'name') return v;
    const r = rename[cat]?.get(v.v);
    return r ? { t: 'name', v: r } : v;
  };
  const parsed = parseContentStream(streamBytes(xo));
  const out: Op[] = [];
  for (const o of parsed.ops) {
    const args = o.args.slice();
    switch (o.op) {
      case 'Tf': args[0] = ren('Font', args[0])!; break;
      case 'Do': args[0] = ren('XObject', args[0])!; break;
      case 'gs': args[0] = ren('ExtGState', args[0])!; break;
      case 'sh': args[0] = ren('Shading', args[0])!; break;
      case 'cs': case 'CS':
        if (args[0]?.t === 'name' && !DEVICE_CS.has(args[0].v)) args[0] = ren('ColorSpace', args[0])!;
        break;
      case 'scn': case 'SCN': {
        const last = args[args.length - 1];
        if (last?.t === 'name') args[args.length - 1] = ren('Pattern', last)!;
        break;
      }
      case 'BDC': case 'DP':
        if (args[1]?.t === 'name') args[1] = ren('Properties', args[1])!;
        break;
    }
    if (o.op === 'BI' && o.inline) {
      const dict = o.inline.dict.map(([k, v]) => [k, (k === 'CS' || k === 'ColorSpace') && v.t === 'name' && !DEVICE_CS.has(v.v) ? ren('ColorSpace', v)! : v] as [string, PdfValue]);
      out.push({ op: 'BI', args: [], inline: { dict, data: o.inline.data } });
    } else out.push({ op: o.op, args });
  }
  const m = numArray(ctx, xo.dict.get(N('Matrix')));
  const bbox = numArray(ctx, xo.dict.get(N('BBox')));
  const ops: Op[] = [mkop('q')];
  if (m.length === 6) ops.push(matrixOp('cm', m as Matrix));
  if (bbox.length === 4) ops.push(nums('re', Math.min(bbox[0], bbox[2]), Math.min(bbox[1], bbox[3]), Math.abs(bbox[2] - bbox[0]), Math.abs(bbox[3] - bbox[1])), mkop('W'), mkop('n'));
  ops.push(...out, mkop('Q'));
  editor.replace(form.opIndex, ops);
}
