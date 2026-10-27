/**
 * Font subsetting with HarfBuzz (hb-subset.wasm). Glyph ids are retained
 * (HB_SUBSET_FLAGS_RETAIN_GIDS) so content streams can keep using original
 * glyph ids as CIDs.
 *
 * Note: fontkit's TrueType subsetter (used by pdf-lib's `subset: true`)
 * produces broken outlines for several modern Google/Noto fonts, so it is
 * never used for embedding here.
 */

export interface Subsetter {
  subset(font: Uint8Array, glyphIds: number[]): Uint8Array;
}

interface HbSubsetExports {
  memory: WebAssembly.Memory;
  malloc(n: number): number;
  free(p: number): void;
  hb_blob_create(data: number, len: number, mode: number, user: number, destroy: number): number;
  hb_blob_destroy(b: number): void;
  hb_blob_get_data(b: number, lenPtr: number): number;
  hb_blob_get_length(b: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(f: number): void;
  hb_face_reference_blob(f: number): number;
  hb_set_add(s: number, v: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(i: number): void;
  hb_subset_input_glyph_set(i: number): number;
  hb_subset_input_set_flags(i: number, flags: number): void;
  hb_subset_or_fail(face: number, input: number): number;
  _initialize?: () => void;
}

const HB_MEMORY_MODE_WRITABLE = 2;
const HB_SUBSET_FLAGS_RETAIN_GIDS = 0x2;
const HB_SUBSET_FLAGS_NOTDEF_OUTLINE = 0x40;

export async function createHarfBuzzSubsetter(wasm: Uint8Array): Promise<Subsetter> {
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const ex = instance.exports as unknown as HbSubsetExports;
  ex._initialize?.();
  return {
    subset(font, glyphIds) {
      const fontPtr = ex.malloc(font.byteLength);
      new Uint8Array(ex.memory.buffer).set(font, fontPtr);
      const blob = ex.hb_blob_create(fontPtr, font.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0);
      const face = ex.hb_face_create(blob, 0);
      ex.hb_blob_destroy(blob);
      const input = ex.hb_subset_input_create_or_fail();
      if (!input) {
        ex.hb_face_destroy(face);
        ex.free(fontPtr);
        throw new Error('hb_subset_input_create_or_fail failed');
      }
      const glyphs = ex.hb_subset_input_glyph_set(input);
      ex.hb_set_add(glyphs, 0);
      for (const g of glyphIds) ex.hb_set_add(glyphs, g);
      ex.hb_subset_input_set_flags(input, HB_SUBSET_FLAGS_RETAIN_GIDS | HB_SUBSET_FLAGS_NOTDEF_OUTLINE);
      const sub = ex.hb_subset_or_fail(face, input);
      ex.hb_subset_input_destroy(input);
      if (!sub) {
        ex.hb_face_destroy(face);
        ex.free(fontPtr);
        throw new Error('Font subsetting failed');
      }
      const res = ex.hb_face_reference_blob(sub);
      const len = ex.hb_blob_get_length(res);
      const ptr = ex.hb_blob_get_data(res, 0);
      // Copy out before freeing (memory may have grown: re-read the buffer).
      const out = new Uint8Array(ex.memory.buffer, ptr, len).slice();
      ex.hb_blob_destroy(res);
      ex.hb_face_destroy(sub);
      ex.hb_face_destroy(face);
      ex.free(fontPtr);
      if (!len) throw new Error('Font subsetting produced an empty font');
      return out;
    },
  };
}
