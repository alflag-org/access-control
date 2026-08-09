import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploymentJsonSchemas } from '@access-control/deployment';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const schemaDirectory = resolve(repositoryRoot, 'deployment/schemas');
const check = process.argv.includes('--check');

await mkdir(schemaDirectory, { recursive: true });
for (const [file, schema] of Object.entries(deploymentJsonSchemas())) {
  const path = resolve(schemaDirectory, file);
  const expected = `${JSON.stringify(schema, null, 2)}\n`;
  if (check) {
    let actual: string;
    try {
      actual = await readFile(path, 'utf8');
    } catch (error) {
      throw new Error(`Generated schema ${file} is missing.`, { cause: error });
    }
    if (actual !== expected) throw new Error(`Generated schema ${file} is stale.`);
  } else {
    await writeFile(path, expected, 'utf8');
  }
}

process.stdout.write(`${check ? 'Verified' : 'Generated'} deployment JSON schemas.\n`);
