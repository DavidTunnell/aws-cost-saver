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

// Cost Trends
export interface CostDataPoint {
  month: string;
  cost: number;
  currency: string;
}

export interface AccountCostTrend {
  accountId: number;
  accountName: string;
  dataPoints: CostDataPoint[];
  error: string | null;
}

export interface CostTrendsResponse {
  months: number;
  service: string | null;
  accounts: AccountCostTrend[];
}

export const getCostTrends = (months: number = 12, service?: string) => {
  const params = new URLSearchParams({ months: String(months) });
  if (service) params.set("service", service);
  return request<CostTrendsResponse>(`/cost-trends?${params}`);
};

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
