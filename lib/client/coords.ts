import { apply, invert, mul, transformRect, viewportTransform } from '@/lib/pdf/geom';
import type { Matrix, PageInfo, Rect } from '@/lib/pdf/types';

/** Mapping between PDF user space (y up) and on-screen page pixels (y down) at a zoom. */
export class PageCoords {
  readonly V: Matrix;
  readonly Vi: Matrix;
  constructor(public info: PageInfo, public zoom: number) {
    this.V = viewportTransform(info.view, info.rotation, zoom);
    this.Vi = invert(this.V);
  }
  get width() {
    return this.info.width * this.zoom;
  }
  get height() {
    return this.info.height * this.zoom;
  }
  rectToView(r: Rect): Rect {
    return transformRect(this.V, r);
  }
  pointToUser(x: number, y: number): [number, number] {
    return apply(this.Vi, x, y);
  }
  pointToView(x: number, y: number): [number, number] {
    return apply(this.V, x, y);
  }
  rectToUser(r: Rect): Rect {
    return transformRect(this.Vi, r);
  }
  /** Convert a view-space transform A (row-vector) into the page-space transform D. */
  viewToUserTransform(A: Matrix): Matrix {
    return mul(mul(this.V, A), this.Vi);
  }
}

export function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}
