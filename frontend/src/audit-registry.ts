export interface AuditTypeUIConfig {
  key: string;
  label: string;
  resourceNoun: string;
  buttonColor: string;
  badgeStyle: string;
  categoryLabels: Record<string, string>;
}

const AUDIT_UI_REGISTRY: Record<string, AuditTypeUIConfig> = {};

export function registerAuditUI(config: AuditTypeUIConfig) {
  AUDIT_UI_REGISTRY[config.key] = config;
}

export function getAuditUI(key: string): AuditTypeUIConfig | undefined {
  return AUDIT_UI_REGISTRY[key];
}

export function getAllAuditUIs(): AuditTypeUIConfig[] {
  return Object.values(AUDIT_UI_REGISTRY);
}

export function getAllCategoryLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const config of Object.values(AUDIT_UI_REGISTRY)) {
    Object.assign(labels, config.categoryLabels);
  }
  return labels;
}
