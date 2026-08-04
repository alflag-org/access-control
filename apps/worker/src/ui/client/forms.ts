export const progressiveFormsScript = String.raw`
const forms = document.querySelectorAll('form[data-json-form]');
for (const form of forms) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitter = form.querySelector('button[type="submit"]');
    const result = form.querySelector('.form-result');
    if (submitter) submitter.disabled = true;
    if (result) { result.textContent = '保存中…'; result.dataset.status = 'pending'; }
    try {
      const data = Object.fromEntries(new FormData(form).entries());
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string' && value.trim().length === 0) delete data[key];
      }
      if ('authenticationType' in data) {
        const reference = String(data.authenticationReference || '').trim();
        data.authentication = reference.length === 0
          ? { type: data.authenticationType }
          : { type: data.authenticationType, reference };
        delete data.authenticationType;
        delete data.authenticationReference;
      }
      const response = await fetch(form.action, {
        method: form.method.toUpperCase(),
        headers: { 'content-type': 'application/json', 'x-access-control-reason': 'administration_ui' },
        body: JSON.stringify(data),
      });
      const payload = await response.json();
      if (!response.ok) {
        const code = payload?.error?.code;
        throw new Error(typeof code === 'string' ? '変更は拒否されました（' + code + '）。' : '変更は拒否されました。');
      }
      if (result) { result.textContent = '保存しました。'; result.dataset.status = 'success'; }
      window.setTimeout(() => window.location.reload(), 250);
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
`;
