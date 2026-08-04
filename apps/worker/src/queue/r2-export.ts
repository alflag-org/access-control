import type { ExportObjectWriter, StoredExportObject } from '@access-control/application';

export class R2ExportObjectWriter implements ExportObjectWriter {
  public constructor(private readonly bucket: R2Bucket) {}

  public async get(key: string): Promise<StoredExportObject | null> {
    const object = await this.bucket.get(key);
    if (object === null) return null;
    return {
      value: await object.text(),
      ...(object.customMetadata?.checksum === undefined
        ? {}
        : { checksum: object.customMetadata.checksum }),
    };
  }

  public putTemporaryIfAbsent(key: string, value: string, checksum: string): Promise<boolean> {
    return this.putIfAbsent(key, value, checksum);
  }

  public putFinalIfAbsent(key: string, value: string, checksum: string): Promise<boolean> {
    return this.putIfAbsent(key, value, checksum);
  }

  public async deleteTemporary(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  private async putIfAbsent(key: string, value: string, checksum: string): Promise<boolean> {
    const result = await this.bucket.put(key, value, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json; charset=UTF-8' },
      customMetadata: { checksum, schemaVersion: '1.0.0' },
    });
    return result !== null;
  }
}
