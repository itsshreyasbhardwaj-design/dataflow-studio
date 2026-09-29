-- DataFlow Studio: initial schema.
--
-- Conventions
--   * every tenant-owned table carries organization_id and is indexed by it first,
--     so tenant isolation is also the primary access path;
--   * foreign keys cascade from organization down, so deleting a tenant is one
--     statement and cannot leave orphans;
--   * JSONB is used only for genuinely schemaless payloads (node config, run
--     params, evidence) - everything queried or sorted on is a real column.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- tenancy ---
CREATE TABLE organizations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  is_demo       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  email           TEXT,
  name            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members (user_id);

CREATE TABLE teams (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

-- -------------------------------------------------------------- pipelines ---
CREATE TABLE pipelines (
  id                    TEXT PRIMARY KEY,
  organization_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  description           TEXT,
  published_version_id  TEXT,
  latest_version_number INTEGER NOT NULL DEFAULT 0,
  tags                  TEXT[] NOT NULL DEFAULT '{}',
  is_demo               BOOLEAN NOT NULL DEFAULT FALSE,
  created_by            TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at           TIMESTAMPTZ
);
-- One live pipeline per name per tenant; archived rows are exempt.
CREATE UNIQUE INDEX pipelines_org_name_idx ON pipelines (organization_id, name) WHERE archived_at IS NULL;
CREATE INDEX pipelines_org_updated_idx ON pipelines (organization_id, updated_at DESC, id DESC);

CREATE TABLE pipeline_versions (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pipeline_id      TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  version          INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('draft', 'published', 'deprecated')),
  definition       JSONB NOT NULL,
  definition_hash  TEXT NOT NULL,
  change_summary   JSONB,
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at     TIMESTAMPTZ,
  deprecated_at    TIMESTAMPTZ,
  UNIQUE (pipeline_id, version)
);
CREATE INDEX pipeline_versions_pipeline_idx ON pipeline_versions (organization_id, pipeline_id, version DESC);
-- At most one published version per pipeline.
CREATE UNIQUE INDEX pipeline_versions_one_published_idx ON pipeline_versions (pipeline_id) WHERE status = 'published';

ALTER TABLE pipelines
  ADD CONSTRAINT pipelines_published_version_fk
  FOREIGN KEY (published_version_id) REFERENCES pipeline_versions(id) ON DELETE SET NULL;

-- Denormalized node and edge tables: the definition JSONB stays the source of
-- truth, these exist so lineage and impact queries can join in SQL.
CREATE TABLE pipeline_nodes (
  organization_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pipeline_version_id TEXT NOT NULL REFERENCES pipeline_versions(id) ON DELETE CASCADE,
  node_id             TEXT NOT NULL,
  node_type           TEXT NOT NULL,
  dataset             TEXT,
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (pipeline_version_id, node_id)
);
CREATE INDEX pipeline_nodes_type_idx ON pipeline_nodes (organization_id, node_type);
CREATE INDEX pipeline_nodes_dataset_idx ON pipeline_nodes (organization_id, dataset) WHERE dataset IS NOT NULL;

CREATE TABLE pipeline_edges (
  organization_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pipeline_version_id TEXT NOT NULL REFERENCES pipeline_versions(id) ON DELETE CASCADE,
  from_node           TEXT NOT NULL,
  to_node             TEXT NOT NULL,
  port                TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (pipeline_version_id, from_node, to_node, port)
);

