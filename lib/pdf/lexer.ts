/**
 * Content stream tokenizer, operator parser and serializer.
 *
 * Every parsed operator keeps the byte range it came from, so that untouched
 * operators are written back byte-for-byte when a stream is re-serialized.
 */

export type PdfValue =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'str'; v: Uint8Array; hex?: boolean }
  | { t: 'arr'; v: PdfValue[] }
  | { t: 'dict'; v: [string, PdfValue][] }
  | { t: 'bool'; v: boolean }
  | { t: 'null' };

export interface InlineImage {
  dict: [string, PdfValue][];
  data: Uint8Array;
}

export interface Op {
  op: string;
  args: PdfValue[];
  /** Byte range [start, end) in the source buffer. Absent for synthesized ops. */
  src?: [number, number];
  inline?: InlineImage;
}

export interface ContentStream {
  ops: Op[];
  source: Uint8Array;
  /** Non-fatal problems found while tokenizing. */
  warnings: string[];
}

const WS = new Uint8Array(256);
[0, 9, 10, 12, 13, 32].forEach((c) => (WS[c] = 1));
const DELIM = new Uint8Array(256);
'()<>[]{}/%'.split('').forEach((c) => (DELIM[c.charCodeAt(0)] = 1));

const isWS = (c: number) => WS[c] === 1;
const isDelim = (c: number) => DELIM[c] === 1;
const isRegular = (c: number) => !isWS(c) && !isDelim(c);

type Token =
  | { k: 'val'; v: PdfValue; start: number }
  | { k: 'kw'; v: string; start: number; end: number }
  | { k: 'arrOpen'; start: number }
  | { k: 'arrClose' }
  | { k: 'dictOpen'; start: number }
  | { k: 'dictClose' }
  | { k: 'eof' };

export class Lexer {
  pos = 0;
  constructor(public buf: Uint8Array) {}

  private skipWS() {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (isWS(c)) this.pos++;
      else if (c === 0x25 /* % */) {
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  next(): Token {
    this.skipWS();
    const b = this.buf;
    if (this.pos >= b.length) return { k: 'eof' };
    const start = this.pos;
    const c = b[this.pos];
    switch (c) {
      case 0x28 /* ( */:
        return { k: 'val', v: this.literalString(), start };
      case 0x3c /* < */:
        if (b[this.pos + 1] === 0x3c) {
          this.pos += 2;
          return { k: 'dictOpen', start };
        }
        return { k: 'val', v: this.hexString(), start };
      case 0x3e /* > */:
        if (b[this.pos + 1] === 0x3e) {
          this.pos += 2;
          return { k: 'dictClose' };
        }
        this.pos++;
        return this.next();
      case 0x5b /* [ */:
        this.pos++;
        return { k: 'arrOpen', start };
      case 0x5d /* ] */:
        this.pos++;
        return { k: 'arrClose' };
      case 0x7b:
      case 0x7d /* { } (PostScript calculator braces - treat as keywords) */:
        this.pos++;
        return { k: 'kw', v: String.fromCharCode(c), start, end: this.pos };
      case 0x2f /* / */:
        return { k: 'val', v: this.name(), start };
      default: {
        let end = this.pos;
        while (end < b.length && isRegular(b[end])) end++;
        if (end === this.pos) {
          // Stray delimiter (e.g. ')') - skip it.
          this.pos++;
          return this.next();
        }
        const word = latin1(b, this.pos, end);
        this.pos = end;
        const n = parseNumber(word);
        if (n !== null) return { k: 'val', v: { t: 'num', v: n }, start };
        if (word === 'true') return { k: 'val', v: { t: 'bool', v: true }, start };
        if (word === 'false') return { k: 'val', v: { t: 'bool', v: false }, start };
        if (word === 'null') return { k: 'val', v: { t: 'null' }, start };
        return { k: 'kw', v: word, start, end };
      }
    }
  }

  private name(): PdfValue {
    const b = this.buf;
    this.pos++; // '/'
    const out: number[] = [];
    while (this.pos < b.length && isRegular(b[this.pos])) {
      const c = b[this.pos];
      if (c === 0x23 /* # */ && this.pos + 2 < b.length) {
        const h = parseInt(String.fromCharCode(b[this.pos + 1], b[this.pos + 2]), 16);
        if (!Number.isNaN(h)) {
          out.push(h);
          this.pos += 3;
          continue;
        }
      }
      out.push(c);
      this.pos++;
    }
    return { t: 'name', v: decodeNameBytes(out) };
  }

  private literalString(): PdfValue {
    const b = this.buf;
    this.pos++; // '('
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      let c = b[this.pos++];
      if (c === 0x5c /* \ */) {
        if (this.pos >= b.length) break;
        c = b[this.pos++];
        switch (c) {
          case 0x6e: out.push(10); break; // n
          case 0x72: out.push(13); break; // r
          case 0x74: out.push(9); break; // t
          case 0x62: out.push(8); break; // b
          case 0x66: out.push(12); break; // f
          case 0x28: out.push(0x28); break;
          case 0x29: out.push(0x29); break;
          case 0x5c: out.push(0x5c); break;
          case 13:
            if (b[this.pos] === 10) this.pos++;
            break; // line continuation
          case 10:
            break;
          default:
            if (c >= 0x30 && c <= 0x37) {
              let v = c - 0x30;
              for (let i = 0; i < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; i++) {
                v = v * 8 + (b[this.pos++] - 0x30);
              }
              out.push(v & 0xff);
            } else out.push(c);
        }
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29) {
        depth--;
        if (depth === 0) break;
      }
      out.push(c);
    }
    return { t: 'str', v: Uint8Array.from(out) };
  }

  private hexString(): PdfValue {
    const b = this.buf;
    this.pos++; // '<'
    const digits: number[] = [];
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const c = b[this.pos++];
      const d = hexVal(c);
      if (d >= 0) digits.push(d);
    }
    this.pos++; // '>'
    if (digits.length % 2) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = (digits[2 * i] << 4) | digits[2 * i + 1];
    return { t: 'str', v: out, hex: true };
  }
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

function latin1(b: Uint8Array, s: number, e: number): string {
  let r = '';
  for (let i = s; i < e; i++) r += String.fromCharCode(b[i]);
  return r;
}

function decodeNameBytes(bytes: number[]): string {
  // Names are byte sequences; we treat them as UTF-8 when valid, else latin1.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return String.fromCharCode(...bytes);
  }
}

