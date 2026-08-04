import { spawnSync } from 'node:child_process';

export interface D1CommandTarget {
  database: string;
  environment: 'development' | 'staging' | 'production';
}

export function executeD1Sql(target: D1CommandTarget, sql: string): unknown {
  const arguments_ = [
    'exec',
    'wrangler',
    'd1',
    'execute',
    target.database,
    '--config',
    'apps/worker/wrangler.jsonc',
    '--command',
    sql,
    '--json',
  ];
  if (target.environment === 'development') {
    arguments_.push('--local');
  } else {
    arguments_.push('--remote');
  }
  const result = spawnSync('pnpm', arguments_, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `Wrangler D1 command failed with status ${result.status ?? 'unknown'}: ${result.stderr.trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error('Wrangler returned an invalid JSON response for the D1 command.');
  }
}

export function queryD1Rows(target: D1CommandTarget, sql: string): Array<Record<string, unknown>> {
  const output = executeD1Sql(target, sql);
  if (!Array.isArray(output)) throw new Error('Wrangler D1 response must be an array.');
  const rows: Array<Record<string, unknown>> = [];
  for (const result of output) {
    if (typeof result !== 'object' || result === null) continue;
    const candidate = (result as { results?: unknown }).results;
    if (!Array.isArray(candidate)) continue;
    for (const row of candidate) {
      if (typeof row === 'object' && row !== null) rows.push(row as Record<string, unknown>);
    }
  }
  return rows;
}

export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
