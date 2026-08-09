import { z } from 'zod';
import { runtimeConfigurationManifestSchema } from '@access-control/config';
import { deploymentManifestSchema, releaseManifestSchema } from './schema';

export function deploymentJsonSchemas(): Record<string, object> {
  return {
    'release.schema.json': schemaDocument(
      releaseManifestSchema,
      'https://access-control.example/schemas/release.schema.json',
      'Access Control release pin',
    ),
    'deployment.schema.json': schemaDocument(
      deploymentManifestSchema,
      'https://access-control.example/schemas/deployment.schema.json',
      'Access Control deployment configuration',
    ),
    'runtime.schema.json': schemaDocument(
      runtimeConfigurationManifestSchema,
      'https://access-control.example/schemas/runtime.schema.json',
      'Access Control runtime desired state',
    ),
  };
}

function schemaDocument(schema: z.ZodType, id: string, title: string): object {
  return {
    ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }),
    $id: id,
    title,
  };
}