function parseNumber(w: string): number | null {
  const c = w.charCodeAt(0);
  if (!((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e)) return null;
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) return parseFloat(w);
  // Lenient handling of malformed numbers such as "--5" or "4.-2"
  if (/^[+\-.\d]+$/.test(w)) {
    const m = w.match(/[+-]?\d*\.?\d+/);
    return m ? parseFloat(m[0]) || 0 : 0;
  }
  return null;
}

/** Parse a full content stream into operators. Never throws on malformed input. */
export function parseContentStream(source: Uint8Array): ContentStream {
  const lex = new Lexer(source);
  const ops: Op[] = [];
  const warnings: string[] = [];
  let operands: PdfValue[] = [];
  let opStart = -1;
  // Stack for nested arrays/dicts
  const stack: { kind: 'arr' | 'dict'; items: PdfValue[] }[] = [];

  const push = (v: PdfValue, start: number) => {
    if (stack.length) stack[stack.length - 1].items.push(v);
    else {
      if (opStart < 0) opStart = start;
      operands.push(v);
    }
  };

  let guard = 0;
  for (;;) {
    if (++guard > 50_000_000) {
      warnings.push('Content stream too large; truncated');
      break;
    }
    const tok = lex.next();
    if (tok.k === 'eof') break;
    switch (tok.k) {
      case 'val':
        push(tok.v, tok.start);
        break;
      case 'arrOpen':
        if (!stack.length && opStart < 0) opStart = tok.start;
        stack.push({ kind: 'arr', items: [] });
        break;
      case 'dictOpen':
        if (!stack.length && opStart < 0) opStart = tok.start;
        stack.push({ kind: 'dict', items: [] });
        break;
      case 'arrClose':
      case 'dictClose': {
        const top = stack.pop();
        if (!top) {
          warnings.push('Unbalanced array/dict close');
          break;
        }
        const v: PdfValue =
          top.kind === 'arr' ? { t: 'arr', v: top.items } : { t: 'dict', v: pairsFromList(top.items) };
        if (stack.length) stack[stack.length - 1].items.push(v);
        else operands.push(v);
        break;
      }
      case 'kw': {
        if (stack.length) {
          // Keywords inside arrays (malformed) - keep as names so nothing is lost.
          stack[stack.length - 1].items.push({ t: 'name', v: tok.v });
          break;
        }
        const start = opStart >= 0 ? opStart : tok.start;
        if (tok.v === 'BI') {
          const inline = parseInlineImage(lex, source, warnings);
          ops.push({ op: 'BI', args: [], src: [start, lex.pos], inline: inline ?? undefined });
        } else {
          ops.push({ op: tok.v, args: operands, src: [start, tok.end] });
        }
        operands = [];
        opStart = -1;
        break;
      }
    }
  }
  if (operands.length) warnings.push('Trailing operands without operator ignored');
  return { ops, source, warnings };
}

