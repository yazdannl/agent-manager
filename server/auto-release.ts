import { join } from "node:path";

import { readFile, readdir } from "node:fs/promises";

import { listAllAgents, type AgentRecord } from "./agents";
import {
  beginDaemonClientUse,
  endDaemonClientUse,
  getDaemonClient,
  holdDaemonClient,
  type DaemonSessionClient,
  type OwnedAgentSubscription,
} from "./daemon-client";
import { paseoHome } from "./daemon-mcp";
import { releaseAgents } from "./actions";
import type { AutoReleasePatch, AutoReleaseSnapshot } from "../shared/contracts";
import { closeIdleTerminals, terminalApiFromClient } from "./terminals";
import { fireAndForget } from "./guard";
import { scanAgentProcesses, scanAgentProcessesFresh } from "./processes";
import { describe, serializeWrite, str, writeJsonAtomic } from "./util";
import { deleteWorkspace, listWorkspaceRows } from "./workspaces";
import type { PaseoLike } from "./overview";

const STATE_PATH = "agent-manager/auto-release.json";
const TICK_MS = 60000;
const MAX_TIMERS = 200;
const MAX_PENDING_ARCHIVE = 200;
const MAX_ARCHIVE_ATTEMPTS = 3;

interface PendingArchive {
  agentId: string;
  title: string | null;
  dueAt: string;
  attempts: number;
}

type AutoReleaseState = AutoReleaseSnapshot & { pendingArchive: PendingArchive[] };

const DEFAULT_STATE: AutoReleaseState = {
  enabled: true,
  idleMinutes: 10,
  intervalMinutes: 30,
  onLoad: "threshold",
  removeEmptyWorkspaces: true,
  closeIdleTerminals: false,
  terminalIdleMinutes: 30,
  archiveIdleMinutes: 60,
  staleRunningMinutes: 5,
  lastRunAt: null,
  lastReleased: [],
  lastArchived: [],
  lastReapedStale: [],
  lastRemovedWorkspaces: [],
  lastClosedTerminals: 0,
  lastSkipped: 0,
  lastError: null,
  nextRunAt: null,
  pendingArchive: [],
};

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const lastStatus = new Map<string, string>();
const loadedAt = new Map<string, number>();
const stuckSince = new Map<string, number>();
// Sanity latch: only reap "running" agents once a scan has actually seen a live
// agent process, so a broken /proc scan cannot mass-close every running session.
let sawAgentProcess = false;

/**
 * Decide whether a `running` record is stale. `stuck` is the timestamp the
 * condition was first seen (null when it is healthy or already non-running),
 * `reap` is true once that condition has held for the whole grace window.
 */
export function staleRunningDecision(input: {
  now: number;
  status: string;
  hasProcess: boolean;
  canReap: boolean;
  staleRunningMinutes: number;
  since: number | null;
}): { stuck: number | null; reap: boolean } {
  if (input.status !== "running" || !input.canReap || input.hasProcess) {
    return { stuck: null, reap: false };
  }
  const since = input.since ?? input.now;
  return { stuck: since, reap: input.now - since >= input.staleRunningMinutes * 60000 };
}

function noteLoaded(agentId: string): void {
  loadedAt.set(agentId, Date.now());
}

function forgetLoaded(agentId: string): void {
  loadedAt.delete(agentId);
}

function idleBase(agentId: string, lastActivity: number | null): number {
  const loaded = loadedAt.get(agentId) ?? 0;
  return Math.max(lastActivity ?? 0, loaded);
}

