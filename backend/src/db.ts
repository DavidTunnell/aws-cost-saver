import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db: import("better-sqlite3").Database = new Database(path.join(DATA_DIR, "aws-cost-saver.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS aws_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    aws_account_id TEXT NOT NULL DEFAULT '',
    access_key_id_enc TEXT NOT NULL,
    secret_access_key_enc TEXT NOT NULL,
    default_region TEXT NOT NULL DEFAULT 'us-east-1',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'running',
    total_savings_monthly REAL NOT NULL DEFAULT 0,
    instance_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    instance_id TEXT NOT NULL,
    instance_name TEXT NOT NULL DEFAULT '',
    instance_type TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    current_monthly_cost REAL NOT NULL DEFAULT 0,
    estimated_savings REAL NOT NULL DEFAULT 0,
    action TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}'
  );
`);

// Migration: add audit_type column for multi-service support
try {
  db.exec(`ALTER TABLE audits ADD COLUMN audit_type TEXT NOT NULL DEFAULT 'ec2'`);
} catch (e: any) {
  // Column already exists — ignore
  if (!e.message.includes('duplicate column')) throw e;
}

export default db;