function pairsFromList(items: PdfValue[]): [string, PdfValue][] {
  const out: [string, PdfValue][] = [];
  for (let i = 0; i + 1 < items.length; i += 2) {
    const k = items[i];
    if (k.t === 'name') out.push([k.v, items[i + 1]]);
  }
  return out;
}

const INLINE_ABBREV: Record<string, string> = {
  W: 'Width',
  H: 'Height',
  BPC: 'BitsPerComponent',
  CS: 'ColorSpace',
  F: 'Filter',
  DP: 'DecodeParms',
  IM: 'ImageMask',
  D: 'Decode',
  I: 'Interpolate',
  L: 'Length',
};

export function inlineDictGet(dict: [string, PdfValue][], key: string): PdfValue | undefined {
  for (const [k, v] of dict) if (k === key || INLINE_ABBREV[k] === key) return v;
  return undefined;
}

function parseInlineImage(lex: Lexer, b: Uint8Array, warnings: string[]): InlineImage | null {
  const items: PdfValue[] = [];
  const stack: { kind: 'arr' | 'dict'; items: PdfValue[] }[] = [];
  for (;;) {
    const tok = lex.next();
    if (tok.k === 'eof') return null;
    if (tok.k === 'kw' && tok.v === 'ID' && !stack.length) break;
    if (tok.k === 'val') (stack.length ? stack[stack.length - 1].items : items).push(tok.v);
    else if (tok.k === 'arrOpen') stack.push({ kind: 'arr', items: [] });
    else if (tok.k === 'dictOpen') stack.push({ kind: 'dict', items: [] });
    else if (tok.k === 'arrClose' || tok.k === 'dictClose') {
      const top = stack.pop();
      if (!top) continue;
      const v: PdfValue = top.kind === 'arr' ? { t: 'arr', v: top.items } : { t: 'dict', v: pairsFromList(top.items) };
      (stack.length ? stack[stack.length - 1].items : items).push(v);
    } else if (tok.k === 'kw') items.push({ t: 'name', v: tok.v });
  }
  const dict = pairsFromList(items);
  // A single whitespace byte follows ID.
  let dataStart = lex.pos;
  if (isWS(b[dataStart])) dataStart++;
  const num = (k: string) => {
    const v = inlineDictGet(dict, k);
    return v && v.t === 'num' ? v.v : 0;
  };
  const filter = inlineDictGet(dict, 'Filter');
  const len = num('Length');
  let dataEnd = -1;
  if (len > 0) dataEnd = dataStart + len;
  else if (!filter || (filter.t === 'arr' && filter.v.length === 0)) {
    const w = num('Width');
    const h = num('Height');
    const isMask = inlineDictGet(dict, 'ImageMask');
    const bpc = isMask && isMask.t === 'bool' && isMask.v ? 1 : num('BitsPerComponent') || 8;
    const cs = inlineDictGet(dict, 'ColorSpace');
    let comps = 1;
    if (cs && cs.t === 'name') {
      if (cs.v === 'RGB' || cs.v === 'DeviceRGB') comps = 3;
      else if (cs.v === 'CMYK' || cs.v === 'DeviceCMYK') comps = 4;
    }
    if (isMask && isMask.t === 'bool' && isMask.v) comps = 1;
    dataEnd = dataStart + Math.ceil((w * comps * bpc) / 8) * h;
  }
  if (dataEnd < 0 || dataEnd > b.length || !isEIAt(b, dataEnd)) {
    // Heuristic search: whitespace EI whitespace, followed by something that looks like content.
    dataEnd = -1;
    for (let i = dataStart; i < b.length - 1; i++) {
      if (b[i] === 0x45 && b[i + 1] === 0x49 && (i === dataStart || isWS(b[i - 1])) &&
        (i + 2 >= b.length || isWS(b[i + 2]) || isDelim(b[i + 2]))) {
        if (looksLikeContent(b, i + 2)) {
          dataEnd = i > dataStart && isWS(b[i - 1]) ? i - 1 : i;
          break;
        }
      }
    }
    if (dataEnd < 0) {
      warnings.push('Inline image without EI');
      lex.pos = b.length;
      return { dict, data: b.subarray(dataStart) };
    }
  }
  const data = b.slice(dataStart, dataEnd);
  // Advance past EI
  let p = dataEnd;
  while (p < b.length && isWS(b[p])) p++;
  if (b[p] === 0x45 && b[p + 1] === 0x49) p += 2;
  lex.pos = p;
  return { dict, data };
}