-- ------------------------------------------------------------------- runs ---
CREATE TABLE workflow_runs (
  id                         TEXT PRIMARY KEY,
  organization_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pipeline_id                TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  pipeline_version_id        TEXT NOT NULL REFERENCES pipeline_versions(id) ON DELETE RESTRICT,
  pipeline_name              TEXT NOT NULL,
  version                    INTEGER NOT NULL,
  state                      TEXT NOT NULL CHECK (state IN ('PENDING','QUEUED','RUNNING','SUCCESS','FAILED','CANCELLED')),
  trigger                    TEXT NOT NULL,
  triggered_by               TEXT NOT NULL,
  params                     JSONB,
  logical_date               TIMESTAMPTZ,
  queued_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at                 TIMESTAMPTZ,
  finished_at                TIMESTAMPTZ,
  duration_ms                BIGINT,
  error                      TEXT,
  cancellation_requested_at  TIMESTAMPTZ,
  cancellation_requested_by  TEXT,
  backfill_id                TEXT,
  schedule_id                TEXT,
  retry_of_run_id            TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  request_id                 TEXT,
  is_demo                    BOOLEAN NOT NULL DEFAULT FALSE,
  totals                     JSONB
);
CREATE INDEX workflow_runs_org_queued_idx ON workflow_runs (organization_id, queued_at DESC, id DESC);
CREATE INDEX workflow_runs_pipeline_idx ON workflow_runs (organization_id, pipeline_id, queued_at DESC);
CREATE INDEX workflow_runs_state_idx ON workflow_runs (organization_id, state) WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX workflow_runs_backfill_idx ON workflow_runs (backfill_id) WHERE backfill_id IS NOT NULL;
CREATE INDEX workflow_runs_schedule_idx ON workflow_runs (schedule_id, queued_at DESC) WHERE schedule_id IS NOT NULL;
-- A schedule fires at most once per logical date, enforced by the database.
CREATE UNIQUE INDEX workflow_runs_schedule_logical_idx
  ON workflow_runs (schedule_id, logical_date)
  WHERE schedule_id IS NOT NULL AND logical_date IS NOT NULL;

CREATE TABLE task_runs (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id           TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  pipeline_id      TEXT NOT NULL,
  node_id          TEXT NOT NULL,
  node_type        TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('PENDING','QUEUED','RUNNING','SUCCESS','FAILED','CANCELLED','SKIPPED','RETRYING','BLOCKED')),
  attempt          INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 1,
  scheduled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  duration_ms      BIGINT,
  worker_id        TEXT,
  lease_expires_at TIMESTAMPTZ,
  error            TEXT,
  error_class      TEXT,
  output           JSONB,
  depends_on       TEXT[] NOT NULL DEFAULT '{}',
  priority         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (run_id, node_id)
);
-- The claim query: ready tasks ordered by priority then age.
CREATE INDEX task_runs_claimable_idx
  ON task_runs (priority DESC, scheduled_at ASC, id ASC)
  WHERE state IN ('QUEUED','RETRYING');
CREATE INDEX task_runs_lease_idx ON task_runs (lease_expires_at) WHERE state = 'RUNNING';
CREATE INDEX task_runs_run_idx ON task_runs (organization_id, run_id);
CREATE INDEX task_runs_failures_idx ON task_runs (organization_id, node_id) WHERE state = 'FAILED';

CREATE TABLE task_attempts (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_run_id     TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  attempt         INTEGER NOT NULL,
  state           TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ,
  duration_ms     BIGINT,
  worker_id       TEXT,
  error           TEXT,
  error_class     TEXT,
  output          JSONB,
  UNIQUE (task_run_id, attempt)
);
CREATE INDEX task_attempts_run_idx ON task_attempts (organization_id, run_id);

CREATE TABLE task_logs (
  id              BIGSERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  task_run_id     TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  attempt         INTEGER NOT NULL,
  ts              TIMESTAMPTZ NOT NULL,
  level           TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  message         TEXT NOT NULL,
  fields          JSONB
);
CREATE INDEX task_logs_run_idx ON task_logs (organization_id, run_id, ts ASC, id ASC);
CREATE INDEX task_logs_task_idx ON task_logs (task_run_id, attempt, ts ASC);
CREATE INDEX task_logs_search_idx ON task_logs USING gin (to_tsvector('english', message));

CREATE TABLE run_events (
  id              BIGSERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  sequence        BIGINT NOT NULL,
  type            TEXT NOT NULL,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);
CREATE INDEX run_events_run_idx ON run_events (organization_id, run_id, sequence ASC);

