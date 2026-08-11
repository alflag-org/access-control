export const progressiveFormsScript = String.raw`
const forms = document.querySelectorAll('form[data-json-form]');
for (const form of forms) bindJsonForm(form);

for (const typeControl of document.querySelectorAll('select[name="authenticationType"]')) {
  const form = typeControl.form;
  const reference = form?.elements.namedItem('authenticationReference');
  if (!(reference instanceof HTMLInputElement)) continue;
  const synchronizeRequirement = () => {
    const required = String(typeControl.value).startsWith('cloudflare_');
    reference.required = required;
    reference.closest('.field')?.classList.toggle('field-required', required);
  };
  typeControl.addEventListener('change', synchronizeRequirement);
  synchronizeRequirement();
}

for (const providerControl of document.querySelectorAll('select[data-identity-provider]')) {
  const form = providerControl.form;
  const issuer = form?.elements.namedItem('issuer');
  if (!(issuer instanceof HTMLInputElement)) continue;
  let previousProvider = '';
  const synchronizeIssuer = () => {
    if (providerControl.value === 'github') {
      issuer.value = 'https://github.com';
      issuer.readOnly = true;
    } else {
      if (previousProvider === 'github' && issuer.value === 'https://github.com') issuer.value = '';
      issuer.readOnly = false;
    }
    previousProvider = providerControl.value;
  };
  providerControl.addEventListener('change', synchronizeIssuer);
  synchronizeIssuer();
}

function bindJsonForm(form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (form.dataset.confirmMessage && !window.confirm(form.dataset.confirmMessage)) return;
    const submitter = event.submitter instanceof HTMLButtonElement
      ? event.submitter
      : form.querySelector('button[type="submit"]');
    const result = form.querySelector('.form-result');
    if (submitter) submitter.disabled = true;
    if (result) { result.textContent = '保存中…'; result.dataset.status = 'pending'; }
    try {
      const data = formDataAsJson(form);
      if ('authenticationType' in data) {
        const reference = String(data.authenticationReference || '').trim();
        data.authentication = reference.length === 0
          ? { type: data.authenticationType }
          : { type: data.authenticationType, reference };
        delete data.authenticationType;
        delete data.authenticationReference;
      }
      const response = await fetch(form.action, {
        method: String(form.dataset.httpMethod || form.method).toUpperCase(),
        headers: { 'content-type': 'application/json', 'x-access-control-reason': 'administration_ui' },
        body: JSON.stringify(data),
      });
      const payload = await response.json();
      if (!response.ok) {
        const code = payload?.error?.code;
        throw new Error(errorMessage(code));
      }
      if (form.dataset.previewOutput) renderMappingPreview(form.dataset.previewOutput, payload?.data);
      if (result) {
        result.textContent = form.dataset.previewOutput ? '影響範囲を確認しました。' : '保存しました。';
        result.dataset.status = 'success';
      }
      if (form.dataset.reload !== 'false') window.setTimeout(() => window.location.reload(), 250);
    } catch (error) {
      if (result) {
        result.textContent = error instanceof Error ? error.message : '変更に失敗しました。';
        result.dataset.status = 'error';
        result.focus?.();
      }
    } finally {
      if (submitter) submitter.disabled = false;
    }
  });
}

function formDataAsJson(form) {
  const data = {};
  const processedMultipleFields = new Set();
  for (const [key, entry] of new FormData(form).entries()) {
    if (typeof entry !== 'string') continue;
    const control = form.elements.namedItem(key);
    const element = control instanceof HTMLElement ? control : null;
    if (element instanceof HTMLSelectElement && element.multiple) {
      if (!processedMultipleFields.has(key)) {
        data[key] = [...element.selectedOptions].map((option) => option.value);
        processedMultipleFields.add(key);
      }
      continue;
    }
    const value = entry.trim();
    if (value.length === 0) {
      if (element?.dataset.nullable === 'true') data[key] = null;
      continue;
    }
    switch (element?.dataset.valueType) {
      case 'number': {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error('数値入力を確認してください。');
        data[key] = number;
        break;
      }
      case 'boolean':
        data[key] = value === 'true';
        break;
      case 'datetime': {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) throw new Error('日時入力を確認してください。');
        data[key] = date.toISOString();
        break;
      }
      case 'json':
        try { data[key] = JSON.parse(value); }
        catch { throw new Error('JSON 入力を確認してください。'); }
        break;
      case 'string-list':
        data[key] = [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
        break;
      default:
        data[key] = value;
    }
  }
  for (const checkbox of form.querySelectorAll('input[type="checkbox"][data-value-type="boolean"]')) {
    if (checkbox.name) data[checkbox.name] = checkbox.checked;
  }
  return data;
}

function renderMappingPreview(targetId, preview) {
  const target = document.getElementById(targetId);
  if (!target || !preview || !Array.isArray(preview.affectedSubjectIds)) return;
  const summary = target.querySelector('[data-preview-summary]');
  const affected = target.querySelector('input[name="confirmedAffectedSubjectIds"]');
  const expectedRevision = target.querySelector('input[name="expectedRevision"]');
  if (summary) {
    summary.textContent = '対象 ' + preview.affectedSubjectIds.length + ' 件 · 権限 ' +
      preview.grantCountBefore + ' 件 → ' + preview.grantCountAfter + ' 件';
  }
  if (affected) affected.value = JSON.stringify(preview.affectedSubjectIds);
  if (expectedRevision) expectedRevision.value = String(preview.expectedRevision);
  target.hidden = false;
  target.focus();
}

function errorMessage(code) {
  const messages = {
    administrator_required: 'この変更には管理者ロールが必要です。',
    confirmation_required: '変更内容の確認が必要です。',
    final_active_admin_required: '最後の有効な管理者は停止または解除できません。',
    directory_managed_profile: 'このプロフィールは Google Directory から管理されています。Google Workspace 側で変更してください。',
    retired_subject_profile: '廃止済みの Subject は編集できません。',
    guest_profile_not_editable: '期限切れまたは廃止済みのゲストは編集できません。',
    role_forbidden: 'この操作を実行する権限がありません。',
    sole_administrator_self_change: '最後の管理者は自分自身の管理権限を解除できません。',
    revision_conflict: '他の変更が先に保存されました。画面を再読み込みして確認してください。',
  };
  return typeof code === 'string'
    ? (messages[code] || '変更は拒否されました（' + code + '）。')
    : '変更は拒否されました。';
}
`;