function isEIAt(b: Uint8Array, pos: number): boolean {
  let p = pos;
  while (p < b.length && isWS(b[p])) p++;
  return b[p] === 0x45 && b[p + 1] === 0x49 && (p + 2 >= b.length || !isRegular(b[p + 2]));
}

function looksLikeContent(b: Uint8Array, from: number): boolean {
  const end = Math.min(b.length, from + 24);
  for (let i = from; i < end; i++) {
    const c = b[i];
    if (c > 0x7e || (c < 0x20 && !isWS(c))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(5);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

function escapeName(n: string): string {
  const bytes = new TextEncoder().encode(n);
  let s = '/';
  for (const c of bytes) {
    if (c < 0x21 || c > 0x7e || isDelim(c) || c === 0x23) s += '#' + c.toString(16).padStart(2, '0');
    else s += String.fromCharCode(c);
  }
  return s;
}

function serializeString(v: Uint8Array, hex?: boolean): string {
  let printable = true;
  for (const c of v) if (c < 0x20 || c > 0x7e) { printable = false; break; }
  if (hex || !printable) {
    let s = '<';
    for (const c of v) s += c.toString(16).padStart(2, '0');
    return s + '>';
  }
  let s = '(';
  for (const c of v) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += '\\';
    s += String.fromCharCode(c);
  }
  return s + ')';
}

export function serializeValue(v: PdfValue): string {
  switch (v.t) {
    case 'num': return fmtNum(v.v);
    case 'name': return escapeName(v.v);
    case 'str': return serializeString(v.v, v.hex);
    case 'arr': return '[' + v.v.map(serializeValue).join(' ') + ']';
    case 'dict': return '<<' + v.v.map(([k, x]) => escapeName(k) + ' ' + serializeValue(x)).join(' ') + '>>';
    case 'bool': return v.v ? 'true' : 'false';
    case 'null': return 'null';
  }
}

const latin1Encode = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/** Serialize operators. Ops with a `src` range are copied verbatim from `source`. */
export function serializeOps(ops: Op[], source?: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const nl = new Uint8Array([10]);
  const add = (c: Uint8Array) => {
    chunks.push(c);
    total += c.length;
  };
  for (const op of ops) {
    if (op.src && source) {
      add(source.subarray(op.src[0], op.src[1]));
    } else if (op.op === 'BI' && op.inline) {
      const head = 'BI ' + op.inline.dict.map(([k, v]) => escapeName(k) + ' ' + serializeValue(v)).join(' ') + ' ID ';
      add(latin1Encode(head));
      add(op.inline.data);
      add(latin1Encode('\nEI'));
    } else {
      const s = (op.args.length ? op.args.map(serializeValue).join(' ') + ' ' : '') + op.op;
      add(latin1Encode(s));
    }
    add(nl);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

// Small helpers to synthesize operators ------------------------------------

export const num = (v: number): PdfValue => ({ t: 'num', v });
export const name = (v: string): PdfValue => ({ t: 'name', v });
export const str = (v: Uint8Array, hex = true): PdfValue => ({ t: 'str', v, hex });
export const arr = (v: PdfValue[]): PdfValue => ({ t: 'arr', v });
export const mkop = (op: string, ...args: PdfValue[]): Op => ({ op, args });
export const nums = (op: string, ...vals: number[]): Op => ({ op, args: vals.map(num) });
