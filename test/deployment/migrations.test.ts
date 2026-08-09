import { describe, expect, it } from 'vitest';
import {
  assertAppliedMigrationsCompatible,
  migrationNamesFromD1Response,
} from '@access-control/deployment';

describe('deployment migration compatibility', () => {
  it('accepts migrations contained in the pinned source release', () => {
    const accepted = new Set(['0001_initial.sql', '0009_runtime_configuration_management.sql']);
    expect(() =>
      assertAppliedMigrationsCompatible(
        ['0001_initial.sql', '0009_runtime_configuration_management.sql'],
        accepted,
      ),
    ).not.toThrow();
  });

  it('blocks a rollback when the remote database contains an unknown migration', () => {
    expect(() =>
      assertAppliedMigrationsCompatible(
        ['0010_irreversible_change.sql'],
        new Set(['0001_initial.sql']),
      ),
    ).toThrow(/rollback is unsafe.*0010_irreversible_change\.sql/);
  });

  it('reads migration names from Wrangler JSON output', () => {
    expect(
      migrationNamesFromD1Response(
        JSON.stringify([
          {
            success: true,
            results: [{ name: '0001_initial.sql' }, { name: '0010_schema_change.sql' }],
          },
        ]),
      ),
    ).toEqual(['0001_initial.sql', '0010_schema_change.sql']);
  });

  it('rejects malformed Wrangler JSON output', () => {
    expect(() =>
      migrationNamesFromD1Response(JSON.stringify([{ success: false, results: [] }])),
    ).toThrow(/unsuccessful or malformed/);
  });
});
