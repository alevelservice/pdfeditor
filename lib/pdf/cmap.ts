/**
 * CMap parsing: ToUnicode CMaps and embedded (non-predefined) encoding CMaps
 * for Type0 fonts. Predefined Identity-H/V and UCS2/UTF16 CMaps are
 * synthesized.
 */
import { Lexer, type PdfValue } from './lexer';
import { glyphNameToUnicode } from './encodings';

interface CodeRange {
  len: number;
  lo: number[];
  hi: number[];
}

interface CidRange {
  len: number;
  lo: number;
  hi: number;
  cid: number;
}

const key = (code: number, len: number) => code + len * 0x100000000;

export class CMap {
  codespace: CodeRange[] = [];
  private uni = new Map<number, string>();
  private cidSingle = new Map<number, number>();
  private cidRanges: CidRange[] = [];
  private uniRanges: { len: number; lo: number; hi: number; base: string }[] = [];
  name = '';
  vertical = false;
  /** For predefined CMaps whose code is itself UTF-16BE (Uni*-UCS2-H / UTF16). */
  codeIsUnicode = false;
  identity = false;

  static identity(vertical = false): CMap {
    const c = new CMap();
    c.codespace.push({ len: 2, lo: [0, 0], hi: [255, 255] });
    c.identity = true;
    c.vertical = vertical;
    c.name = vertical ? 'Identity-V' : 'Identity-H';
    return c;
  }

  static predefined(name: string): CMap {
    const vertical = name.endsWith('-V');
    if (name === 'Identity-H' || name === 'Identity-V') return CMap.identity(vertical);
    const c = CMap.identity(vertical);
    c.name = name;
    c.identity = false;
    if (/UCS2|UTF16/.test(name)) c.codeIsUnicode = true;
    return c;
  }

  /** Read one character code starting at `pos`. */
  readCode(bytes: Uint8Array, pos: number): { code: number; len: number } {
    if (this.codespace.length) {
      let code = 0;
      for (let len = 1; len <= 4 && pos + len <= bytes.length; len++) {
        code = code * 256 + bytes[pos + len - 1];
        for (const r of this.codespace) {
          if (r.len !== len) continue;
          let ok = true;
          for (let i = 0; i < len; i++) {
            const b = bytes[pos + i];
            if (b < r.lo[i] || b > r.hi[i]) {
              ok = false;
              break;
            }
          }
          if (ok) return { code, len };
        }
      }
      // No match: consume the smallest codespace length.
      const minLen = Math.min(...this.codespace.map((r) => r.len));
      let c = 0;
      const l = Math.min(minLen, bytes.length - pos);
      for (let i = 0; i < l; i++) c = c * 256 + bytes[pos + i];
      return { code: c, len: Math.max(1, l) };
    }
    return { code: bytes[pos], len: 1 };
  }

  /** Split a string into character codes. */
  codes(bytes: Uint8Array): { code: number; len: number }[] {
    const out: { code: number; len: number }[] = [];
    let p = 0;
    while (p < bytes.length) {
      const c = this.readCode(bytes, p);
      out.push(c);
      p += c.len;
    }
    return out;
  }

  toUnicode(code: number, len: number): string | undefined {
    const v = this.uni.get(key(code, len)) ?? this.uni.get(key(code, 0));
    if (v !== undefined) return v;
    for (const r of this.uniRanges) {
      if ((r.len === len || r.len === 0) && code >= r.lo && code <= r.hi) {
        return incrementLast(r.base, code - r.lo);
      }
    }
    if (this.codeIsUnicode) return String.fromCharCode(code);
    return undefined;
  }

  toCID(code: number, len: number): number {
    if (this.identity) return code;
    const s = this.cidSingle.get(key(code, len));
    if (s !== undefined) return s;
    for (const r of this.cidRanges) if (r.len === len && code >= r.lo && code <= r.hi) return r.cid + (code - r.lo);
    return code;
  }

  hasUnicodeMappings(): boolean {
    return this.uni.size > 0 || this.uniRanges.length > 0;
  }

  /** Reverse mapping Unicode string -> code (for re-encoding text with an existing font). */
  reverseUnicode(): Map<string, { code: number; len: number }> {
    const rev = new Map<string, { code: number; len: number }>();
    for (const [k, v] of this.uni) {
      const len = Math.floor(k / 0x100000000);
      const code = k - len * 0x100000000;
      if (!rev.has(v)) rev.set(v, { code, len: len || 1 });
    }
    for (const r of this.uniRanges) {
      const span = Math.min(r.hi - r.lo, 0xffff);
      for (let i = 0; i <= span; i++) {
        const s = incrementLast(r.base, i);
        if (!rev.has(s)) rev.set(s, { code: r.lo + i, len: r.len || 1 });
      }
    }
    return rev;
  }

  setUnicode(code: number, len: number, s: string) {
    this.uni.set(key(code, len), s);
  }

