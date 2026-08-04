export interface ServiceRuntime {
  now(): string;
  id(prefix: string): string;
}

export const workerServiceRuntime: ServiceRuntime = {
  now: () => new Date().toISOString(),
  id: (prefix) => `${prefix}:${crypto.randomUUID()}`,
};
