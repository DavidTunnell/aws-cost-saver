export interface AuditTypeConfig {
  key: string;
  label: string;
  resourceNoun: string;
  runner: (accountId: number, auditId: number) => Promise<void>;
}

const AUDIT_REGISTRY: Record<string, AuditTypeConfig> = {};

export function registerAuditType(config: AuditTypeConfig) {
  AUDIT_REGISTRY[config.key] = config;
}

export function getAuditType(key: string): AuditTypeConfig | undefined {
  return AUDIT_REGISTRY[key];
}

export function getRegisteredTypes(): string[] {
  return Object.keys(AUDIT_REGISTRY);
}
