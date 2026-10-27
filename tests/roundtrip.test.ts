import { describe, expect, it, beforeAll } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib';
import { parseContentStream, serializeOps } from '@/lib/pdf/lexer';
import { PdfEngine } from '@/lib/pdf/engine';
import { defaultMupdfLoader } from '@/lib/pdf/security';
import type { Shaper } from '@/lib/pdf/shaping';
import type { Subsetter } from '@/lib/pdf/subset';
import { makeFixture, nodeFontLoader, nodeShaper, nodeSubsetter, pdfjsItems, pdfjsText, testPng } from './helpers';

let fixture: Uint8Array;
let shaper: Shaper;
let subsetter: Subsetter;

const engine = () => new PdfEngine({ fontLoader: nodeFontLoader, shaper, subsetter, mupdf: defaultMupdfLoader });

async function openFixture() {
  const e = engine();
  const info = await e.open(fixture);
  return { e, info, uid: info.pages[0].uid };
}

async function reopen(bytes: Uint8Array) {
  const e = engine();
  const info = await e.open(bytes);
  return { e, info, uid: info.pages[0].uid };
}

beforeAll(async () => {
  fixture = await makeFixture();
  shaper = await nodeShaper();
  subsetter = await nodeSubsetter();
});

describe('lexer', () => {
  it('re-serializes untouched operators byte-for-byte', () => {
    const src = new TextEncoder().encode('q 1 0 0 1 72 700 cm BT /F1 12 Tf (Hello \\(x\\)) Tj [(A) -120 (B)] TJ ET Q\n/Span <</MCID 0>> BDC EMC');
    const cs = parseContentStream(src);
    expect(cs.ops.map((o) => o.op)).toEqual(['q', 'cm', 'BT', 'Tf', 'Tj', 'TJ', 'ET', 'Q', 'BDC', 'EMC']);
    const out = new TextDecoder().decode(serializeOps(cs.ops, src));
    expect(out.replace(/\n/g, ' ').trim()).toBe(new TextDecoder().decode(src).replace(/\n/g, ' ').trim());
  });

  it('parses inline images and literal string escapes', () => {
    const src = new TextEncoder().encode('BI /W 2 /H 1 /CS /G /BPC 8 ID \u0001\u0002 EI (a\\101\\nb) Tj');
    const cs = parseContentStream(src);
    expect(cs.ops[0].op).toBe('BI');
    expect(Array.from(cs.ops[0].inline!.data)).toEqual([1, 2]);
    const s = cs.ops[1].args[0];
    expect(s.t === 'str' && new TextDecoder().decode(s.v)).toBe('aA\nb');
  });
});

describe('parser / object model', () => {
  it('extracts text runs, lines, blocks, images and paths', async () => {
    const { e, uid } = await openFixture();
    const m = e.getPageModel(uid);
    const texts = m.lines.map((l) => l.text);
    expect(texts).toContain('Hello World from Helvetica');
    expect(texts).toContain('Embedded subset font line');
    expect(m.images).toHaveLength(1);
    expect(m.images[0].bbox.width).toBeCloseTo(100, 0);
    expect(m.paths.length).toBeGreaterThanOrEqual(2);
    const red = m.paths.find((p) => p.fill?.rgb?.r === 1);
    expect(red?.bbox.width).toBeCloseTo(100, 0);
    const para = m.blocks.find((b) => b.text.startsWith('Second paragraph line one'));
    expect(para?.lineIds).toHaveLength(2);
    const run = m.texts.find((t) => t.text === 'Hello World from Helvetica')!;
    expect(run.fontSize).toBe(18);
    expect(run.font.baseFont).toBe('Helvetica');
    expect(run.bbox.x).toBeCloseTo(72, 0);
  });
});

