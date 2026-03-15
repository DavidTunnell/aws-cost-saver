const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// Accounts
export interface Account {
  id: number;
  name: string;
  aws_account_id: string;
  default_region: string;
  created_at: string;
}

export const getAccounts = () => request<Account[]>("/accounts");

export const createAccount = (data: {
  name: string;
  access_key_id: string;
  secret_access_key: string;
  default_region?: string;
}) => request<{ id: number }>("/accounts", { method: "POST", body: JSON.stringify(data) });

export const updateAccount = (id: number, data: Partial<{
  name: string;
  access_key_id: string;
  secret_access_key: string;
  default_region: string;
}>) => request<{ success: boolean }>(`/accounts/${id}`, { method: "PUT", body: JSON.stringify(data) });

export const deleteAccount = (id: number) =>
  request<{ success: boolean }>(`/accounts/${id}`, { method: "DELETE" });

export const testConnection = (id: number) =>
  request<{ success: boolean; account_id: string; arn: string }>(
    `/accounts/${id}/test`,
    { method: "POST" }
  );

// Audits
export interface Audit {
  id: number;
  account_id: number;
  account_name: string;
  status: string;
  audit_type: string;
  total_savings_monthly: number;
  instance_count: number;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

export interface Recommendation {
  id: number;
  audit_id: number;
  instance_id: string;
  instance_name: string;
  instance_type: string;
  category: string;
  severity: string;
  current_monthly_cost: number;
  estimated_savings: number;
  action: string;
  details: string;
  resolution: "fixed" | "incorrect" | null;
  resolution_reason: string | null;
  resolved_at: string | null;
}

export interface ChildAudit {
  id: number;
  audit_type: string;
  status: string;
  error: string | null;
  label: string;
}

export interface AuditDetail extends Audit {
  recommendations: Recommendation[];
  child_audits?: ChildAudit[];
}

export const getAudits = () => request<Audit[]>("/audits");

export const getAudit = (id: number) => request<AuditDetail>(`/audits/${id}`);

export const startAudit = (accountId: number, auditType: string = 'ec2') =>
  request<{ id: number; status: string }>("/audits", {
    method: "POST",
    body: JSON.stringify({ account_id: accountId, audit_type: auditType }),
  });

// Reports
export interface CostPeriod {
  start: string;
  end: string;
  totalCost: number;
  byService: Record<string, number>;
}

export interface CostTrendData {
  accountId: number;
  accountName: string;
  awsAccountId: string;
  granularity: "MONTHLY" | "DAILY";
  months: number;
  periods: CostPeriod[];
}

export interface ServiceInfo {
  name: string;
  totalCost: number;
}

export const getCostTrends = (
  accountId: number,
  months?: number,
  granularity?: "MONTHLY" | "DAILY",
  services?: string[]
) => {
  const params = new URLSearchParams({ accountId: String(accountId) });
  if (months) params.set("months", String(months));
  if (granularity) params.set("granularity", granularity);
  if (services?.length) params.set("services", services.join(","));
  return request<CostTrendData>(`/reports/cost-trends?${params}`);
};

export const getAccountServices = (accountId: number) =>
  request<{ services: ServiceInfo[] }>(`/reports/services?accountId=${accountId}`);

// Solutions
export interface SolutionsData {
  console: string;
  cli: string;
}

export const getSolutions = (data: {
  category: string;
  action: string;
  instanceId: string;
  instanceType: string;
  metadata: Record<string, string>;
}) =>
  request<SolutionsData>("/solutions/generate", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const executeSolutions = (commands: string, accountId: number) =>
  request<{ success: boolean; output: string }>("/solutions/execute", {
    method: "POST",
    body: JSON.stringify({ commands, accountId }),
  });

export const resolveRecommendation = (
  auditId: number,
  recId: number,
  resolution: "fixed" | "incorrect" | null,
  reason?: string
) =>
  request<Recommendation>(`/audits/${auditId}/recommendations/${recId}`, {
    method: "PATCH",
    body: JSON.stringify({ resolution, reason }),
  });
