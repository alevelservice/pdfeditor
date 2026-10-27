'use client';
/**
 * Inline text editor overlay. Editing an existing paragraph keeps a
 * contenteditable-like textarea in sync with the text block of the object
 * model; committing rewrites the content stream (per line when the line
 * structure is unchanged, otherwise the paragraph is reflowed).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '@/store/editorStore';
import type { PageCoords } from '@/lib/client/coords';
import type { PageModel } from '@/lib/pdf/types';
import { rgbToHex } from '@/lib/client/imageUtils';

export default function TextEditor({ coords, model }: { coords: PageCoords; model: PageModel | null }) {
  const editing = useEditor((s) => s.editing)!;
  const defaults = useEditor((s) => s.textDefaults);
  const { set, act } = useEditor.getState();
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const [value, setValue] = useState(editing.text);

  const block = editing.blockId ? model?.blocks.find((b) => b.id === editing.blockId) : null;
  const firstRun = useMemo(() => {
    if (!block || !model) return null;
    const line = model.lines.find((l) => l.id === block.lineIds[0]);
    return model.texts.find((t) => t.id === line?.runIds[0]) ?? null;
  }, [block, model]);

  const zoom = coords.zoom;
  const fontSize = (block ? block.fontSize : defaults.fontSize) * zoom;
  const lineHeight = block && block.lineIds.length > 1 ? block.lineHeight * zoom : fontSize * 1.2;
  const family = firstRun ? (firstRun.font.monospace ? 'Cousine, Courier New, monospace' : firstRun.font.serif ? 'Tinos, Times New Roman, serif' : 'Arimo, Arial, Helvetica, sans-serif') : defaults.fontFamily === 'Tinos' ? 'Times New Roman, serif' : defaults.fontFamily === 'Cousine' ? 'Courier New, monospace' : 'Arial, sans-serif';
  const color = firstRun?.color.rgb ? rgbToHex(firstRun.color.rgb) : rgbToHex(defaults.color);
  const rtl = firstRun?.rtl ?? false;

  let left: number, top: number, width: number;
  if (block) {
    const r = coords.rectToView(block.bbox);
    left = r.x - 2;
    top = r.y - 2;
    width = Math.max(r.width + fontSize * 2, 80);
  } else {
    const [x, y] = coords.pointToView(editing.rect.x, editing.rect.y);
    left = x;
    top = y;
    width = editing.rect.width > 0 ? editing.rect.width * zoom : Math.max(200, coords.width - x - 10);
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);

  const close = () => set({ editing: null });

  const commit = async () => {
    if (done.current) return;
    done.current = true;
    const text = value;
    close();
    if (block) {
      if (text === block.text) return;
      const sameLines = text.split('\n').length === block.lineIds.length;
      if (sameLines) await act('Edit text', (e) => e.editBlock(editing.pageUid, block.id, text, undefined, false));
      else {
        // Single newlines are soft wraps; blank lines separate paragraphs.
        const flowed = text.replace(/\n{2,}/g, '\u0000').replace(/\n/g, ' ').replace(/\u0000/g, '\n');
        await act('Edit paragraph', (e) => e.editBlock(editing.pageUid, block.id, flowed, undefined, true));
      }
    } else if (text.trim()) {
      await act('Add text', (e) =>
        e.addText(editing.pageUid, {
          x: editing.rect.x,
          y: editing.rect.y,
          width: editing.rect.width,
          text,
          style: { fontSize: defaults.fontSize, fontFamily: defaults.fontFamily, color: defaults.color, bold: defaults.bold, italic: defaults.italic },
        }),
      );
    }
  };

  return (
    <textarea
      ref={ref}
      data-testid="inline-text-editor"
      value={value}
      dir={rtl ? 'rtl' : 'auto'}
      spellCheck
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          done.current = true;
          close();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          commit();
        }
      }}
      className="absolute z-20 resize-none overflow-hidden rounded-sm border border-brand-500 bg-white p-0.5 shadow-lg outline-none ring-2 ring-brand-500/30"
      style={{
        left,
        top,
        width,
        minHeight: lineHeight + 6,
        fontSize,
        lineHeight: `${lineHeight}px`,
        fontFamily: family,
        fontWeight: firstRun?.font.bold || (!block && defaults.bold) ? 700 : 400,
        fontStyle: firstRun?.font.italic || (!block && defaults.italic) ? 'italic' : 'normal',
        color,
        whiteSpace: 'pre',
      }}
    />
  );
}
