import { escapeHtml } from '../formatting/html';

export interface TableColumn<Row> {
  label: string;
  render(row: Row): string;
}

export function renderTable<Row>(
  caption: string,
  columns: readonly TableColumn<Row>[],
  rows: readonly Row[],
): string {
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(caption)}">
    <table>
      <caption class="visually-hidden">${escapeHtml(caption)}</caption>
      <thead><tr>${columns.map((column) => `<th scope="col">${escapeHtml(column.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows
        .map(
          (row) => `<tr>${columns.map((column) => `<td>${column.render(row)}</td>`).join('')}</tr>`,
        )
        .join('')}</tbody>
    </table>
  </div>`;
}
