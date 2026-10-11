import { createRequire } from "node:module";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { paseoHome, readDaemonConfig, resolveDaemonAddress } from "./daemon-mcp";
import { describe } from "./util";

declare const require: ((specifier: string) => unknown) | undefined;

const CLIENT_MODULE = "@getpaseo/client/internal/daemon-client";
const CLIENT_ID_PREFIX = "agent-manager-";
const DEFAULT_IDLE_CLOSE_MS = 180000;
const LOCAL_CREDENTIAL_FILE = "local-credential";
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$/;

/**
 * This daemon has a password set, and config.json only stores its bcrypt hash,
 * which cannot be presented as a credential. The daemon instead authenticates
 * local clients with the base64url token in ~/.paseo/local-credential, the same
 * file the Paseo CLI uses; session-admission-auth.js accepts it as
 * { kind: "localCredential" } and chooseConnectionAuth prefers it over a password.
 * The token is read at connect time and only ever sent to the loopback daemon.
 */
async function readLocalCredentialToken(): Promise<string | undefined> {
  try {
    const token = (await readFile(join(paseoHome(), LOCAL_CREDENTIAL_FILE), "utf8")).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export interface WorkspaceRecoveryState {
  kind: string;
  action?: string;
  reason?: string;
  message?: string;
  workspaceName?: string;
  branch?: string | null;
}

export interface ObservedAgentEntry {
  agent?: unknown;
}

export interface OwnedAgentSubscription {
  readonly ready: Promise<{ entries?: ObservedAgentEntry[] }>;
  subscribe(observer: {
    snapshot: (snapshot: { entries?: ObservedAgentEntry[] }) => void;
    update: (message: unknown) => void;
    error?: (error: unknown) => void;
  }): () => void;
  release(): Promise<void>;
}

export interface DaemonSessionClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  fetchAgents(options?: {
    filter?: { includeArchived?: boolean };
    page?: { limit?: number; cursor?: string };
  }): Promise<{ entries?: unknown }>;
  observeAgents(options?: { filter?: { includeArchived?: boolean } }): Promise<OwnedAgentSubscription>;
  restoreWorkspace(workspaceId: string, requestId?: string): Promise<void>;
  setWorkspaceTitle(
    workspaceId: string,
    title: string | null,
    requestId?: string,
  ): Promise<{ title: string | null }>;
  inspectWorkspaceRecovery(workspaceId: string, requestId?: string): Promise<WorkspaceRecoveryState>;
  refreshAgent(agentId: string, requestId?: string): Promise<unknown>;
  closeItems(input: { agentIds: string[]; terminalIds: string[] }): Promise<unknown>;
  getDaemonStatus(options?: unknown): Promise<{ serverId?: unknown }>;
  listTerminals(
    cwd?: string,
    requestId?: string,
    options?: { workspaceId?: string },
  ): Promise<{ terminals?: Array<Record<string, unknown>> }>;
  killTerminal(terminalId: string, requestId?: string): Promise<unknown>;
}

let cachedServerId: string | null = null;

export async function resolveServerId(): Promise<string | null> {
  if (cachedServerId) {
    return cachedServerId;
  }
  try {
    const client = await getDaemonClient();
    const status = await client.getDaemonStatus();
    const serverId = typeof status?.serverId === "string" ? status.serverId.trim() : "";
    if (serverId) {
      cachedServerId = serverId;
      return serverId;
    }
  } catch {
    return null;
  }
  return null;
}

interface DaemonClientConstructor {
  new (config: Record<string, unknown>): DaemonSessionClient;
}

let pendingClient: Promise<DaemonSessionClient> | null = null;
let activeUses = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let held = false;

export function holdDaemonClient(hold: boolean): void {
  held = hold;
  if (hold) {
    cancelIdleClose();
    return;
  }
  if (activeUses === 0) {
    scheduleIdleClose();
  }
}

export function beginDaemonClientUse(): void {
  activeUses += 1;
  cancelIdleClose();
}

export function endDaemonClientUse(): void {
  activeUses = Math.max(0, activeUses - 1);
  if (activeUses > 0) {
    return;
  }
  cancelIdleClose();
  scheduleIdleClose();
}

function scheduleIdleClose(): void {
  if (held) {
    return;
  }
  const timeout = idleCloseMs();
  if (timeout <= 0) {
    return;
  }
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (activeUses === 0 && !held) {
      void disposeDaemonClient();
    }
  }, timeout);
}

function cancelIdleClose(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function idleCloseMs(): number {
  const raw = process.env.PASEO_AGENT_MANAGER_CLIENT_IDLE_MS;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_IDLE_CLOSE_MS;
  }
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_IDLE_CLOSE_MS;
}

export async function getDaemonClient(): Promise<DaemonSessionClient> {
  if (!pendingClient) {
    pendingClient = createDaemonClient();
  }
  try {
    return await pendingClient;
  } catch (error) {
    pendingClient = null;
    throw error;
  }
}

export async function disposeDaemonClient(): Promise<void> {
  cancelIdleClose();
  const pending = pendingClient;  pendingClient = null;
  if (!pending) {
    return;
  }
  try {
    const client = await pending;
    await client.close();
  } catch {
    return;
  }
}

async function createDaemonClient(): Promise<DaemonSessionClient> {
  const address = await resolveDaemonAddress();
  if (!address) {
    throw new Error(
      "The daemon websocket address is unavailable. Set daemon.listen to a host:port value in the Paseo config.",
    );
  }
  const DaemonClient = loadDaemonClientConstructor();
  const config = await readDaemonConfig();
  const configured = process.env.PASEO_PASSWORD?.trim() || config.password;
  // A stored bcrypt hash is not a credential; only offer it when it is plaintext.
  const password = configured && !BCRYPT_HASH.test(configured) ? configured : undefined;
  const localCredential = await readLocalCredentialToken();
  const client = new DaemonClient({
    url: `ws://${address.host}:${address.port}/ws`,
    clientId: `${CLIENT_ID_PREFIX}${randomSuffix()}`,
    clientType: "cli",
    appVersion: config.version ?? undefined,
    ...(localCredential ? { localCredential: () => localCredential } : {}),
    ...(password ? { password } : {}),
    connectTimeoutMs: 15000,
    reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 8000 },
  });
  await client.connect();
  return client;
}

function loadDaemonClientConstructor(): DaemonClientConstructor {
  const failure: string[] = [];
  const entry = process.argv[1];
  if (entry) {
    try {
      const required = createRequire(entry)(CLIENT_MODULE) as { DaemonClient?: unknown };
      const constructor = required?.DaemonClient;
      if (typeof constructor === "function") {
        return constructor as DaemonClientConstructor;
      }
      failure.push("the module has no DaemonClient export");
    } catch (error) {
      failure.push(describe(error));
    }
  }
  try {
    const constructor = runtimeRequire(CLIENT_MODULE) as { DaemonClient?: unknown } | undefined;
    if (constructor && typeof constructor.DaemonClient === "function") {
      return constructor.DaemonClient as DaemonClientConstructor;
    }
    failure.push("the runtime copy has no DaemonClient export");
  } catch (error) {
    failure.push(describe(error));
  }
  throw new Error(`Cannot reach the daemon session protocol: ${failure.join("; ")}`);
}

function runtimeRequire(specifier: string): unknown {
  if (typeof require !== "function") {
    throw new Error("The plugin runtime require is unavailable");
  }
  return require(specifier);
}

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
