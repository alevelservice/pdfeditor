/**
 * AcroForm support: detection, filling, creating fields (text, checkbox,
 * radio, dropdown, signature), removing and flattening.
 */
import {
  PDFArray,
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFFont,
  PDFOptionList,
  PDFPage,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFString,
  PDFTextField,
} from 'pdf-lib';
import { asDict, lookup, N, rectArray, refKey } from './objects';
import { writableAnnots } from './annotations';
import type { FieldType, FormField } from './types';

export function hasForm(doc: PDFDocument): boolean {
  const af = asDict(lookup(doc.context, doc.catalog.get(N('AcroForm'))));
  const fields = af ? lookup(doc.context, af.get(N('Fields'))) : undefined;
  return fields instanceof PDFArray && fields.size() > 0;
}

function typeOf(f: PDFField): FieldType {
  if (f instanceof PDFTextField) return 'text';
  if (f instanceof PDFCheckBox) return 'checkbox';
  if (f instanceof PDFRadioGroup) return 'radio';
  if (f instanceof PDFDropdown) return 'dropdown';
  if (f instanceof PDFOptionList) return 'optionlist';
  if (f instanceof PDFButton) return 'button';
  if (f instanceof PDFSignature) return 'signature';
  return 'unknown';
}

/** Map widget ref key -> page uid. */
function widgetPages(doc: PDFDocument): Map<string, string> {
  const map = new Map<string, string>();
  for (const page of doc.getPages()) {
    const annots = lookup(doc.context, page.node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const r = annots.get(i);
      if (r instanceof PDFRef) map.set(refKey(r), refKey(page.ref));
    }
  }
  return map;
}

export function listFields(doc: PDFDocument): FormField[] {
  if (!hasForm(doc)) return [];
  const form = doc.getForm();
  const wp = widgetPages(doc);
  const ctx = doc.context;
  return form.getFields().map((f) => {
    const type = typeOf(f);
    let value: FormField['value'] = '';
    let options: string[] = [];
    let multiline = false;
    try {
      if (f instanceof PDFTextField) {
        value = f.getText() ?? '';
        multiline = f.isMultiline();
      } else if (f instanceof PDFCheckBox) value = f.isChecked();
      else if (f instanceof PDFRadioGroup) {
        value = f.getSelected() ?? '';
        options = f.getOptions();
      } else if (f instanceof PDFDropdown) {
        value = f.getSelected()[0] ?? '';
        options = f.getOptions();
      } else if (f instanceof PDFOptionList) {
        value = f.getSelected();
        options = f.getOptions();
      }
    } catch {
      /* malformed field values are reported as empty */
    }
    const widgets = f.acroField.getWidgets().map((w) => {
      const ref = ctx.getObjectRef(w.dict);
      const r = rectArray(ctx, w.dict.get(N('Rect')), [0, 0, 0, 0]);
      const pRef = w.P();
      const pageUid = (ref && wp.get(refKey(ref))) ?? (pRef ? refKey(pRef) : '');
      return { pageUid, rect: { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] } };
    });
    return {
      name: f.getName(),
      type,
      value,
      options,
      readOnly: f.isReadOnly(),
      required: f.isRequired(),
      multiline,
      widgets,
    };
  });
}

/** Refs that a form mutation may touch (for undo snapshots). */
export function formRefs(doc: PDFDocument, names?: string[]): PDFRef[] {
  const ctx = doc.context;
  const out: PDFRef[] = [];
  const root = ctx.trailerInfo.Root;
  if (root instanceof PDFRef) out.push(root);
  const afRef = doc.catalog.get(N('AcroForm'));
  if (afRef instanceof PDFRef) out.push(afRef);
  const af = asDict(lookup(ctx, afRef));
  const fieldsRef = af?.get(N('Fields'));
  if (fieldsRef instanceof PDFRef) out.push(fieldsRef);
  if (!hasForm(doc)) return out;
  for (const f of doc.getForm().getFields()) {
    if (names && !names.includes(f.getName())) continue;
    out.push(f.ref);
    let p = f.acroField.getParent();
    while (p) {
      out.push(p.ref);
      p = p.getParent();
    }
    for (const w of f.acroField.getWidgets()) {
      const r = ctx.getObjectRef(w.dict);
      if (r) out.push(r);
    }
  }
  return out;
}