function blocksRelease(agent: { attentionReason?: unknown; pendingPermissions?: unknown } | null | undefined): boolean {
  if (str(agent?.attentionReason) === "permission") {
    return true;
  }
  const pending = agent?.pendingPermissions;
  const pendingCount = Array.isArray(pending) ? pending.length : typeof pending === "number" ? pending : 0;
  return pendingCount > 0;
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let subscription: OwnedAgentSubscription | null = null;
let subscriptionCleanup: (() => void) | null = null;
let running = false;
let loaded = false;

export function startAutoReleaseScheduler(): () => void {
  if (schedulerTimer) {
    return () => {};
  }
  schedulerTimer = setInterval(() => {
    fireAndForget(tick(), "scheduler tick");
  }, TICK_MS);
  fireAndForget(activate(), "initial sweep");
  return () => {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    subscriptionCleanup?.();
    subscriptionCleanup = null;
    void subscription?.release().catch(() => undefined);
    subscription = null;
    holdDaemonClient(false);
  };
}

export async function readAutoReleaseState(): Promise<AutoReleaseSnapshot> {
  const stored = await readStoredState();
  const { pendingArchive: _pendingArchive, ...snapshot } = withDerived({ ...DEFAULT_STATE, ...stored });
  return snapshot;
}

export async function updateAutoReleaseState(patch: AutoReleasePatch): Promise<AutoReleaseSnapshot> {
  const current = { ...DEFAULT_STATE, ...(await readStoredState()) };
  const next: AutoReleaseState = {
    ...current,
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.idleMinutes === undefined ? {} : { idleMinutes: clamp(patch.idleMinutes, 1, 24 * 60) }),
    ...(patch.intervalMinutes === undefined ? {} : { intervalMinutes: clamp(patch.intervalMinutes, 1, 24 * 60) }),
    ...(patch.onLoad === undefined ? {} : { onLoad: patch.onLoad }),
    ...(patch.removeEmptyWorkspaces === undefined ? {} : { removeEmptyWorkspaces: patch.removeEmptyWorkspaces }),
    ...(patch.closeIdleTerminals === undefined ? {} : { closeIdleTerminals: patch.closeIdleTerminals }),
    ...(patch.terminalIdleMinutes === undefined
      ? {}
      : { terminalIdleMinutes: clamp(patch.terminalIdleMinutes, 5, 24 * 60) }),
    ...(patch.archiveIdleMinutes === undefined
      ? {}
      : { archiveIdleMinutes: clamp(patch.archiveIdleMinutes, 0, 7 * 24 * 60) }),
    ...(patch.staleRunningMinutes === undefined
      ? {}
      : { staleRunningMinutes: clamp(patch.staleRunningMinutes, 0, 24 * 60) }),
  };
  await writeState(next);
  if (patch.enabled === false) {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    subscriptionCleanup?.();
    subscriptionCleanup = null;
    void subscription?.release().catch(() => undefined);
    subscription = null;
    holdDaemonClient(false);
  }
  if (patch.enabled === true || patch.runNow === true) {
    await activate();
    await sweep(patch.runNow === true ? "allIdle" : next.onLoad);
  }
  return readAutoReleaseState();
}

async function tick(): Promise<void> {
  const state = { ...DEFAULT_STATE, ...(await readStoredState()) };
  if (!state.enabled) {
    return;
  }
  await processPendingArchive();
  if (state.lastRunAt && Date.now() - Date.parse(state.lastRunAt) < state.intervalMinutes * 60000) {
    return;
  }
  await activate();
  await sweep("threshold");
}

async function activate(): Promise<void> {
  const state = { ...DEFAULT_STATE, ...(await readStoredState()) };
  if (!state.enabled) {
    return;
  }
  holdDaemonClient(true);
  if (subscription) {
    return;
  }
  beginDaemonClientUse();
  try {
    const client = await getDaemonClient();
    const owned = await client.observeAgents({ filter: { includeArchived: true } });
    subscription = owned;
    subscriptionCleanup = owned.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        onAgentUpdate(message);
      },
    });
    const snapshot = await owned.ready.catch(() => null);
    if (snapshot) {
      for (const entry of snapshot.entries ?? []) {
        onAgentUpdate({ type: "agent_update", payload: { kind: "upsert", agent: entry.agent } });
      }
    }
    if (!loaded) {
      loaded = true;
      fireAndForget(sweep(state.onLoad), "load sweep");
    }
  } catch (error) {
    holdDaemonClient(false);
    subscription = null;
    await writeState({ ...state, lastError: describe(error) });
  } finally {
    endDaemonClientUse();
  }
}

