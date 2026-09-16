-- 0004_retention.sql — configurable retention windows (Phase 7). Stored as a
-- per-team singleton; the cleanup job reads these to decide what to delete.
-- Defaults: continuous recordings 72h, derived clips 30d, audit 365d. A NULL
-- value means "keep indefinitely" (operator opt-out).

create table retention_settings (
  team_id uuid primary key references teams(id) on delete cascade,
  continuous_retention_hours int check (continuous_retention_hours is null or continuous_retention_hours > 0),
  derived_retention_days int check (derived_retention_days is null or derived_retention_days > 0),
  audit_retention_days int check (audit_retention_days is null or audit_retention_days > 0),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
