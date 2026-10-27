/**
 * Best-effort DOCX export from the object model: text blocks become
 * paragraphs (size / bold / italic / colour of their first run), images are
 * placed inline in reading order, one section per page.
 */
import { Document, ImageRun, Packer, PageBreak, Paragraph, TextRun as DocxRun, AlignmentType } from 'docx';
import type { ImageObject, PageModel, TextBlock } from './types';

export interface DocxImage {
  pageUid: string;
  imageId: string;
  bytes: Uint8Array;
  type: 'png' | 'jpg';
}

const hex = (r: number, g: number, b: number) =>
  [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

export async function buildDocx(models: PageModel[], images: DocxImage[]): Promise<Uint8Array> {
  const children: Paragraph[] = [];
  models.forEach((m, pi) => {
    type Item = { y: number; x: number; block?: TextBlock; image?: ImageObject };
    const items: Item[] = [
      ...m.blocks.map((b) => ({ y: b.bbox.y + b.bbox.height, x: b.bbox.x, block: b })),
      ...m.images.map((im) => ({ y: im.bbox.y + im.bbox.height, x: im.bbox.x, image: im })),
    ];
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const runsById = new Map(m.texts.map((t) => [t.id, t]));
    const linesById = new Map(m.lines.map((l) => [l.id, l]));
    for (const it of items) {
      if (it.block) {
        const firstLine = linesById.get(it.block.lineIds[0]);
        const run = firstLine ? runsById.get(firstLine.runIds[0]) : undefined;
        if (run && run.renderMode === 3 && m.images.length === 0) continue;
        const color = run?.color.rgb;
        const text = it.block.lineIds
          .map((id) => linesById.get(id)?.text ?? '')
          .reduce((acc, line) => (acc.endsWith('-') ? acc.slice(0, -1) + line : acc ? acc + ' ' + line : line), '');
        children.push(
          new Paragraph({
            alignment: it.block.align === 'center' ? AlignmentType.CENTER : it.block.align === 'right' ? AlignmentType.RIGHT : it.block.align === 'justify' ? AlignmentType.JUSTIFIED : AlignmentType.LEFT,
            spacing: { after: 120 },
            children: [
              new DocxRun({
                text,
                size: Math.max(2, Math.round(it.block.fontSize * 2)),
                bold: run?.font.bold,
                italics: run?.font.italic,
                font: run ? (run.font.monospace ? 'Courier New' : run.font.serif ? 'Times New Roman' : 'Arial') : undefined,
                color: color ? hex(color.r, color.g, color.b) : undefined,
              }),
            ],
          }),
        );
      } else if (it.image) {
        const data = images.find((x) => x.pageUid === m.uid && x.imageId === it.image!.id);
        if (!data) continue;
        const maxW = 600;
        const w = Math.min(maxW, it.image.bbox.width * (96 / 72));
        const h = (w / Math.max(1, it.image.bbox.width * (96 / 72))) * it.image.bbox.height * (96 / 72);
        children.push(new Paragraph({ children: [new ImageRun({ type: data.type, data: data.bytes, transformation: { width: Math.max(1, w), height: Math.max(1, h) } })] }));
      }
    }
    if (pi < models.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
  });
  const doc = new Document({ sections: [{ children }] });
  if (typeof Blob !== 'undefined' && typeof (globalThis as { process?: unknown }).process === 'undefined') {
    const blob = await Packer.toBlob(doc);
    return new Uint8Array(await blob.arrayBuffer());
  }
  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf);
}
