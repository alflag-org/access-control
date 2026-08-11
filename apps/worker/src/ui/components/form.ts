import { escapeHtml } from '../formatting/html';

type FormMethod = 'patch' | 'post';
type InputType = 'datetime-local' | 'email' | 'number' | 'text' | 'url';
type ValueType = 'boolean' | 'datetime' | 'json' | 'number' | 'string-list';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface FieldBase {
  id: string;
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  wide?: boolean;
  valueType?: ValueType;
}

export function renderJsonForm(input: {
  action: string;
  method: FormMethod;
  body: string;
  submitLabel: string;
  className?: string;
  confirmMessage?: string;
  reload?: boolean;
  previewOutputId?: string;
  submitTone?: 'danger' | 'primary' | 'secondary';
}): string {
  const attributes = [
    'data-json-form',
    `action="${escapeHtml(input.action)}"`,
    'method="post"',
    `data-http-method="${input.method}"`,
    `class="${escapeHtml(input.className ?? 'edit-form')}"`,
  ];
  if (input.confirmMessage !== undefined) {
    attributes.push(`data-confirm-message="${escapeHtml(input.confirmMessage)}"`);
  }
  if (input.reload === false) attributes.push('data-reload="false"');
  if (input.previewOutputId !== undefined) {
    attributes.push(`data-preview-output="${escapeHtml(input.previewOutputId)}"`);
  }
  return `<form ${attributes.join(' ')}>${input.body}<div class="form-actions"><button class="button button-${input.submitTone ?? 'primary'}" type="submit">${escapeHtml(input.submitLabel)}</button></div><p class="form-result" role="status" aria-live="polite" tabindex="-1"></p></form>`;
}

export function renderTextField(
  input: FieldBase & {
    value?: string | number | undefined;
    type?: InputType;
    placeholder?: string;
    nullable?: boolean;
    readonly?: boolean;
    autocomplete?: string;
  },
): string {
  const attributes = fieldAttributes(input);
  attributes.push(`type="${input.type ?? 'text'}"`);
  if (input.value !== undefined) attributes.push(`value="${escapeHtml(input.value)}"`);
  if (input.placeholder !== undefined) {
    attributes.push(`placeholder="${escapeHtml(input.placeholder)}"`);
  }
  if (input.nullable === true) attributes.push('data-nullable="true"');
  if (input.readonly === true) attributes.push('readonly');
  if (input.autocomplete !== undefined) {
    attributes.push(`autocomplete="${escapeHtml(input.autocomplete)}"`);
  }
  return renderField(input, `<input ${attributes.join(' ')}>`);
}

export function renderTextArea(
  input: FieldBase & {
    value?: string | undefined;
    placeholder?: string;
    nullable?: boolean;
    rows?: number;
  },
): string {
  const attributes = fieldAttributes(input);
  if (input.placeholder !== undefined) {
    attributes.push(`placeholder="${escapeHtml(input.placeholder)}"`);
  }
  if (input.nullable === true) attributes.push('data-nullable="true"');
  if (input.rows !== undefined) attributes.push(`rows="${input.rows}"`);
  return renderField(
    input,
    `<textarea ${attributes.join(' ')}>${escapeHtml(input.value ?? '')}</textarea>`,
  );
}

export function renderSelectField(
  input: FieldBase & {
    value: string;
    options: readonly SelectOption[];
    identityProvider?: boolean;
  },
): string {
  const attributes = fieldAttributes(input);
  if (input.identityProvider === true) attributes.push('data-identity-provider');
  const options = input.options
    .map(
      (option) =>
        `<option value="${escapeHtml(option.value)}"${option.value === input.value ? ' selected' : ''}${option.disabled === true ? ' disabled' : ''}>${escapeHtml(option.label)}</option>`,
    )
    .join('');
  return renderField(input, `<select ${attributes.join(' ')}>${options}</select>`);
}

export function renderMultiSelectField(
  input: FieldBase & {
    values: readonly string[];
    options: readonly SelectOption[];
    size?: number;
  },
): string {
  const attributes = fieldAttributes(input);
  attributes.push('multiple');
  attributes.push(`size="${input.size ?? Math.min(Math.max(input.options.length, 3), 8)}"`);
  const selected = new Set(input.values);
  const options = input.options
    .map(
      (option) =>
        `<option value="${escapeHtml(option.value)}"${selected.has(option.value) ? ' selected' : ''}${option.disabled === true ? ' disabled' : ''}>${escapeHtml(option.label)}</option>`,
    )
    .join('');
  return renderField(input, `<select ${attributes.join(' ')}>${options}</select>`);
}

export function renderCheckbox(input: {
  id: string;
  name: string;
  label: string;
  checked: boolean;
  hint?: string;
}): string {
  return `<div class="field field-wide"><label class="checkbox" for="${escapeHtml(input.id)}"><input id="${escapeHtml(input.id)}" name="${escapeHtml(input.name)}" type="checkbox" value="true" data-value-type="boolean"${input.checked ? ' checked' : ''}><span>${escapeHtml(input.label)}${input.hint === undefined ? '' : `<span class="field-hint">${escapeHtml(input.hint)}</span>`}</span></label></div>`;
}

export function renderHiddenField(input: {
  name: string;
  value: string | number | boolean;
  valueType?: ValueType;
}): string {
  return `<input type="hidden" name="${escapeHtml(input.name)}" value="${escapeHtml(input.value)}"${input.valueType === undefined ? '' : ` data-value-type="${input.valueType}"`}>`;
}

function fieldAttributes(input: FieldBase): string[] {
  const attributes = [`id="${escapeHtml(input.id)}"`, `name="${escapeHtml(input.name)}"`];
  if (input.required === true) attributes.push('required');
  if (input.valueType !== undefined) {
    attributes.push(`data-value-type="${input.valueType}"`);
  }
  return attributes;
}

function renderField(input: FieldBase, control: string): string {
  return `<div class="field${input.wide === true ? ' field-wide' : ''}"><label for="${escapeHtml(input.id)}">${escapeHtml(input.label)}</label>${control}${input.hint === undefined ? '' : `<span class="field-hint">${escapeHtml(input.hint)}</span>`}</div>`;
}