-- -------------------------------------------------------------- scheduling ---
CREATE TABLE schedules (
  id                  TEXT PRIMARY KEY,
  organization_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pipeline_id         TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  pipeline_version_id TEXT REFERENCES pipeline_versions(id) ON DELETE SET NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('cron','interval')),
  cron                TEXT,
  interval_seconds    INTEGER,
  timezone            TEXT NOT NULL DEFAULT 'UTC',
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  catchup             BOOLEAN NOT NULL DEFAULT FALSE,
  next_run_at         TIMESTAMPTZ NOT NULL,
  last_run_at         TIMESTAMPTZ,
  last_run_id         TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  created_by          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'cron' AND cron IS NOT NULL) OR (kind = 'interval' AND interval_seconds IS NOT NULL))
);
CREATE INDEX schedules_due_idx ON schedules (next_run_at ASC) WHERE enabled;
CREATE INDEX schedules_pipeline_idx ON schedules (organization_id, pipeline_id);

CREATE TABLE backfills (
  id                  TEXT PRIMARY KEY,
  organization_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pipeline_id         TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  pipeline_version_id TEXT NOT NULL REFERENCES pipeline_versions(id) ON DELETE RESTRICT,
  range_from          TIMESTAMPTZ NOT NULL,
  range_to            TIMESTAMPTZ NOT NULL,
  interval_seconds    INTEGER NOT NULL,
  concurrency         INTEGER NOT NULL DEFAULT 1,
  state               TEXT NOT NULL CHECK (state IN ('pending','running','paused','completed','cancelled','failed')),
  total_runs          INTEGER NOT NULL,
  completed_runs      INTEGER NOT NULL DEFAULT 0,
  failed_runs         INTEGER NOT NULL DEFAULT 0,
  pending_dates       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  CHECK (range_to >= range_from)
);
CREATE INDEX backfills_active_idx ON backfills (state) WHERE state IN ('pending','running');
CREATE INDEX backfills_pipeline_idx ON backfills (organization_id, pipeline_id, created_at DESC);

-- -------------------------------------------------- connectors and secrets ---
CREATE TABLE connectors (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  family            TEXT NOT NULL,
  config            JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_refs       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_tested_at    TIMESTAMPTZ,
  last_test_ok      BOOLEAN,
  last_test_message TEXT,
  UNIQUE (organization_id, name)
);

-- Credentials are stored encrypted; the plaintext never touches this table.
CREATE TABLE connector_credentials (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  backend         TEXT NOT NULL CHECK (backend IN ('managed','environment','external')),
  ciphertext      TEXT,
  external_uri    TEXT,
  fingerprint     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  PRIMARY KEY (organization_id, name),
  CHECK (backend <> 'managed' OR ciphertext IS NOT NULL)
);

-- --------------------------------------------------- datasets and schemas ---
CREATE TABLE datasets (
  id                    TEXT PRIMARY KEY,
  organization_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  description           TEXT,
  owner                 TEXT,
  source_type           TEXT,
  latest_schema_version INTEGER,
  row_count             BIGINT,
  preview_rows          JSONB,
  preview_columns       JSONB,
  last_updated_at       TIMESTAMPTZ,
  last_run_id           TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  quality_status        TEXT,
  is_demo               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE dataset_rows (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dataset         TEXT NOT NULL,
  rows            JSONB NOT NULL,
  columns         JSONB NOT NULL,
  row_count       BIGINT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, dataset)
);

CREATE TABLE schema_versions (
  organization_id    TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dataset            TEXT NOT NULL,
  version            INTEGER NOT NULL,
  columns            JSONB NOT NULL,
  fingerprint        TEXT NOT NULL,
  observed_in_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, dataset, version)
);

-- ---------------------------------------------------------- data quality ---
CREATE TABLE quality_checks (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dataset         TEXT NOT NULL,
  check_id        TEXT NOT NULL,
  check_type      TEXT NOT NULL,
  definition      JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, dataset, check_id)
);