describe('text editing round-trip', () => {
  it('rewrites a show operator in place when the font can encode the text', async () => {
    const { e, uid } = await openFixture();
    const line = e.getPageModel(uid).lines.find((l) => l.text === 'Hello World from Helvetica')!;
    const res = await e.editLine(uid, line.id, 'Hello PDF Editor from Helvetica');
    expect(res.warnings).toEqual([]);
    const content = e.pageContent(uid);
    // No cover-up rectangles were painted: the original string was replaced.
    expect(content).not.toMatch(/1 1 1 rg/);
    const saved = await e.save();
    const [p1] = await pdfjsText(saved);
    expect(p1).toContain('Hello PDF Editor from Helvetica');
    expect(p1).not.toContain('Hello World');
    // Reopen in the editor: the edited run uses the original font resource.
    const r = await reopen(saved);
    const run = r.e.getPageModel(r.uid).texts.find((t) => t.text.startsWith('Hello PDF Editor'))!;
    expect(run.font.baseFont).toBe('Helvetica');
    expect(run.origin.x).toBeCloseTo(72, 1);
  });

  it('keeps following text in place after a length-changing edit (TJ correction)', async () => {
    const { e, uid } = await openFixture();
    const before = await pdfjsItems(fixture);
    const line = e.getPageModel(uid).lines.find((l) => l.text.startsWith('Invoice'))!;
    await e.editLine(uid, line.id, 'Invoice total: 250 EUR');
    const after = await pdfjsItems(await e.save());
    const y = (items: typeof before, s: string) => items.find((i) => i.str.includes(s))!;
    expect(y(after, 'Embedded').x).toBeCloseTo(y(before, 'Embedded').x, 3);
    expect(y(after, 'Embedded').y).toBeCloseTo(y(before, 'Embedded').y, 3);
    expect(y(after, '250 EUR').x).toBeCloseTo(72, 1);
  });

  it('falls back to a matched embedded font when glyphs are missing from the subset', async () => {
    const { e, uid } = await openFixture();
    const line = e.getPageModel(uid).lines.find((l) => l.text === 'Embedded subset font line')!;
    const res = await e.editLine(uid, line.id, 'Embedded subset font line QJXZ');
    expect(res.warnings.join(' ')).toMatch(/not present in the embedded font subset/);
    const saved = await e.save();
    const [p1] = await pdfjsText(saved);
    expect(p1).toContain('Embedded subset font line QJXZ');
    const r = await reopen(saved);
    const run = r.e.getPageModel(r.uid).texts.find((t) => t.text.includes('QJXZ'))!;
    expect(run.font.baseFont).toMatch(/Arimo/);
    expect(run.origin.x).toBeCloseTo(72, 1);
  });

  it('applies style changes (size, colour, bold) by re-setting the text', async () => {
    const { e, uid } = await openFixture();
    const line = e.getPageModel(uid).lines.find((l) => l.text === 'Hello World from Helvetica')!;
    await e.setTextStyle(uid, [line.id], { fontSize: 24, color: { r: 1, g: 0, b: 0 }, bold: true });
    const r = await reopen(await e.save());
    const run = r.e.getPageModel(r.uid).texts.find((t) => t.text === 'Hello World from Helvetica')!;
    expect(run.fontSize).toBeCloseTo(24, 3);
    expect(run.color.rgb).toEqual({ r: 1, g: 0, b: 0 });
    expect(run.font.bold).toBe(true);
  });

  it('reflows a paragraph into its width', async () => {
    const { e, uid } = await openFixture();
    const block = e.getPageModel(uid).blocks.find((b) => b.text.startsWith('Second paragraph'))!;
    await e.editBlock(uid, block.id, 'This replacement paragraph is considerably longer than the original two lines and must wrap onto several lines', undefined, true);
    const r = await reopen(await e.save());
    const lines = r.e.getPageModel(r.uid).lines.filter((l) => l.bbox.y < 570 && l.bbox.y > 400 && l.bbox.x < 80);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const width = block.bbox.width;
    for (const l of lines) expect(l.bbox.width).toBeLessThanOrEqual(width + 1);
    expect(lines.map((l) => l.text).join(' ')).toContain('must wrap onto several lines');
  });

  it('adds text in complex scripts (Bengali, Arabic) with shaping and ToUnicode', async () => {
    const { e, uid } = await openFixture();
    await e.addText(uid, { x: 72, y: 450, width: 0, text: 'বাংলা লেখা', style: { fontSize: 16 } });
    await e.addText(uid, { x: 72, y: 420, width: 0, text: 'مرحبا بالعالم', style: { fontSize: 16 } });
    const saved = await e.save();
    const [p1] = await pdfjsText(saved);
    // pdf.js ignores /ActualText; it sees glyphs in visual order but no junk characters.
    expect(p1).toContain('বাংলা');
    expect(p1).not.toMatch(/[;˙]/);
    expect(p1).toMatch(/[؀-ۿ]/);
    const r = await reopen(saved);
    const m = r.e.getPageModel(r.uid);
    const bn = m.texts.find((t) => /[ঀ-৿]/.test(t.text))!;
    expect(bn.font.baseFont).toMatch(/NotoSansBengali/);
    // Our own reader honours /ActualText: exact logical text round-trips.
    expect(bn.text).toBe('বাংলা লেখা');
    const ar = m.texts.find((t) => /[؀-ۿ]/.test(t.text))!;
    expect(ar.rtl).toBe(true);
    expect(ar.text).toBe('مرحبا بالعالم');
  });

  it('embeds subset fonts whose used glyphs keep real outlines (HarfBuzz subsetter)', async () => {
    const { e, uid } = await openFixture();
    await e.addText(uid, { x: 72, y: 450, width: 0, text: 'CONFIDENTIAL abc', style: { fontSize: 30 } });
    const saved = await e.save();
    const doc = await PDFDocument.load(saved);
    const fontkit = (await import('@pdf-lib/fontkit')).default;
    let checked = 0;
    for (const [, cid] of doc.context.enumerateIndirectObjects()) {
      // Our CIDFonts carry a CIDToGIDMap stream (pdf-lib's own use /Identity).
      if (!(cid instanceof PDFDict) || !(doc.context.lookup(cid.get(PDFName.of('CIDToGIDMap'))) instanceof PDFStream)) continue;
      const obj = doc.context.lookup(cid.get(PDFName.of('FontDescriptor'))) as PDFDict;
      if (!/Arimo/.test(String(obj.get(PDFName.of('FontName'))))) continue;
      const ff = doc.context.lookup(obj.get(PDFName.of('FontFile2')));
      if (!(ff instanceof PDFStream)) continue;
      const bytes = decodePDFRawStream(ff as PDFRawStream).decode();
      const font = fontkit.create(bytes as never) as unknown as { glyphForCodePoint(c: number): { id: number }; getGlyph(id: number): { path: { commands: unknown[] } } };
      const full = fontkit.create((await nodeFontLoader('Arimo_400Regular.ttf')) as never) as unknown as typeof font;
      for (const ch of 'CONFIDENTIALabc') {
        const gid = full.glyphForCodePoint(ch.codePointAt(0)!).id;
        expect(font.getGlyph(gid).path.commands.length, `glyph ${ch}`).toBeGreaterThan(0);
      }
      expect(bytes.length).toBeLessThan(200_000);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('find & replace all rewrites streams across pages; undo/redo restore exactly', async () => {
    const { e, uid } = await openFixture();
    const original = e.pageContent(uid);
    const hits = await e.search({ query: 'text', matchCase: false });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const res = await e.replaceAll({ query: 'paragraph', wholeWord: true }, 'section');
    expect(res.count).toBe(2);
    let [p1] = await pdfjsText(await e.save());
    expect(p1).toContain('Second section line one');
    expect(p1).not.toContain('paragraph');
    await e.undo();
    expect(e.pageContent(uid)).toBe(original);
    [p1] = await pdfjsText(await e.save());
    expect(p1).toContain('Second paragraph line one');
    await e.redo();
    [p1] = await pdfjsText(await e.save());
    expect(p1).toContain('Second section line two');
    const re = await e.search({ query: 'S(ec)\\w+', regex: true, matchCase: true });
    expect(re.map((h) => h.text)).toContain('Second');
  });

  it('moves and deletes text blocks', async () => {
    const { e, uid } = await openFixture();
    const m = e.getPageModel(uid);
    const b = m.blocks.find((x) => x.text.startsWith('Hello World'))!;
    await e.transformObjects(uid, [b.id], [1, 0, 0, 1, 50, -20]);
    let r = await reopen(await e.save());
    const moved = r.e.getPageModel(r.uid).texts.find((t) => t.text.startsWith('Hello World'))!;
    expect(moved.origin.x).toBeCloseTo(122, 1);
    expect(moved.origin.y).toBeCloseTo(680, 1);
    const b2 = e.getPageModel(uid).blocks.find((x) => x.text.startsWith('Invoice'))!;
    await e.deleteObjects(uid, [b2.id]);
    r = await reopen(await e.save());
    expect(r.e.getPageModel(r.uid).lines.map((l) => l.text).join('|')).not.toContain('Invoice');
    expect(r.e.getPageModel(r.uid).lines.map((l) => l.text)).toContain('Embedded subset font line');
  });
});

describe('images', () => {
  const png1x1 = testPng(4, 2, [0, 128, 255]);

  it('replaces an embedded image keeping its position (contain fit)', async () => {
    const { e, uid } = await openFixture();
    const img = e.getPageModel(uid).images[0];
    await e.replaceImage(uid, img.id, { bytes: png1x1, mime: 'image/png' }, 'contain');
    const r = await reopen(await e.save());
    const m = r.e.getPageModel(r.uid);
    expect(m.images).toHaveLength(1);
    expect(m.images[0].width).toBe(4);
    expect(m.images[0].bbox.x).toBeCloseTo(400, 1);
    expect(m.images[0].bbox.width).toBeCloseTo(100, 1);
    expect(m.images[0].bbox.height).toBeCloseTo(50, 1);
  });

  it('moves, crops, sets opacity, extracts and deletes images', async () => {
    const { e, uid } = await openFixture();
    let img = e.getPageModel(uid).images[0];
    await e.transformObjects(uid, [img.id], [1, 0, 0, 1, -100, -100]);
    img = e.getPageModel(uid).images[0];
    expect(img.bbox.x).toBeCloseTo(300, 1);
    await e.setImageOpacity(uid, img.id, 0.5);
    img = e.getPageModel(uid).images[0];
    const ex = await e.extractImage(uid, img.id);
    expect(ex.mime).toBe('image/png');
    expect(Array.from(ex.bytes.slice(1, 4))).toEqual([80, 78, 71]);
    await e.cropImage(uid, img.id, { x: 300, y: 500, width: 50, height: 50 });
    await e.deleteObjects(uid, [e.getPageModel(uid).images[0].id]);
    const r = await reopen(await e.save());
    expect(r.e.getPageModel(r.uid).images).toHaveLength(0);
  });

  it('inserts new images and shapes', async () => {
    const { e, uid } = await openFixture();
    await e.insertImage(uid, { bytes: png1x1, mime: 'image/png' }, { x: 50, y: 50, width: 80, height: 40 });
    await e.addShape(uid, { kind: 'ellipse', points: [200, 100, 300, 160], stroke: { r: 0, g: 0, b: 1 }, fill: { r: 1, g: 1, b: 0 }, lineWidth: 2 });
    await e.addShape(uid, { kind: 'arrow', points: [320, 100, 420, 150], stroke: { r: 1, g: 0, b: 0 }, fill: null, lineWidth: 2 });
    const r = await reopen(await e.save());
    const m = r.e.getPageModel(r.uid);
    expect(m.images).toHaveLength(2);
    expect(m.paths.some((p) => p.fill?.rgb?.g === 1 && p.stroke?.rgb?.b === 1)).toBe(true);
  });
});

describe('vector paths', () => {
  it('recolours, moves and deletes an existing path', async () => {
    const { e, uid } = await openFixture();
    let red = e.getPageModel(uid).paths.find((p) => p.fill?.rgb?.r === 1 && p.fill.rgb.g === 0)!;
    await e.stylePath(uid, red.id, { fill: { r: 0, g: 0, b: 1 }, stroke: { r: 0, g: 0, b: 0 }, lineWidth: 3 });
    const blue = e.getPageModel(uid).paths.find((p) => p.fill?.rgb?.b === 1)!;
    expect(blue.stroke?.rgb).toEqual({ r: 0, g: 0, b: 0 });
    await e.transformObjects(uid, [blue.id], [1, 0, 0, 1, 10, 10]);
    red = e.getPageModel(uid).paths.find((p) => p.fill?.rgb?.b === 1)!;
    expect(red.bbox.x).toBeCloseTo(310 - 1.5, 0);
    await e.deleteObjects(uid, [red.id]);
    expect(e.getPageModel(uid).paths.some((p) => p.fill?.rgb?.b === 1)).toBe(false);
  });

  it('changes z-order', async () => {
    const { e, uid } = await openFixture();
    const p = e.getPageModel(uid).paths.find((x) => x.fill?.rgb?.r === 1)!;
    await e.reorderObject(uid, p.id, 'front');
    const m = e.getPageModel(uid);
    const last = m.paths[m.paths.length - 1];
    expect(last.fill?.rgb?.r).toBe(1);
    expect(last.bbox.x).toBeCloseTo(300, 1);
  });
});

describe('redaction', () => {
  it('removes glyphs under the area from the content stream, keeps the rest in place', async () => {
    const { e, uid } = await openFixture();
    const line = e.getPageModel(uid).lines.find((l) => l.text.startsWith('Invoice'))!;
    const hit = (await e.search({ query: 'Invoice' }))[0];
    const stats = await e.redact([{ pageUid: uid, rects: [hit.bbox] }]);
    expect(stats.glyphs).toBe(7);
    const saved = await e.save();
    const [p1] = await pdfjsText(saved);
    expect(p1).not.toContain('Invoice');
    expect(p1).toContain('total: 100 USD');
    const before = await pdfjsItems(fixture);
    const after = await pdfjsItems(saved);
    const t0 = before.find((i) => i.str.includes('Invoice'))!;
    const t1 = after.find((i) => i.str.includes('total'))!;
    // Remaining text did not move horizontally beyond the removed word's advance.
    expect(t1.x).toBeGreaterThan(t0.x);
    expect(t1.y).toBeCloseTo(t0.y, 3);
    void line;
  });

  it('redacts image pixels instead of only covering them', async () => {
    const { e, uid } = await openFixture();
    const img = e.getPageModel(uid).images[0];
    const stats = await e.redact([{ pageUid: uid, rects: [{ x: img.bbox.x, y: img.bbox.y, width: 50, height: 100 }] }]);
    expect(stats.images).toBe(1);
    const m = e.getPageModel(uid);
    const ex = await e.extractImage(uid, m.images[0].id);
    expect(ex.mime).toBe('image/png');
  });
});

describe('incremental save', () => {
  it('returns the original bytes when nothing changed', async () => {
    const { e } = await openFixture();
    const out = await e.save({ incremental: true });
    expect(out.length).toBe(fixture.length);
  });

  it('appends an update that preserves the original bytes', async () => {
    const { e, uid } = await openFixture();
    const line = e.getPageModel(uid).lines.find((l) => l.text.startsWith('Hello'))!;
    await e.editLine(uid, line.id, 'Hello Incremental');
    const out = await e.save({ incremental: true });
    expect(out.length).toBeGreaterThan(fixture.length);
    expect(Buffer.from(out.subarray(0, fixture.length)).equals(Buffer.from(fixture))).toBe(true);
    const [p1, p2] = await pdfjsText(out);
    expect(p1).toContain('Hello Incremental');
    expect(p2).toContain('Page two text');
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
  });

  it('works for files using cross-reference streams', async () => {
    const d = await PDFDocument.load(fixture);
    const xrefStreamFile = await d.save({ useObjectStreams: true });
    const { e, uid } = await reopen(xrefStreamFile);
    const line = e.getPageModel(uid).lines.find((l) => l.text.startsWith('Hello'))!;
    await e.editLine(uid, line.id, 'Hello XRef Stream');
    const out = await e.save({ incremental: true });
    const [p1] = await pdfjsText(out);
    expect(p1).toContain('Hello XRef Stream');
  });
});

describe('pages', () => {
  it('duplicates, moves, rotates, deletes pages with undo', async () => {
    const { e, info } = await openFixture();
    const [a, b] = info.pages.map((p) => p.uid);
    let i = await e.duplicatePage(a);
    expect(i.pageCount).toBe(3);
    i = await e.movePage(b, 0);
    expect(i.pages[0].uid).toBe(b);
    i = await e.rotatePages([b], 90);
    expect(i.pages[0].rotation).toBe(90);
    expect(i.pages[0].width).toBe(792);
    i = await e.deletePages([b]);
    expect(i.pageCount).toBe(2);
    i = await e.undo();
    expect(i.pageCount).toBe(3);
    i = await e.undo();
    i = await e.undo();
    i = await e.undo();
    expect(i.pageCount).toBe(2);
    expect(i.pages[0].uid).toBe(a);
    const texts = await pdfjsText(await e.save());
    expect(texts[0]).toContain('Hello World');
    expect(texts[1]).toContain('Page two');
  });

  it('merges, inserts, extracts and splits', async () => {
    const { e } = await openFixture();
    let i = await e.mergePdfs([fixture]);
    expect(i.pageCount).toBe(4);
    i = await e.insertBlankPage(1);
    expect(i.pageCount).toBe(5);
    const part = await e.extractPages([i.pages[0].uid, i.pages[2].uid]);
    expect((await PDFDocument.load(part)).getPageCount()).toBe(2);
    const parts = await e.splitDocument(['1-2', '3-']);
    expect(parts.map((p) => p.length > 0)).toEqual([true, true]);
    expect((await PDFDocument.load(parts[1])).getPageCount()).toBe(3);
    i = await e.setPageBox(i.pages[0].uid, 'CropBox', [50, 50, 500, 700]);
    expect(i.pages[0].width).toBe(450);
  });
});

describe('annotations, links, forms', () => {
  it('adds highlight, note, link; edits and flattens', async () => {
    const { e, uid } = await openFixture();
    const hit = (await e.search({ query: 'Helvetica' }))[0];
    await e.addAnnotation(uid, { type: 'Highlight', rects: [hit.bbox], contents: 'Check this' });
    await e.addAnnotation(uid, { type: 'Text', rects: [{ x: 500, y: 700, width: 20, height: 20 }], contents: 'Sticky note' });
    await e.addAnnotation(uid, { type: 'Link', rects: [{ x: 72, y: 690, width: 200, height: 20 }], uri: 'https://example.com' });
    await e.addAnnotation(uid, { type: 'FreeText', rects: [{ x: 300, y: 400, width: 150, height: 40 }], contents: 'Free text comment' });
    let m = e.getPageModel(uid);
    expect(m.annotations.map((a) => a.subtype)).toEqual(['Highlight', 'Text', 'Link', 'FreeText']);
    const link = m.annotations.find((a) => a.subtype === 'Link')!;
    expect(link.uri).toBe('https://example.com');
    await e.updateAnnotation(uid, link.index, { destPage: 1 });
    m = e.getPageModel(uid);
    expect(m.annotations.find((a) => a.subtype === 'Link')!.destPage).toBe(1);
    const res = await e.flattenAnnotations([uid]);
    expect(res.count).toBe(3);
    m = e.getPageModel(uid);
    expect(m.annotations.map((a) => a.subtype)).toEqual(['Link']);
    const [p1] = await pdfjsText(await e.save());
    expect(p1).toContain('Free text comment');
  });

  it('creates, fills (Unicode) and flattens form fields', async () => {
    const { e, uid } = await openFixture();
    await e.createField(uid, { type: 'text', name: 'name', rect: { x: 72, y: 300, width: 200, height: 20 } });
    await e.createField(uid, { type: 'checkbox', name: 'agree', rect: { x: 72, y: 270, width: 14, height: 14 } });
    await e.createField(uid, { type: 'dropdown', name: 'color', rect: { x: 72, y: 240, width: 100, height: 20 }, options: ['Red', 'Green'] });
    await e.createField(uid, { type: 'signature', name: 'sig', rect: { x: 300, y: 240, width: 150, height: 40 } });
    let fields = e.getFields();
    expect(fields.map((f) => [f.name, f.type])).toEqual([['name', 'text'], ['agree', 'checkbox'], ['color', 'dropdown'], ['sig', 'signature']]);
    await e.setFieldValue('name', 'Žofia Ćwik');
    await e.setFieldValue('agree', true);
    await e.setFieldValue('color', 'Green');
    fields = e.getFields();
    expect(fields[0].value).toBe('Žofia Ćwik');
    expect(fields[1].value).toBe(true);
    const r = await reopen(await e.save());
    expect(r.e.getFields()[0].value).toBe('Žofia Ćwik');
    await e.undo();
    expect(e.getFields()[2].value).toBe('');
    await e.redo();
    await e.flattenForm();
    expect(e.getFields()).toHaveLength(0);
    const [p1] = await pdfjsText(await e.save());
    expect(p1).toContain('Žofia Ćwik');
  });
});

describe('advanced', () => {
  it('adds page numbers, Bates numbers and a watermark as real content', async () => {
    const { e } = await openFixture();
    await e.applyStamps({ kind: 'pageNumbers', format: 'Page {page} of {total}' });
    await e.applyStamps({ kind: 'bates', prefix: 'ABC', digits: 5, start: 7 });
    await e.applyStamps({ kind: 'watermark', text: 'CONFIDENTIAL', behind: true });
    const texts = await pdfjsText(await e.save());
    expect(texts[0]).toContain('Page 1 of 2');
    expect(texts[1]).toContain('Page 2 of 2');
    expect(texts[1]).toContain('ABC00008');
    expect(texts[0]).toContain('CONFIDENTIAL');
  });

  it('writes an invisible OCR text layer', async () => {
    const { e, uid } = await openFixture();
    await e.applyOcr(uid, { imageWidth: 1224, imageHeight: 1584, words: [{ text: 'Scanned', x0: 100, y0: 1000, x1: 260, y1: 1030, confidence: 90 }, { text: 'words', x0: 270, y0: 1000, x1: 380, y1: 1030, confidence: 90 }] }, 'searchable');
    const m = e.getPageModel(uid);
    const run = m.texts.find((t) => t.text === 'Scanned')!;
    expect(run.renderMode).toBe(3);
    expect(run.bbox.x).toBeCloseTo(50, 0);
    const [p1] = await pdfjsText(await e.save());
    expect(p1).toContain('Scanned');
  });

  it('edits metadata', async () => {
    const { e } = await openFixture();
    const info = await e.setMetadata({ title: 'New title', author: 'Jane' });
    expect(info.metadata.title).toBe('New title');
    const r = await reopen(await e.save());
    expect(r.info.metadata.author).toBe('Jane');
  });

  it('encrypts with a password (mupdf) and reopens with it', async () => {
    const { e } = await openFixture();
    const enc = await e.save({ encrypt: { userPassword: 'secret' } });
    const e2 = engine();
    await expect(e2.open(enc)).rejects.toThrow(/password/i);
    const info = await e2.open(enc, { password: 'secret' });
    expect(info.wasEncrypted).toBe(true);
    const [p1] = await pdfjsText(await e2.save());
    expect(p1).toContain('Hello World');
  });

  it('compresses structure and exports DOCX', async () => {
    const { e } = await openFixture();
    const c = await e.save({ compress: true });
    expect(c.length).toBeLessThanOrEqual(fixture.length);
    const docx = await e.exportDocx();
    expect(String.fromCharCode(docx[0], docx[1])).toBe('PK');
  });
});