function onAgentUpdate(message: unknown): void {
  const payload = (message as { payload?: { kind?: unknown; agent?: unknown; id?: unknown } })?.payload;
  if (!payload) {
    return;
  }
  const agent = payload.agent as RawLiveAgent | undefined;
  const agentId = str(agent?.id) ?? str(payload.id);
  if (!agentId) {
    return;
  }
  if (payload.kind === "remove" || str(agent?.archivedAt) !== null) {
    cancelTimer(agentId);
    lastStatus.delete(agentId);
    forgetLoaded(agentId);
    stuckSince.delete(agentId);
    return;
  }
  const status = str(agent?.status) ?? "unknown";
  const previous = lastStatus.get(agentId);
  lastStatus.set(agentId, status);
  if (status === "closed" || status === "error") {
    cancelTimer(agentId);
    forgetLoaded(agentId);
    stuckSince.delete(agentId);
    return;
  }
  if (status === "idle" && (previous === undefined || previous === "closed" || previous === "error")) {
    noteLoaded(agentId);
  }
  if (status !== "idle" || blocksRelease(agent)) {
    cancelTimer(agentId);
    return;
  }
  if (previous === "idle" && timers.has(agentId)) {
    return;
  }
  armFrom(agentId, agent);
}

function armFrom(agentId: string, agent: RawLiveAgent | undefined): void {
  fireAndForget((async () => {
    const state = { ...DEFAULT_STATE, ...(await readStoredState()) };
    if (!state.enabled) {
      return;
    }
    const recordPath = await findRecordPath(str(agent?.cwd), agentId);
    const lastActivity = await readLastActivity(recordPath, str(agent?.updatedAt));
    const base = idleBase(agentId, lastActivity);
    const dueAt = (base || Date.now()) + state.idleMinutes * 60000;
    armTimer(agentId, Math.max(1000, dueAt - Date.now()));
  })(), `arm ${agentId.slice(0, 7)}`);
}

function armTimer(agentId: string, delayMs: number): void {
  if (timers.size >= MAX_TIMERS && !timers.has(agentId)) {
    return;
  }
  cancelTimer(agentId);
  const timer = setTimeout(() => {
    timers.delete(agentId);
    fireAndForget(releaseArmedAgent(agentId), `release ${agentId.slice(0, 7)}`);
  }, delayMs);
  timers.set(agentId, timer);
}

function cancelTimer(agentId: string): void {
  const timer = timers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(agentId);
  }
}

async function sweep(mode: AutoReleaseSnapshot["onLoad"]): Promise<void> {
  const initial = { ...DEFAULT_STATE, ...(await readStoredState()) };
  if (!initial.enabled || running || mode === "off") {
    await recordRun(initial, [], [], initial.pendingArchive, [], 0, 0, null);
    return;
  }
  await processPendingArchive();
  const state = { ...DEFAULT_STATE, ...(await readStoredState()) };
  running = true;
  beginDaemonClientUse();
  const released: Array<{ agentId: string; title: string | null }> = [];
  const reapedStale: Array<{ agentId: string; title: string | null }> = [];
  let pending = state.pendingArchive;
  let skipped = 0;
  let error: string | null = null;
  try {
    const client = await getDaemonClient();
    const agents = await listAllAgents((options) => client.fetchAgents(options as never));
    const processes =
      state.staleRunningMinutes > 0 ? await scanAgentProcessesFresh().catch(() => null) : null;
    if (processes && processes.size > 0) {
      sawAgentProcess = true;
    }
    const canReap = state.staleRunningMinutes > 0 && processes !== null && sawAgentProcess;
    const staleIds: string[] = [];
    const threshold = state.idleMinutes * 60000;
    const now = Date.now();
    for (const agent of agents) {
      if (agent.archivedAt !== null || agent.status === "closed") {
        cancelTimer(agent.id);
        stuckSince.delete(agent.id);
        continue;
      }
      if (agent.status === "running") {
        cancelTimer(agent.id);
        // A record can stay `running` after its process died. Once that has held
        // for staleRunningMinutes, close it instead of skipping it forever.
        const decision = staleRunningDecision({
          now,
          status: agent.status,
          hasProcess: processes?.has(agent.id) ?? true,
          canReap,
          staleRunningMinutes: state.staleRunningMinutes,
          since: stuckSince.get(agent.id) ?? null,
        });
        if (decision.stuck === null) {
          stuckSince.delete(agent.id);
        } else {
          stuckSince.set(agent.id, decision.stuck);
          if (decision.reap) {
            staleIds.push(agent.id);
          }
        }
        continue;
      }
      stuckSince.delete(agent.id);
      if (blocksRelease(agent)) {
        cancelTimer(agent.id);
        skipped += 1;
        continue;
      }
      const lastActivity = await resolveLastActivityAt(agent);
      const base = idleBase(agent.id, lastActivity);
      const dueAt = (base || now) + threshold;
      if (mode === "allIdle" || dueAt <= now) {
        const result = await releaseIdleAgent(agent.id, agents, processes);
        if (result === "released") {
          released.push({ agentId: agent.id, title: agent.title });
          pending = scheduleArchive(pending, agent.id, agent.title, now, state.archiveIdleMinutes);
        } else if (result === "skipped") {
          skipped += 1;
        } else if (result !== "no-runtime") {
          error = result;
        }
        continue;
      }
      armTimer(agent.id, dueAt - now);
    }
    if (staleIds.length > 0) {
      const outcome = await archiveAgents(staleIds);
      for (const agentId of outcome.archived) {
        const title = agents.find((agent) => agent.id === agentId)?.title ?? null;
        reapedStale.push({ agentId, title });
        pending = pending.filter((entry) => entry.agentId !== agentId);
      }
      if (outcome.failed.length > 0) {
        error = error ?? outcome.failed[0]?.error ?? null;
      }
    }
  } catch (sweepError) {
    error = describe(sweepError);
  } finally {
    endDaemonClientUse();
    running = false;
  }

  let removed: Array<{ workspaceId: string; name: string | null }> = [];
  try {
    removed = state.removeEmptyWorkspaces ? await removeEmptyWorkspaces() : [];
  } catch (removalError) {
    error = describe(removalError);
  }

  let closedTerminals = 0;
  if (state.closeIdleTerminals) {
    try {
      const client = await getDaemonClient();
      const result = await closeIdleTerminals(terminalApiFromClient(client), state.terminalIdleMinutes);
      closedTerminals = result.closed.length;
      skipped += result.skipped;
      if (result.failed.length > 0) {
        error = error ?? result.failed[0]?.error ?? null;
      }
    } catch (terminalError) {
      error = error ?? describe(terminalError);
    }
  }

  await recordRun(state, released, reapedStale, pending, removed, closedTerminals, skipped, error).catch(
    (recordError) => {
      console.log(`agent-manager could not record the sweep: ${describe(recordError)}`);
    },
  );
}

