export type SqlValue = ArrayBuffer | number | string | null;

export class D1Client {
  public constructor(protected readonly db: D1Database) {}

  protected statement(sql: string, ...params: SqlValue[]): D1PreparedStatement {
    return this.db.prepare(sql).bind(...params);
  }

  protected async first<Row>(sql: string, ...params: SqlValue[]): Promise<Row | null> {
    return this.statement(sql, ...params).first<Row>();
  }

  protected async all<Row>(sql: string, ...params: SqlValue[]): Promise<Row[]> {
    const result = await this.statement(sql, ...params).all<Row>();
    return result.results;
  }

  protected bumpGrantInputRevision(): D1PreparedStatement {
    return this.statement(
      "UPDATE grant_input_versions SET revision = revision + 1 WHERE name = 'effective_grants'",
    );
  }
}
