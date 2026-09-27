import type { NodeConfig } from "@dataflow-studio/workflow-engine";
import { DatasetConnector, FileConnector, GeneratorConnector, InlineConnector, type DatasetStore } from "./builtin.js";
import { HttpConnector } from "./http.js";
import { S3Connector } from "./s3.js";
import { MySqlDriver, PostgresDriver, SqlDatabaseConnector, type SqlDriver } from "./sql-database.js";
import type { EgressPolicy } from "./ssrf.js";
import { ConnectorError, type DataConnector, type FileStore } from "./types.js";

export interface ConnectorContext {
  organizationId: string;
  runId?: string;
  datasetStore?: DatasetStore;
  fileStore?: FileStore;
  egressPolicy?: EgressPolicy;
  /**
   * Overrides the driver used for relational connectors. Tests and the
   * zero-dependency demo mode inject an in-memory driver here.
   */
  sqlDrivers?: { postgres?: SqlDriver; mysql?: SqlDriver };
}

/**
 * Maps a node type to the connector that executes it. New connectors are added
 * here and in the node-type registry; nothing else changes.
 */
export class ConnectorRegistry {
  private readonly cache = new Map<string, DataConnector>();

  constructor(private readonly context: ConnectorContext) {}

  private remember(key: string, create: () => DataConnector): DataConnector {
    const existing = this.cache.get(key);
    if (existing) return existing;
    const connector = create();
    this.cache.set(key, connector);
    return connector;
  }

  forNodeType(type: string): DataConnector {
    switch (type) {
      case "inline.source":
        return this.remember(type, () => new InlineConnector());
      case "generator.source":
        return this.remember(type, () => new GeneratorConnector());
      case "dataset.destination": {
        const store = this.context.datasetStore;
        if (!store) throw new ConnectorError("Managed datasets are not configured on this deployment", "configuration");
        return this.remember(type, () => new DatasetConnector(store, this.context.organizationId, this.context.runId));
      }
      case "csv.source":
      case "json.source": {
        const store = this.context.fileStore;
        if (!store) throw new ConnectorError("File uploads are not configured on this deployment", "configuration");
        return this.remember(type, () => new FileConnector(store, this.context.organizationId, type === "csv.source" ? "csv" : "json"));
      }
      case "http.source":
      case "http.request":
      case "webhook.notify":
        return this.remember("http", () => new HttpConnector(this.context.egressPolicy ?? {}));
      case "s3.source":
      case "s3.destination":
        return this.remember("s3", () => new S3Connector(this.context.egressPolicy ?? {}));
      case "postgres.source":
      case "postgres.destination":
        return this.remember("postgres", () =>
          new SqlDatabaseConnector(this.context.sqlDrivers?.postgres ?? new PostgresDriver()));
      case "mysql.source":
      case "mysql.destination":
        return this.remember("mysql", () =>
          new SqlDatabaseConnector(this.context.sqlDrivers?.mysql ?? new MySqlDriver()));
      default:
        throw new ConnectorError(`No connector is registered for node type "${type}"`, "configuration");
    }
  }

  /** Probes a stored connection record. Used by the "Test connection" button. */
  async testConnection(family: string, config: NodeConfig): Promise<ReturnType<DataConnector["testConnection"]>> {
    const typeForFamily: Record<string, string> = {
      postgres: "postgres.source",
      mysql: "mysql.source",
      http: "http.source",
      s3: "s3.source",
      file: "csv.source",
      memory: "inline.source",
    };
    const type = typeForFamily[family];
    if (!type) throw new ConnectorError(`Unknown connector family "${family}"`, "configuration");
    return this.forNodeType(type).testConnection(config);
  }

  async close(): Promise<void> {
    for (const connector of this.cache.values()) {
      await connector.close?.().catch(() => undefined);
    }
    this.cache.clear();
  }
}