async function releaseArmedAgent(agentId: string): Promise<void> {
  const outcome = await releaseIdleAgent(agentId);
  if (outcome !== "released") {
    return;
  }
  const state = { ...DEFAULT_STATE, ...(await readStoredState()) };
  const released = [{ agentId, title: null }, ...state.lastReleased].slice(0, 5);
  const pending = scheduleArchive(state.pendingArchive, agentId, null, Date.now(), state.archiveIdleMinutes);
  await writeState(withDerived({ ...state, lastReleased: released, pendingArchive: pending }));
}

async function releaseIdleAgent(
  agentId: string,
  known?: AgentRecord[],
  processes?: Map<string, unknown> | null,
): Promise<"released" | "no-runtime" | "skipped" | string> {
  try {
    const client = await getDaemonClient();
    const current = known?.find((agent) => agent.id === agentId) ?? (await fetchAgent(client, agentId));
    if (!current || current.status === "running" || current.status === "closed") {
      return "skipped";
    }
    if (blocksRelease(current) || current.archivedAt !== null) {
      return "skipped";
    }
    const hadRuntime = processes ? processes.has(agentId) : await hasRuntime(agentId);
    // This daemon stores only a bcrypt hash for its password, and /mcp/agents is
    // exempt from the global bearer middleware, so kill_agent cannot authenticate
    // here (daemon bootstrap.js: "hash only, no plaintext available"). Fall back
    // to the same scoped SIGTERM releaseAgents uses for the manual Release action:
    // it only ever signals a PID that is a daemon child carrying PASEO_AGENT_ID.
    const outcome = await releaseAgents([agentId], { allowSignalFallback: true });
    const failure = outcome.failed[0];
    if (failure) {
      return failure.error;
    }
    const stillRunning = await hasRuntime(agentId);
    if (!stillRunning) {
      forgetLoaded(agentId);
    }
    if (stillRunning) {
      return "skipped";
    }
    // Only a session that actually held a runtime is worth archiving later; the
    // historical backlog of already-closed records must stay untouched.
    return hadRuntime ? "released" : "no-runtime";
  } catch (error) {
    return describe(error);
  }
}

