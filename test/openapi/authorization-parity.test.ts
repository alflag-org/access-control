import { describe, expect, it } from 'vitest';
import { apiRoutes } from '../../apps/worker/src/api/route-contracts';
import { createOpenApiDocument } from '../../apps/worker/src/api/app';

describe('OpenAPI and runtime authorization parity', () => {
  it('generates every runtime contract with the same role metadata', () => {
    const document = createOpenApiDocument();
    const operationIds = new Set<string>();
    for (const contract of Object.values(apiRoutes)) {
      const definition = contract.definition as {
        method: 'get' | 'patch' | 'post';
        path: string;
        operationId: string;
      };
      const operation = document.paths?.[definition.path]?.[definition.method] as
        | {
            operationId?: string;
            'x-required-roles'?: unknown;
            responses?: Record<string, unknown>;
          }
        | undefined;
      expect(operation, `${definition.method} ${definition.path}`).toBeDefined();
      expect(operation?.operationId).toBe(definition.operationId);
      expect(operation?.['x-required-roles']).toEqual(contract.roles);
      expect(operationIds.has(definition.operationId)).toBe(false);
      operationIds.add(definition.operationId);
      if (definition.method !== 'get') {
        expect(operation?.responses).toEqual(
          expect.objectContaining({
            '400': expect.anything(),
            '409': expect.anything(),
            '422': expect.anything(),
          }),
        );
      }
    }
    expect(operationIds.size).toBe(Object.keys(apiRoutes).length);
    expect(document.openapi).toBe('3.1.0');
  });
});
