/**
 * Shared types for the PDF object model. These are plain, structured-clone
 * friendly objects so they can cross the worker boundary unchanged.
 */

/** Affine matrix in PDF row-vector convention: [a b c d e f]. */
export type Matrix = [number, number, number, number, number, number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface ColorInfo {
  /** Colour space family the operator used. */
  space: 'gray' | 'rgb' | 'cmyk' | 'other' | 'pattern';
  comps: number[];
  /** Best-effort sRGB approximation for display / property panel. */
  rgb: RGB | null;
}

export interface FontSummary {
  resourceName: string;
  baseFont: string;
  family: string;
  subtype: string;
  embedded: boolean;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  monospace: boolean;
  type3: boolean;
}

export interface GlyphBox {
  /** Unicode text produced by the glyph (may be '' or several chars for ligatures). */
  text: string;
  /** Page-space bounding box. */
  bbox: Rect;
}

export interface TextRun {
  id: string;
  kind: 'text';
  /** Index of the show operator inside the page content stream. */
  opIndex: number;
  text: string;
  font: FontSummary;
  fontSize: number;
  color: ColorInfo;
  /** Text rendering mode (Tr). 3 = invisible (typical OCR layer). */
  renderMode: number;
  charSpacing: number;
  wordSpacing: number;
  horizontalScale: number;
  rise: number;
  /** Text matrix at the start of the run (Tm). */
  textMatrix: Matrix;
  /** Line matrix (Tlm) at the run. */
  lineMatrix: Matrix;
  /** CTM at the run. */
  ctm: Matrix;
  /** Full text-space -> page-space transform at the start of the run. */
  matrix: Matrix;
  /** Advance of the run in unscaled text space units (used for state restore). */
  advance: number;
  /** Page-space origin of the baseline start. */
  origin: { x: number; y: number };
  /** Rotation of the baseline in degrees (counter-clockwise, page space). */
  rotation: number;
  bbox: Rect;
  glyphs: GlyphBox[];
  rtl: boolean;
  /** Text came from an /ActualText span (glyphs and text are not 1:1). */
  actualText?: boolean;
  editable: boolean;
  readOnlyReason?: string;
}

export interface TextLine {
  id: string;
  runIds: string[];
  text: string;
  bbox: Rect;
  /** Character offset ranges of each run inside `text`. */
  runSpans: { runId: string; start: number; end: number }[];
  baselineY: number;
  rotation: number;
  fontSize: number;
}

export interface TextBlock {
  id: string;
  lineIds: string[];
  bbox: Rect;
  text: string;
  lineHeight: number;
  align: 'left' | 'center' | 'right' | 'justify';
  fontSize: number;
}

export interface ImageObject {
  id: string;
  kind: 'image';
  opIndex: number;
  /** Resource name (XObject) or null for inline images. */
  name: string | null;
  inline: boolean;
  /** Image space (unit square) -> page space matrix. */
  matrix: Matrix;
  bbox: Rect;
  width: number;
  height: number;
  colorSpace: string;
  bitsPerComponent: number;
  filter: string;
  hasAlpha: boolean;
  editable: boolean;
  readOnlyReason?: string;
}

export interface VectorPath {
  id: string;
  kind: 'path';
  /** First construction operator index and the painting operator index (inclusive). */
  opStart: number;
  opEnd: number;
  ops: string[];
  fill: ColorInfo | null;
  stroke: ColorInfo | null;
  lineWidth: number;
  ctm: Matrix;
  bbox: Rect;
  clip: boolean;
  /** SVG path data in page space (y up) for overlay hit-testing / outline drawing. */
  svg: string;
  editable: boolean;
  readOnlyReason?: string;
}

export type AnnotationKind =
  | 'Text'
  | 'FreeText'
  | 'Highlight'
  | 'Underline'
  | 'StrikeOut'
  | 'Squiggly'
  | 'Ink'
  | 'Square'
  | 'Circle'
  | 'Line'
  | 'Link'
  | 'Widget'
  | 'Stamp'
  | 'Redact'
  | 'Other';

export interface Annotation {
  id: string;
  kind: 'annotation';
  subtype: AnnotationKind;
  rawSubtype: string;
  /** Index in the page /Annots array. */
  index: number;
  rect: Rect;
  contents: string;
  author: string;
  color: RGB | null;
  quadPoints?: number[];
  /** For links. */
  uri?: string;
  destPage?: number;
  hasAppearance: boolean;
}

export type FieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'optionlist' | 'button' | 'signature' | 'unknown';

export interface FormFieldWidget {
  pageUid: string;
  rect: Rect;
}

export interface FormField {
  name: string;
  type: FieldType;
  value: string | boolean | string[];
  options: string[];
  readOnly: boolean;
  required: boolean;
  multiline: boolean;
  widgets: FormFieldWidget[];
}

export interface PageInfo {
  uid: string;
  index: number;
  /** View box (CropBox clipped to MediaBox) in user space. */
  view: [number, number, number, number];
  mediaBox: [number, number, number, number];
  cropBox: [number, number, number, number];
  rotation: number;
  /** Displayed size (after rotation) in points. */
  width: number;
  height: number;
  version: number;
}

export interface PageModel {
  uid: string;
  version: number;
  info: PageInfo;
  texts: TextRun[];
  lines: TextLine[];
  blocks: TextBlock[];
  images: ImageObject[];
  paths: VectorPath[];
  annotations: Annotation[];
  warnings: string[];
  /** True when content could not be fully interpreted (degraded / read-only page). */
  degraded: boolean;
}

export interface DocMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  creationDate: string | null;
  modificationDate: string | null;
}