CREATE TABLE quality_results (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  task_run_id     TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  pipeline_id     TEXT NOT NULL,
  dataset         TEXT,
  check_id        TEXT NOT NULL,
  check_type      TEXT NOT NULL,
  column_name     TEXT,
  status          TEXT NOT NULL CHECK (status IN ('PASSED','FAILED','ERRORED')),
  severity        TEXT NOT NULL CHECK (severity IN ('error','warn')),
  expected        TEXT NOT NULL,
  actual          TEXT NOT NULL,
  passed_rows     BIGINT NOT NULL DEFAULT 0,
  failed_rows     BIGINT NOT NULL DEFAULT 0,
  total_rows      BIGINT NOT NULL DEFAULT 0,
  pass_rate       DOUBLE PRECISION NOT NULL DEFAULT 0,
  failed_samples  JSONB,
  message         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX quality_results_run_idx ON quality_results (organization_id, run_id);
CREATE INDEX quality_results_dataset_idx ON quality_results (organization_id, dataset, created_at DESC);
CREATE INDEX quality_results_failures_idx ON quality_results (organization_id, created_at DESC) WHERE status <> 'PASSED';

-- ---------------------------------------------------------------- lineage ---
CREATE TABLE lineage_edges (
  id                  TEXT PRIMARY KEY,
  organization_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pipeline_id         TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  pipeline_version_id TEXT NOT NULL REFERENCES pipeline_versions(id) ON DELETE CASCADE,
  from_type           TEXT NOT NULL CHECK (from_type IN ('dataset','node')),
  from_id             TEXT NOT NULL,
  to_type             TEXT NOT NULL CHECK (to_type IN ('dataset','node')),
  to_id               TEXT NOT NULL,
  node_id             TEXT,
  transformation      TEXT,
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pipeline_version_id, from_type, from_id, to_type, to_id)
);
CREATE INDEX lineage_from_idx ON lineage_edges (organization_id, from_type, from_id);
CREATE INDEX lineage_to_idx ON lineage_edges (organization_id, to_type, to_id);

-- -------------------------------------------------------------- incidents ---
CREATE TABLE incidents (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  severity         TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  title            TEXT NOT NULL,
  evidence         JSONB NOT NULL,
  pipeline_id      TEXT REFERENCES pipelines(id) ON DELETE CASCADE,
  run_id           TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  dataset          TEXT,
  status           TEXT NOT NULL CHECK (status IN ('open','acknowledged','resolved')),
  fingerprint      TEXT NOT NULL,
  occurrences      INTEGER NOT NULL DEFAULT 1,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by  TEXT,
  resolved_at      TIMESTAMPTZ
);
-- One open incident per condition; a repeat bumps occurrences instead of spamming.
CREATE UNIQUE INDEX incidents_open_fingerprint_idx
  ON incidents (organization_id, fingerprint) WHERE status <> 'resolved';
CREATE INDEX incidents_org_seen_idx ON incidents (organization_id, last_seen_at DESC, id DESC);

-- ------------------------------------------------------------------ audit ---
CREATE TABLE audit_logs (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor           TEXT NOT NULL,
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('user','api_key','system','schedule')),
  action          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT,
  result          TEXT NOT NULL CHECK (result IN ('success','denied','error')),
  request_id      TEXT,
  ip              TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_created_idx ON audit_logs (organization_id, created_at DESC, id DESC);
CREATE INDEX audit_logs_resource_idx ON audit_logs (organization_id, resource_type, resource_id);

CREATE TABLE analytics_events (
  id              BIGSERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  properties      JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX analytics_events_org_idx ON analytics_events (organization_id, name, created_at DESC);

-- --------------------------------------------------------------- api keys ---
CREATE TABLE api_keys (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  prefix          TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('owner','admin','developer','viewer')),
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX api_keys_org_idx ON api_keys (organization_id);

CREATE TABLE uploaded_files (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  content_type    TEXT,
  bytes           BIGINT NOT NULL,
  content         BYTEA NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX uploaded_files_org_idx ON uploaded_files (organization_id, created_at DESC);

-- --------------------------------------------------------------- metadata ---
-- `schema_migrations` is deliberately NOT created here. The migration runner has
-- to read it before it can decide whether this file has already been applied, so
-- the runner creates it itself (CREATE TABLE IF NOT EXISTS) before the first
-- migration runs. Declaring it again here would abort this file with 42P07 on
-- every fresh database.

-- Intermediate batches passed between tasks of one run. Kept small by the
-- executor's byte cap: large results belong in a destination, not the control
-- plane. Rows are deleted when the run finishes.
CREATE TABLE task_data (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id         TEXT NOT NULL,
  batch           JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, run_id, node_id)
);
