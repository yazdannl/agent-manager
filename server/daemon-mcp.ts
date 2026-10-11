import { readFile, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_LISTEN = "127.0.0.1:6767";
const PI_EXTENSION_PREFIX = "paseo-pi-extension-";
const PI_EXTENSION_FILE = "paseo-integration.mjs";
const CAPABILITY_TOKEN = /"Authorization"\s*:\s*"Bearer ([A-Za-z0-9-]{8,})"/;

/**
 * /mcp/agents is exempt from the global bearer middleware and accepts only the
 * per-run capability token or a plaintext daemon password. config.json stores
 * only the bcrypt hash, which cannot be presented as a credential, so we read
 * the capability token the daemon minted for this run. It is injected into every
 * live pi agent's generated extension file, and is only needed when an agent is
 * actually running, which is the only time a release is attempted. It is used
 * solely as a loopback bearer and is never logged.
 */
async function resolveCapabilityTokens(): Promise<string[]> {
  const override = process.env.PASEO_AGENT_MANAGER_MCP_TOKEN?.trim();
  if (override) {
    return [override];
  }
  const root = tmpdir();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PI_EXTENSION_PREFIX)) {
      continue;
    }
    const file = join(root, entry.name, PI_EXTENSION_FILE);
    try {
      const info = await stat(file);
      candidates.push({ file, mtime: info.mtimeMs });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const tokens: string[] = [];
  for (const candidate of candidates) {
    try {
      const match = CAPABILITY_TOKEN.exec(await readFile(candidate.file, "utf8"));
      const token = match?.[1];
      if (token && !tokens.includes(token)) {
        tokens.push(token);
      }
    } catch {
      continue;
    }
    if (tokens.length >= 3) {
      break;
    }
  }
  return tokens;
}

export function paseoHome(): string {
  const configured = process.env.PASEO_HOME?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), ".paseo");
}

export interface DaemonConfig { 
  listen: string | null;
  version: string | null;
  password: string | null;
}

export interface DaemonAddress {
  host: string;
  port: string;
}

export async function readDaemonConfig(): Promise<DaemonConfig> {
  try {
    const raw = await readFile(join(paseoHome(), "config.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      daemon?: { listen?: unknown; password?: unknown };
    };
    return {
      listen: trim(parsed.daemon?.listen),
      version: trim(parsed.version),
      password: trim(parsed.daemon?.password),
    };
  } catch {
    return { listen: null, version: null, password: null };
  }
}

export async function resolveDaemonAddress(): Promise<DaemonAddress | null> {
  const config = await readDaemonConfig();
  return normalizeListenAddress(config.listen ?? DEFAULT_LISTEN);
}

export async function resolveMcpEndpoint(): Promise<string> {
  const override = process.env.PASEO_AGENT_MANAGER_MCP_URL?.trim();
  if (override) {
    return override;
  }

  const address = await resolveDaemonAddress();
  if (!address) {
    throw new Error("Cannot reach the daemon over HTTP: daemon.listen is not a host:port");
  }
  return `http://${address.host}:${address.port}/mcp/agents`;
}

function trim(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeListenAddress(listen: string): DaemonAddress | null {
  if (listen.startsWith("/") || listen.startsWith(".")) {
    return null;
  }
  const withoutScheme = listen.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const [host, port] = withoutScheme.split(":");
  if (!host || !port || !/^\d+$/.test(port)) {
    return null;
  }
  const reachableHost =
    host === "0.0.0.0" || host === "::" || host === "[::]" || host === "::0" ? "127.0.0.1" : host;
  return { host: reachableHost, port };
}

export async function killAgentViaDaemonMcp(agentId: string): Promise<void> {
  const endpoint = await resolveMcpEndpoint();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "kill_agent", arguments: { agentId } },
  });
  let failure: string | null = null;
  for (const token of await resolveCapabilityTokens()) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      failure = describeHttpFailure(response.status, text);
      continue;
    }
    const payload = parseJsonRpcPayload(text);
    if (!payload) {
      throw new Error(`Unexpected daemon MCP response: ${text.slice(0, 200)}`);
    }
    const error = payload.error as { message?: unknown } | undefined;
    if (error) {
      throw new Error(typeof error.message === "string" ? error.message : "kill_agent failed");
    }
    const result = payload.result as { isError?: unknown; content?: unknown } | undefined;
    if (result?.isError === true) {
      throw new Error(readTextContent(result.content) ?? "kill_agent reported an error");
    }
    return;
  }
  throw new Error(
    failure ??
      "No agent capability token is available for the agent MCP endpoint, so the runtime cannot be released safely. Refusing to signal the process directly, which would leave the daemon holding a dead session.",
  );
}

function describeHttpFailure(status: number, body: string): string {
  if (status === 401) {
    return "The daemon rejected the agent MCP call (401): no live capability token matched this daemon run.";
  }
  if (status === 404) {
    return "The daemon MCP route is disabled (404). Enable daemon.mcp in the daemon config.";
  }
  return `Daemon MCP call failed (${status}): ${body.slice(0, 200)}`;
}

function parseJsonRpcPayload(text: string): { error?: unknown; result?: unknown } | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as { error?: unknown; result?: unknown };
    } catch {
      return null;
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const data = line.startsWith("data:") ? line.slice("data:".length).trim() : "";
    if (!data.startsWith("{")) {
      continue;
    }
    try {
      return JSON.parse(data) as { error?: unknown; result?: unknown };
    } catch {
      continue;
    }
  }
  return null;
}

function readTextContent(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? ((part as { text: string }).text ?? "")
        : "",
    )
    .filter((value) => value.length > 0);
  return parts.length > 0 ? parts.join("\n") : null;
}