export interface DocInfo {
  pageCount: number;
  pages: PageInfo[];
  metadata: DocMetadata;
  hasForm: boolean;
  wasEncrypted: boolean;
  baseVersion: number;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  canIncrementalSave: boolean;
}

export type RenderSource =
  | { kind: 'base'; baseVersion: number; index: number }
  | { kind: 'preview'; bytes: Uint8Array };

export interface TextStyle {
  fontFamily?: string;
  fontSize?: number;
  color?: RGB;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right' | 'justify';
  lineHeight?: number;
  charSpacing?: number;
}

export interface EditResult {
  warnings: string[];
  /** Page-space rect to re-select after the edit (if applicable). */
  focus?: { pageUid: string; rect: Rect; kind: 'text' | 'image' | 'path' | 'annotation' };
}

export interface SearchOptions {
  query: string;
  regex?: boolean;
  matchCase?: boolean;
  wholeWord?: boolean;
}

export interface SearchHit {
  pageUid: string;
  pageIndex: number;
  lineId: string;
  start: number;
  end: number;
  text: string;
  context: string;
  bbox: Rect;
}

export type FitMode = 'keep' | 'contain' | 'cover' | 'stretch';

export interface NewImage {
  /** PNG or JPEG bytes (the UI converts SVG/WebP to PNG before sending). */
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
}

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow' | 'freehand';

export interface ShapeSpec {
  kind: ShapeKind;
  /** Page-space points. rect/ellipse use [x1,y1,x2,y2]; line/arrow 2 points; freehand many. */
  points: number[];
  stroke: RGB | null;
  fill: RGB | null;
  lineWidth: number;
  opacity?: number;
}

export interface StampOptions {
  kind: 'watermark' | 'header' | 'footer' | 'pageNumbers' | 'bates';
  text?: string;
  image?: NewImage;
  fontFamily?: string;
  fontSize?: number;
  color?: RGB;
  opacity?: number;
  rotation?: number;
  position?: 'left' | 'center' | 'right';
  behind?: boolean;
  margin?: number;
  /** For bates numbering. */
  prefix?: string;
  suffix?: string;
  start?: number;
  digits?: number;
  /** Page numbers format, supports {page} {total} {date}. */
  format?: string;
  pageRange?: string;
}

export interface OcrWord {
  text: string;
  /** Bounding box in image pixels (top-left origin) */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
}

export interface OcrPageResult {
  words: OcrWord[];
  imageWidth: number;
  imageHeight: number;
}

export interface FontWarning {
  original: string;
  substitute: string;
  reason: string;
}