async function fetchAgent(client: DaemonSessionClient, agentId: string): Promise<AgentRecord | null> {
  const agents = await listAllAgents((options) => client.fetchAgents(options as never)).catch(() => []);
  return agents.find((agent) => agent.id === agentId) ?? null;
}

async function hasRuntime(agentId: string): Promise<boolean> {
  const processes = await scanAgentProcessesFresh().catch(() => new Map());
  return processes.has(agentId);
}

async function removeEmptyWorkspaces(): Promise<Array<{ workspaceId: string; name: string | null }>> {
  const removed: Array<{ workspaceId: string; name: string | null }> = [];
  try {
    const rows = await listWorkspaceRows();
    const client = await getDaemonClient();
    const agents = await listAllAgents((options) => client.fetchAgents(options as never));
    const busy = new Set(agents.map((agent) => agent.workspaceId).filter((id): id is string => id !== null));
    const paseo: PaseoLike = {
      agents: { list: (options) => client.fetchAgents(options as never) },
    };
    for (const row of rows) {
      if (row.archivedAt === null || busy.has(row.workspaceId)) {
        continue;
      }
      const result = await deleteWorkspace(paseo, row.workspaceId).catch(() => null);
      if (result?.ok) {
        removed.push({ workspaceId: row.workspaceId, name: row.name });
      }
    }
  } catch {
    return removed;
  }
  return removed;
}

async function recordRun(
  state: AutoReleaseState,
  released: Array<{ agentId: string; title: string | null }>,
  reapedStale: Array<{ agentId: string; title: string | null }>,
  pendingArchive: PendingArchive[],
  removedWorkspaces: Array<{ workspaceId: string; name: string | null }>,
  closedTerminals: number,
  skipped: number,
  error: string | null,
): Promise<void> {
  const finishedAt = new Date().toISOString();
  await writeState(
    withDerived({
      ...state,
      lastRunAt: finishedAt,
      lastReleased: released,
      lastReapedStale: reapedStale,
      pendingArchive,
      lastRemovedWorkspaces: removedWorkspaces,
      lastClosedTerminals: closedTerminals,
      lastSkipped: skipped,
      lastError: error,
    }),
  );
}

function withDerived(state: AutoReleaseState): AutoReleaseState {
  if (!state.enabled) {
    return { ...state, nextRunAt: null };
  }
  if (!state.lastRunAt) {
    return { ...state, nextRunAt: new Date().toISOString() };
  }
  return {
    ...state,
    nextRunAt: new Date(Date.parse(state.lastRunAt) + state.intervalMinutes * 60000).toISOString(),
  };
}

/**
 * Archive a released session after a longer idle window so the client can no
 * longer restore its tab and respawn the runtime. Only sessions that actually
 * held a runtime when they were released are scheduled, which keeps the
 * historical backlog of long-closed records untouched.
 */
function scheduleArchive(
  entries: PendingArchive[],
  agentId: string,
  title: string | null,
  releasedAtMs: number,
  archiveIdleMinutes: number,
): PendingArchive[] {
  if (archiveIdleMinutes <= 0) {
    return entries;
  }
  const next = entries.filter((entry) => entry.agentId !== agentId);
  next.push({
    agentId,
    title,
    dueAt: new Date(releasedAtMs + archiveIdleMinutes * 60000).toISOString(),
    attempts: 0,
  });
  next.sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt));
  return next.slice(0, MAX_PENDING_ARCHIVE);
}

async function archiveAgents(
  agentIds: string[],
): Promise<{ archived: string[]; failed: Array<{ agentId: string; error: string }> }> {
  const archived: string[] = [];
  const failed: Array<{ agentId: string; error: string }> = [];
  if (agentIds.length === 0) {
    return { archived, failed };
  }
  try {
    const client = await getDaemonClient();
    const response = (await client.closeItems({ agentIds, terminalIds: [] })) as {
      agents?: Array<{ agentId?: unknown }>;
    };
    const done = new Set(
      (Array.isArray(response?.agents) ? response.agents : [])
        .map((entry) => str(entry?.agentId))
        .filter((id): id is string => id !== null),
    );
    for (const agentId of agentIds) {
      if (done.has(agentId)) {
        archived.push(agentId);
      } else {
        failed.push({ agentId, error: "The daemon did not confirm the close" });
      }
    }
  } catch (error) {
    const message = describe(error);
    for (const agentId of agentIds) {
      failed.push({ agentId, error: message });
    }
  }
  return { archived, failed };
}

