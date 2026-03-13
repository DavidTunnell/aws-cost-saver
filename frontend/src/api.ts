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
}

export interface AuditDetail extends Audit {
  recommendations: Recommendation[];
}

export const getAudits = () => request<Audit[]>("/audits");

export const getAudit = (id: number) => request<AuditDetail>(`/audits/${id}`);

export const startAudit = (accountId: number, auditType: string = 'ec2') =>
  request<{ id: number; status: string }>("/audits", {
    method: "POST",
    body: JSON.stringify({ account_id: accountId, audit_type: auditType }),
  });
