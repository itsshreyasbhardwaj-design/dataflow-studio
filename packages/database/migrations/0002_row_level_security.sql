-- Optional defence in depth for Supabase-style deployments where the database is
-- reachable by the browser. The application always filters by organization_id;
-- these policies make the database enforce it too, using a session GUC that the
-- connection pool sets per request:
--
--   SET LOCAL dataflow.organization_id = 'org_123';
--
-- Apply this migration only when you run with a non-superuser application role.

CREATE OR REPLACE FUNCTION current_organization_id() RETURNS TEXT AS $$
  SELECT nullif(current_setting('dataflow.organization_id', true), '')
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'pipelines', 'pipeline_versions', 'pipeline_nodes', 'pipeline_edges',
    'workflow_runs', 'task_runs', 'task_attempts', 'task_logs', 'run_events',
    'schedules', 'backfills', 'connectors', 'connector_credentials',
    'datasets', 'dataset_rows', 'schema_versions', 'quality_checks',
    'quality_results', 'lineage_edges', 'incidents', 'audit_logs',
    'analytics_events', 'api_keys', 'uploaded_files', 'organization_members', 'teams'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (organization_id = current_organization_id()) WITH CHECK (organization_id = current_organization_id())',
      target || '_tenant_isolation', target
    );
  END LOOP;
END
$$;