async function processPendingArchive(): Promise<void> {
  const state = { ...DEFAULT_STATE, ...(await readStoredState()) };
  if (!state.enabled || state.pendingArchive.length === 0) {
    return;
  }
  const now = Date.now();
  const due = state.pendingArchive.filter((entry) => Date.parse(entry.dueAt) <= now);
  if (due.length === 0) {
    return;
  }

  const keep = state.pendingArchive.filter((entry) => Date.parse(entry.dueAt) > now);
  const archived: Array<{ agentId: string; title: string | null }> = [];
  let error: string | null = null;
  beginDaemonClientUse();
  try {
    const client = await getDaemonClient();
    const agents = await listAllAgents((options) => client.fetchAgents(options as never));
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const targets: string[] = [];
    for (const entry of due) {
      const agent = byId.get(entry.agentId);
      if (!agent || agent.archivedAt !== null) {
        continue;
      }
      if (agent.status === "running" || blocksRelease(agent)) {
        // It came back to life; the next release schedules a fresh window.
        continue;
      }
      targets.push(entry.agentId);
    }
    if (targets.length > 0) {
      const outcome = await archiveAgents(targets);
      for (const agentId of outcome.archived) {
        archived.push({ agentId, title: byId.get(agentId)?.title ?? null });
      }
      for (const failure of outcome.failed) {
        const entry = due.find((candidate) => candidate.agentId === failure.agentId);
        if (entry && entry.attempts + 1 < MAX_ARCHIVE_ATTEMPTS) {
          keep.push({ ...entry, attempts: entry.attempts + 1 });
        } else {
          error = error ?? failure.error;
        }
      }
    }
  } catch (pendingError) {
    error = describe(pendingError);
  } finally {
    endDaemonClientUse();
  }

  await writeState(
    withDerived({
      ...state,
      pendingArchive: keep.slice(0, MAX_PENDING_ARCHIVE),
      lastArchived: [...archived, ...state.lastArchived].slice(0, 5),
      lastError: error ?? state.lastError,
    }),
  );
}

interface RawLiveAgent {
  id?: unknown;
  status?: unknown;
  archivedAt?: unknown;
  requiresAttention?: unknown;
  attentionReason?: unknown;
  pendingPermissions?: unknown;
  updatedAt?: unknown;
  cwd?: unknown;
}

async function resolveLastActivityAt(agent: AgentRecord): Promise<number | null> {
  const recordPath = await findRecordPath(agent.cwd, agent.id);
  return readLastActivity(recordPath, agent.updatedAt);
}

async function readLastActivity(recordPath: string | null, fallback: string | null): Promise<number | null> {
  if (recordPath) {
    try {
      const parsed = JSON.parse(await readFile(recordPath, "utf8")) as { lastActivityAt?: unknown };
      const parsedMs = Date.parse(str(parsed.lastActivityAt) ?? "");
      if (Number.isFinite(parsedMs)) {
        return parsedMs;
      }
    } catch {
      return null;
    }
  }
  const updatedMs = Date.parse(fallback ?? "");
  return Number.isFinite(updatedMs) ? updatedMs : null;
}

async function findRecordPath(cwd: string | null, agentId: string): Promise<string | null> {
  if (cwd) {
    const slug = cwd.replace(/^\/+/, "").replace(/\/+/g, "-");
    const candidate = join(paseoHome(), "agents", slug, `${agentId}.json`);
    if (await exists(candidate)) {
      return candidate;
    }
  }
  const root = join(paseoHome(), "agents");
  try {
    for (const entry of await readdir(root)) {
      const candidate = join(root, entry, `${agentId}.json`);
      if (await exists(candidate)) {
        return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function readStoredState(): Promise<Partial<AutoReleaseState>> {
  try {
    const raw = await readFile(join(paseoHome(), STATE_PATH), "utf8");
    const parsed = JSON.parse(raw) as Partial<AutoReleaseState>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state: AutoReleaseState): Promise<void> {
  return serializeWrite(() => writeJsonAtomic(join(paseoHome(), STATE_PATH), state));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}
