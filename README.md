# PDF Editor

A browser-based PDF editor (Next.js 14, TypeScript) that edits the **real content** of PDF files: text, images, vector paths, links, annotations, form fields and pages are rewritten in the PDF's content streams and object graph. Nothing is covered up with white boxes. All processing runs locally in the browser, inside Web Workers.

## Setup

Requirements: Node.js 18.18+ (tested with Node 22) and npm.

```bash
npm install          # also runs scripts/copy-assets.mjs (fonts, wasm, workers → /public)
npm run dev          # http://localhost:3000
# production
npm run build && npm start
# tests (parser/writer round-trip and every feature, against pdf.js as an independent reader)
npm test
npm run typecheck
```

Optional environment variables (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_CJK_FONT_BASE` | Where Noto Sans SC is downloaded from on demand (each weight is about 10 MB, so it is not bundled). |
| `NEXT_PUBLIC_TESSDATA_URL` | Where tesseract.js downloads OCR language data from. |

## Architecture

```
app/                    routes: /  (open / merge / drafts)   /editor/[id]
components/editor/      Editor, Toolbar, PageCanvas, PageOverlay (Konva), ThumbnailSidebar,
                        PropertiesPanel, TextEditor, ImageReplacer, FindReplaceDialog, Dialogs
lib/pdf/                the engine (runs in a Worker; also directly in Node for tests)
  lexer.ts              content-stream tokenizer / operator parser / byte-preserving serializer
  parser.ts             interpreter: graphics + text state → TextRun / ImageObject / VectorPath
  layout.ts             runs → lines (shared baseline) → blocks (paragraphs, alignment, leading)
  fontinfo.ts           existing fonts: ToUnicode/encodings/widths, glyph-coverage check
  cmap.ts, encodings.ts CMap parsing, Standard/WinAnsi/MacRoman/Symbol, glyph names
  fonts.ts              font matching, Type0/Identity-H embedding, bidi + shaping → glyph runs
  shaping.ts            HarfBuzz (wasm) shaper, fontkit fallback, bidi (UAX#9 via bidi-js)
  subset.ts             HarfBuzz hb-subset (glyph ids retained)
  writer.ts             PageEditor: operator splices, clone-on-write resources, TJ builders
  textedit.ts           in-place edit, re-set with fallback font, paragraph reflow, new text
  images.ts             XObject decode/extract (PNG encoder), replace/fit/crop/opacity, pixel edits
  vector.ts             shapes, restyle/move/delete paths, z-order
  pages.ts              reorder/rotate/delete/duplicate/insert/extract/merge/split/boxes
  annotations.ts        markup, notes, comments, ink, links (+ appearance streams), flatten
  forms.ts              AcroForm detect/fill/create (text, checkbox, radio, dropdown, signature)
  redact.ts             true redaction (glyph-level, image pixels, paths, forms copy-on-write)
  stamps.ts             watermark, header/footer, page numbers, Bates, OCR text layer
  ocr.ts                tesseract.js recognition helpers
  security.ts           mupdf.js: decrypt, AES-256 encrypt, structural compression, repair
  incremental.ts        change tracking, incremental save, garbage-collected full save
  history.ts            command pattern (object snapshots / byte snapshots) → unlimited undo
  exporters.ts          DOCX export (best effort)
  engine.ts             PdfEngine: the API used by the UI and the tests
workers/engine.worker.ts  Comlink worker hosting PdfEngine (fonts, wasm, OffscreenCanvas codec)
lib/client/             worker client, pdf.js rendering cache, IndexedDB drafts, image utils
store/editorStore.ts    Zustand: document, models, selection, tools, history mirror, autosave
tests/roundtrip.test.ts open → edit → save → reopen → verify (31 tests)
```

### How a text edit works

1. `parser.ts` interprets the page's content stream. It tracks the CTM, text matrices, font, size, Tc/Tw/Tz/TL/Ts, colours and marked content, and records a `TextRun` per show operator (`Tj`, `TJ`, `'`, `"`) with a page-space box for every glyph.
2. `layout.ts` merges runs into lines and paragraphs.
3. On commit, `textedit.ts` diffs the old and new text. If the change falls inside one run, keeps the style, and the embedded font can encode every new character (checked against the actual glyph outlines of the subset), the run's **string operand is re-encoded in place**, followed by a `TJ` offset so later text on the line stays exactly where it was.
4. Otherwise the run is replaced by an isolated text object, `ET q BT … ET Q BT <Tm> [shift] TJ`. It uses a matched font: Arimo, Tinos or Cousine are metric-compatible with Helvetica, Times and Courier, and Noto covers Bengali, Arabic, Devanagari, Hebrew and CJK. The text is shaped with HarfBuzz, bidi-reordered, embedded as Type0/Identity-H with a ToUnicode CMap, and wrapped in `/ActualText` where needed. The user is warned about the substitution.
5. Untouched operators are copied byte-for-byte. **Incremental save** appends only the changed objects plus a new xref section (table or stream, matching the original), so the original bytes stay intact.

Undo works because edits never mutate shared objects: resources, `/Annots` and content are cloned on write, and a command snapshots the page or field dictionaries before and after.

## Features

- **Text:** inline editing (double-click, or use the Edit Text tool); font family, size, colour, bold/italic, alignment, line height, letter spacing; new text boxes with wrapping; paragraph reflow; move/rotate/resize/delete; Find & Replace (plain, regex, match case, whole word) with Replace All rewriting the content streams; complex scripts and RTL.
- **Images:** replace (keep, contain or cover fit), move/resize/rotate/flip, crop, opacity, delete, download, insert PNG/JPG/WebP/SVG.
- **Vectors:** select existing paths and change fill, stroke and width, move or delete them; draw rectangles, ellipses, lines, arrows and freehand.
- **Pages:** thumbnails with drag-and-drop reorder, rotate, delete, duplicate, insert blank, extract, merge, split (zip), insert from another PDF, CropBox/MediaBox.
- **Annotations and forms:** highlight, underline, strikeout, sticky notes, comments, ink; edit/add/remove web and internal links; fill AcroForms (Unicode values); create text, checkbox, radio, dropdown and signature fields; flatten forms and annotations.
- **Advanced:** true redaction; signatures (draw, type or upload); watermark, header/footer, page numbers, Bates numbering; OCR (searchable or editable); compression; AES-256 password protection, and opening protected files; metadata (Info + XMP); export to PDF (full or incremental), PNG/JPG per page, and DOCX.
- **UX:** tool modes, properties panel, zoom 25–400% with fit width/page, continuous virtualized scrolling, multi-select, snapping guides, align, z-order, unlimited undo/redo, keyboard shortcuts, IndexedDB autosave, dark mode, responsive panels.

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl/⌘+Z, Ctrl/⌘+Y (or Shift+Ctrl/⌘+Z) | Undo, redo |
| Ctrl/⌘+C, Ctrl/⌘+V | Copy and paste text blocks and images |
| Ctrl/⌘+F | Find & Replace |
| Ctrl/⌘+S | Download and save draft |
| Delete / Backspace | Delete selection |
| Arrow keys (Shift = 10 pt) | Nudge selection |
| Esc | Clear selection or cancel |
| V T I A S N F G R | Select, Edit Text, Edit Image, Add Text, Shapes, Annotate, Forms, Sign, Redact |
| + / − | Zoom |

## Limitations and graceful degradation

- **Type3 fonts:** text is decoded via `/Encoding` and ToUnicode, but glyph procedures cannot be re-encoded. Edited Type3 text is re-set with a similar embedded font, and the user is warned.
- **Embedded Type1 / bare CFF subsets:** their outlines are not inspected. A character counts as present if the document already uses it or lists it in `/Differences`; otherwise the editor falls back to an embedded font. TrueType and OpenType programs are checked glyph by glyph.
- **Vertical writing (Identity-V), text inside Form XObjects, and clipping paths** are shown but read-only. Form XObject content can be made editable with **Make editable**, which inlines the form into the page with renamed resources.
- **Obfuscated or broken content streams:** the tokenizer never throws. Unknown operators are preserved, damaged pages are flagged "Partially interpreted" and remain viewable, and files pdf-lib cannot load are repaired with mupdf first.
- **Reflow** wraps paragraphs that the editor rewrites, using the first run's style. Mixed styles inside a rewritten paragraph collapse to that style. Edits contained within one run keep everything else.
- **Moving or scaling text** transforms the glyphs (no reflow). Moving objects to the front or back reconstructs their state, so a clipping path that originally applied to the object is not carried over.
- **Shaping and text extraction:** HarfBuzz shapes complex scripts. ToUnicode cannot express reordered clusters (such as the Bengali pre-base vowel), so `/ActualText` carries the exact text. Acrobat and this editor use it; pdf.js-based viewers extract such clusters in visual order.
- **Fonts:** fontkit's TrueType subsetter, which pdf-lib's `subset: true` uses, produces broken outlines for several modern Google/Noto fonts. This editor subsets with HarfBuzz (retaining glyph ids) or embeds full fonts, and does not use the fontkit subsetter. CJK fonts are downloaded on demand.
- **Redaction:** glyphs are removed from the content stream, and Flate/raw image pixels are overwritten natively. DCT (JPEG) images are edited through OffscreenCanvas in the browser; JPX, JBIG2 and CCITT images under a redaction area are removed entirely, with a warning. Paths are deleted when at least 50% of their box is covered. Annotations and widgets in the area are removed.
- **Images:** extraction supports DCT, JPX passthrough, Flate/LZW/RunLength with Gray/RGB/CMYK/ICC/Indexed/Separation and 1–16 bpc, predictors and SMask. Other encodings are reported as unsupported.
- **Incremental save** is not available after decryption or repair, because the file had to be rewritten. Compression and encryption always produce a full rewrite.
- **Digital signatures:** signature fields are created and visual signatures placed. Cryptographic (PKCS#7) signing is not implemented.
- **DOCX export** is best effort: paragraphs and images in reading order, without tables or exact positioning.
- **OCR** needs network access once per language to download tesseract data. The worker and wasm core are self-hosted.
- **Very large files:** pages render lazily (virtualized) and parsing runs in a worker. Every edit is a cheap object snapshot. Autosave writes a full copy to IndexedDB about 2.5 s after changes, which is the main cost for 100 MB files.
- **Licensing:** mupdf.js is AGPL-3.0. It is isolated in `lib/pdf/security.ts` and loaded lazily (decrypt, encrypt, compress, repair). Drop it, or obtain a commercial licence, if AGPL is not acceptable. Everything else is MIT, Apache or OFL licensed.
- **No server backend** is included. Everything runs client-side. The engine is environment-agnostic (it runs in Node, as the tests show), so it can be wrapped in an API route for server-side jobs.
