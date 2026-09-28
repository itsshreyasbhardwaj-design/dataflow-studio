import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Row } from "@dataflow-studio/schema-registry";

export interface SandboxRequest {
  code: string;
  entrypoint: string;
  rows: Row[];
  timeoutSeconds: number;
  memoryLimitMb: number;
  networkAccess: boolean;
}

export interface SandboxResult {
  rows: Row[];
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class SandboxUnavailableError extends Error {
  readonly errorClass = "configuration";
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export class SandboxExecutionError extends Error {
  readonly errorClass = "validation";
  constructor(message: string, readonly stderr = "") {
    super(message);
    this.name = "SandboxExecutionError";
  }
}

/**
 * Provider interface for running user-authored Python.
 *
 * The engine never evaluates user code in its own process. It asks a provider,
 * and a deployment chooses one:
 *
 *  - `DisabledPythonSandbox` (default): refuses, with an explanation. A pipeline
 *    with a Python node fails validation-style rather than running unsafely.
 *  - `SubprocessPythonSandbox`: a local interpreter with a scrubbed environment,
 *    a temp working directory, no network by policy and a hard timeout. Suitable
 *    for a single-tenant deployment where the code authors are already trusted.
 *  - a remote provider (Firecracker, gVisor, Lambda, Trigger.dev task): the
 *    right answer for multi-tenant production, and the reason this is an
 *    interface rather than an implementation.
 */
export interface PythonSandbox {
  readonly name: string;
  readonly available: boolean;
  run(request: SandboxRequest): Promise<SandboxResult>;
}

export class DisabledPythonSandbox implements PythonSandbox {
  readonly name = "disabled";
  readonly available = false;

  async run(): Promise<SandboxResult> {
    throw new SandboxUnavailableError(
      "Python execution is disabled. Set PYTHON_SANDBOX=subprocess for a local single-tenant deployment, " +
      "or register a remote sandbox provider. DataFlow never evaluates user Python inside the API or worker process.",
    );
  }
}

/** Wraps the user's function so only JSON crosses the process boundary. */
const HARNESS = `
import json, sys, resource

def _limit(memory_mb):
    soft = memory_mb * 1024 * 1024
    for which in (resource.RLIMIT_AS, resource.RLIMIT_DATA):
        try:
            resource.setrlimit(which, (soft, soft))
        except (ValueError, OSError):
            pass
    try:
        resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    except (ValueError, OSError):
        pass
    try:
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
    except (ValueError, OSError):
        pass

def main():
    request = json.load(sys.stdin)
    _limit(request["memoryLimitMb"])
    namespace = {}
    exec(compile(request["code"], "<pipeline>", "exec"), namespace)
    entrypoint = namespace.get(request["entrypoint"])
    if not callable(entrypoint):
        raise SystemExit("Entrypoint '%s' is not defined" % request["entrypoint"])
    result = entrypoint(request["rows"])
    if result is None:
        result = []
    if not isinstance(result, list):
        raise SystemExit("Entrypoint must return a list of dictionaries")
    for index, row in enumerate(result):
        if not isinstance(row, dict):
            raise SystemExit("Row %d is %s, expected dict" % (index, type(row).__name__))
    sys.stdout.write("\\x00RESULT\\x00" + json.dumps(result, default=str))

main()
`;

const RESULT_MARKER = "\u0000RESULT\u0000";

export interface SubprocessSandboxOptions {
  interpreter?: string;
  maxOutputBytes?: number;
}

export class SubprocessPythonSandbox implements PythonSandbox {
  readonly name = "subprocess";
  readonly available = true;

  constructor(private readonly options: SubprocessSandboxOptions = {}) {}

  async run(request: SandboxRequest): Promise<SandboxResult> {
    const interpreter = this.options.interpreter ?? process.env["PYTHON_BIN"] ?? "python3";
    const maxOutputBytes = this.options.maxOutputBytes ?? 32 * 1024 * 1024;
    const startedAt = Date.now();
    const directory = await mkdtemp(join(tmpdir(), "dataflow-py-"));
    const harnessPath = join(directory, "harness.py");
    await writeFile(harnessPath, HARNESS, "utf8");

    try {
      return await new Promise<SandboxResult>((resolve, reject) => {
        const child = spawn(interpreter, ["-I", "-B", harnessPath], {
          cwd: directory,
          // A scrubbed environment: no credentials, no proxy settings, no PYTHONPATH.
          env: {
            PATH: "/usr/bin:/bin",
            HOME: directory,
            LC_ALL: "C.UTF-8",
            PYTHONDONTWRITEBYTECODE: "1",
            PYTHONHASHSEED: "0",
            ...(request.networkAccess ? {} : { no_proxy: "*", NO_PROXY: "*" }),
          },
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let killed = false;

        const timer = setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, request.timeoutSeconds * 1000);

        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (Buffer.byteLength(stdout) > maxOutputBytes) {
            killed = true;
            child.kill("SIGKILL");
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8").slice(0, 64 * 1024);
        });

        child.on("error", (error) => {
          clearTimeout(timer);
          reject(
            /ENOENT/.test(error.message)
              ? new SandboxUnavailableError(`Python interpreter "${interpreter}" was not found on this worker`)
              : error,
          );
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (killed) {
            reject(new SandboxExecutionError(`Python task exceeded its ${request.timeoutSeconds}s timeout or output limit`, stderr));
            return;
          }
          if (code !== 0) {
            reject(new SandboxExecutionError(`Python task exited with code ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`, stderr));
            return;
          }
          const markerIndex = stdout.lastIndexOf(RESULT_MARKER);
          if (markerIndex === -1) {
            reject(new SandboxExecutionError("Python task produced no result payload", stderr));
            return;
          }
          const logs = stdout.slice(0, markerIndex);
          try {
            const rows = JSON.parse(stdout.slice(markerIndex + RESULT_MARKER.length)) as Row[];
            resolve({ rows, stdout: logs, stderr, durationMs: Date.now() - startedAt });
          } catch (error) {
            reject(new SandboxExecutionError(`Python task returned invalid JSON: ${(error as Error).message}`, stderr));
          }
        });

        child.stdin.end(JSON.stringify({
          code: request.code,
          entrypoint: request.entrypoint,
          rows: request.rows,
          memoryLimitMb: request.memoryLimitMb,
        }));
      });
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function sandboxFromEnvironment(env: NodeJS.ProcessEnv = process.env): PythonSandbox {
  switch (env["PYTHON_SANDBOX"]) {
    case "subprocess":
      return new SubprocessPythonSandbox();
    case undefined:
    case "":
    case "disabled":
      return new DisabledPythonSandbox();
    default:
      throw new Error(`Unknown PYTHON_SANDBOX value "${env["PYTHON_SANDBOX"]}". Supported: disabled, subprocess.`);
  }
}