  parse(data: Uint8Array) {
    const lex = new Lexer(data);
    const stack: PdfValue[] = [];
    let inArr: PdfValue[] | null = null;
    const pop = () => stack.pop();
    for (;;) {
      const tok = lex.next();
      if (tok.k === 'eof') break;
      if (tok.k === 'arrOpen') {
        inArr = [];
        continue;
      }
      if (tok.k === 'arrClose') {
        if (inArr) stack.push({ t: 'arr', v: inArr });
        inArr = null;
        continue;
      }
      if (tok.k === 'val') {
        if (inArr) inArr.push(tok.v);
        else stack.push(tok.v);
        continue;
      }
      if (tok.k !== 'kw') continue;
      switch (tok.v) {
        case 'begincodespacerange':
        case 'beginbfchar':
        case 'beginbfrange':
        case 'begincidrange':
        case 'begincidchar':
          stack.length = 0;
          break;
        case 'endcodespacerange': {
          for (let i = 0; i + 1 < stack.length; i += 2) {
            const lo = stack[i];
            const hi = stack[i + 1];
            if (lo.t === 'str' && hi.t === 'str') {
              this.codespace.push({ len: lo.v.length, lo: Array.from(lo.v), hi: Array.from(hi.v) });
            }
          }
          stack.length = 0;
          break;
        }
        case 'endbfchar': {
          for (let i = 0; i + 1 < stack.length; i += 2) {
            const src = stack[i];
            const dst = stack[i + 1];
            if (src.t !== 'str') continue;
            const code = bytesToInt(src.v);
            if (dst.t === 'str') this.uni.set(key(code, src.v.length), utf16be(dst.v));
            else if (dst.t === 'name') this.uni.set(key(code, src.v.length), glyphNameToUnicode(dst.v));
          }
          stack.length = 0;
          break;
        }
        case 'endbfrange': {
          for (let i = 0; i + 2 < stack.length; i += 3) {
            const lo = stack[i];
            const hi = stack[i + 1];
            const dst = stack[i + 2];
            if (lo.t !== 'str' || hi.t !== 'str') continue;
            const l = bytesToInt(lo.v);
            const h = bytesToInt(hi.v);
            const len = lo.v.length;
            if (dst.t === 'str') {
              if (h - l > 256) this.uniRanges.push({ len, lo: l, hi: h, base: utf16be(dst.v) });
              else {
                const base = utf16be(dst.v);
                for (let c = l; c <= h; c++) this.uni.set(key(c, len), incrementLast(base, c - l));
              }
            } else if (dst.t === 'arr') {
              dst.v.forEach((d, j) => {
                if (d.t === 'str' && l + j <= h) this.uni.set(key(l + j, len), utf16be(d.v));
              });
            }
          }
          stack.length = 0;
          break;
        }
        case 'endcidrange': {
          for (let i = 0; i + 2 < stack.length; i += 3) {
            const lo = stack[i];
            const hi = stack[i + 1];
            const cid = stack[i + 2];
            if (lo.t === 'str' && hi.t === 'str' && cid.t === 'num') {
              this.cidRanges.push({ len: lo.v.length, lo: bytesToInt(lo.v), hi: bytesToInt(hi.v), cid: cid.v });
            }
          }
          stack.length = 0;
          break;
        }
        case 'endcidchar': {
          for (let i = 0; i + 1 < stack.length; i += 2) {
            const src = stack[i];
            const cid = stack[i + 1];
            if (src.t === 'str' && cid.t === 'num') this.cidSingle.set(key(bytesToInt(src.v), src.v.length), cid.v);
          }
          stack.length = 0;
          break;
        }
        case 'usecmap': {
          const n = pop();
          if (n && n.t === 'name') {
            const base = CMap.predefined(n.v);
            if (!this.codespace.length) this.codespace = base.codespace;
            if (base.identity && !this.cidRanges.length && !this.cidSingle.size) this.identity = true;
            this.codeIsUnicode = this.codeIsUnicode || base.codeIsUnicode;
          }
          break;
        }
        case 'def': {
          const v = pop();
          const k = pop();
          if (k && k.t === 'name' && k.v === 'WMode' && v && v.t === 'num') this.vertical = v.v === 1;
          if (k && k.t === 'name' && k.v === 'CMapName' && v && v.t === 'name') this.name = v.v;
          break;
        }
        default:
          break;
      }
    }
    // A CMap with cid mappings but no codespace defaults to 2-byte codes.
    if (!this.codespace.length && (this.cidRanges.length || this.cidSingle.size)) {
      this.codespace.push({ len: 2, lo: [0, 0], hi: [255, 255] });
    }
    return this;
  }
}

function bytesToInt(b: Uint8Array): number {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

export function utf16be(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  if (b.length % 2 === 1) s += String.fromCharCode(b[b.length - 1]);
  return s;
}

function incrementLast(base: string, n: number): string {
  if (!base.length) return base;
  if (n === 0) return base;
  const last = base.charCodeAt(base.length - 1);
  return base.slice(0, -1) + String.fromCharCode(last + n);
}

/** Build a ToUnicode CMap stream body for 2-byte codes. */
export function buildToUnicodeCMap(map: Map<number, string>, codeBytes = 2): Uint8Array {
  const hex = (n: number, bytes: number) => n.toString(16).padStart(bytes * 2, '0').toUpperCase();
  const utf16 = (s: string) => {
    let h = '';
    for (let i = 0; i < s.length; i++) h += hex(s.charCodeAt(i), 2);
    return h;
  };
  // Empty strings are kept (<>): glyphs that continue a shaped cluster must not produce text.
  const entries = [...map.entries()].sort((a, b) => a[0] - b[0]);
  const lines: string[] = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    `<${hex(0, codeBytes)}> <${hex(codeBytes === 1 ? 0xff : 0xffff, codeBytes)}>`,
    'endcodespacerange',
  ];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [c, s] of chunk) lines.push(`<${hex(c, codeBytes)}> <${utf16(s)}>`);
    lines.push('endbfchar');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return new TextEncoder().encode(lines.join('\n'));
}