export function setFieldValue(doc: PDFDocument, fieldName: string, value: string | boolean | string[], font?: PDFFont) {
  const form = doc.getForm();
  const f = form.getField(fieldName);
  if (f instanceof PDFTextField) {
    f.setText(String(value ?? ''));
    f.updateAppearances(font ?? form.getDefaultFont());
  } else if (f instanceof PDFCheckBox) {
    if (value === true || value === 'true' || value === 'on') f.check();
    else f.uncheck();
  } else if (f instanceof PDFRadioGroup) {
    if (value) f.select(String(value));
    else f.clear();
  } else if (f instanceof PDFDropdown) {
    if (value) f.select(String(value));
    else f.clear();
    f.updateAppearances(font ?? form.getDefaultFont());
  } else if (f instanceof PDFOptionList) {
    const arr = Array.isArray(value) ? value : value ? [String(value)] : [];
    if (arr.length) f.select(arr);
    else f.clear();
    f.updateAppearances(font ?? form.getDefaultFont());
  } else throw new Error(`Field "${fieldName}" cannot be filled`);
}

export interface NewFieldSpec {
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'signature';
  name: string;
  pageIndex: number;
  rect: { x: number; y: number; width: number; height: number };
  options?: string[];
  value?: string;
  multiline?: boolean;
  fontSize?: number;
}

/** Make the page's Annots a direct, private array so pdf-lib's in-place push stays undoable. */
function privatizeAnnots(doc: PDFDocument, page: PDFPage) {
  writableAnnots(doc.context, page.node);
}

export function createField(doc: PDFDocument, spec: NewFieldSpec, font?: PDFFont) {
  const form = doc.getForm();
  const page = doc.getPage(spec.pageIndex);
  privatizeAnnots(doc, page);
  const opts = { x: spec.rect.x, y: spec.rect.y, width: spec.rect.width, height: spec.rect.height, font };
  if (form.getFieldMaybe(spec.name) && spec.type !== 'radio') throw new Error(`A field named "${spec.name}" already exists`);
  switch (spec.type) {
    case 'text': {
      const f = form.createTextField(spec.name);
      if (spec.multiline) f.enableMultiline();
      if (spec.value) f.setText(spec.value);
      f.addToPage(page, opts);
      if (spec.fontSize) f.setFontSize(spec.fontSize);
      break;
    }
    case 'checkbox': {
      const f = form.createCheckBox(spec.name);
      f.addToPage(page, opts);
      if (spec.value === 'true') f.check();
      break;
    }
    case 'radio': {
      const existing = form.getFieldMaybe(spec.name);
      const f = existing instanceof PDFRadioGroup ? existing : form.createRadioGroup(spec.name);
      const option = spec.value || `Option${f.getOptions().length + 1}`;
      f.addOptionToPage(option, page, opts);
      break;
    }
    case 'dropdown': {
      const f = form.createDropdown(spec.name);
      f.addOptions(spec.options?.length ? spec.options : ['Option 1', 'Option 2']);
      if (spec.value) f.select(spec.value);
      f.addToPage(page, opts);
      break;
    }
    case 'signature': {
      const ctx = doc.context;
      const widget = ctx.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        F: 4,
        Rect: [spec.rect.x, spec.rect.y, spec.rect.x + spec.rect.width, spec.rect.y + spec.rect.height],
      }) as PDFDict;
      widget.set(N('T'), PDFString.of(spec.name));
      widget.set(N('P'), page.ref);
      widget.set(N('MK'), ctx.obj({ BC: [0, 0, 0] }));
      const ref = ctx.register(widget);
      form.acroForm.addField(ref);
      const annots = writableAnnots(ctx, page.node);
      annots.push(ref);
      form.acroForm.dict.set(N('SigFlags'), ctx.obj(1));
      break;
    }
  }
}

export function removeField(doc: PDFDocument, fieldName: string) {
  const form = doc.getForm();
  const f = form.getField(fieldName);
  for (const p of doc.getPages()) privatizeAnnots(doc, p);
  form.removeField(f);
}

/** Ensure every field has up-to-date appearances (needed before flattening). */
export function updateAllAppearances(doc: PDFDocument, font?: PDFFont) {
  const form = doc.getForm();
  const f = font ?? form.getDefaultFont();
  for (const field of form.getFields()) {
    try {
      if (field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList) field.updateAppearances(f);
      else if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) field.defaultUpdateAppearances();
      else if (field instanceof PDFButton) field.updateAppearances(f);
    } catch {
      /* keep existing appearance */
    }
  }
}

/** Remove all fields from the AcroForm (after their widgets were flattened). */
export function clearAcroForm(doc: PDFDocument) {
  const ctx = doc.context;
  const af = asDict(lookup(ctx, doc.catalog.get(N('AcroForm'))));
  if (!af) return;
  const nf = ctx.obj({}) as PDFDict;
  for (const [k, v] of af.entries()) nf.set(k, v);
  nf.set(N('Fields'), ctx.obj([]));
  nf.delete(N('XFA'));
  nf.delete(N('NeedAppearances'));
  doc.catalog.set(N('AcroForm'), ctx.register(nf));
}
