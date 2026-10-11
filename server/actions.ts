import type { DeleteAgentsOutcome, ReleaseOutcome } from "../shared/contracts";
import { deleteAgentViaCli } from "./cli";
import { killAgentViaDaemonMcp } from "./daemon-mcp";
import { scanAgentProcesses, scanAgentProcessesFresh, type AgentProcessInfo } from "./processes";
import { describe, readProcStatSync } from "./util";

interface KillAttempt {
  error: string | null;
  note: string | null;
}

export async function releaseAgents(
  agentIds: string[],
  options: { allowSignalFallback: boolean },
): Promise<ReleaseOutcome> {
  const before = await scanAgentProcessesFresh().catch(() => new Map<string, AgentProcessInfo>());
  const released: string[] = [];
  const failed: ReleaseOutcome["failed"] = [];
  const pending: Array<{ agentId: string; pid: number; rssBytes: number }> = [];

  for (const agentId of agentIds) {
    const target = before.get(agentId);
    if (!target) {
      released.push(agentId);
      continue;
    }
    const attempt = await killOrSignal(agentId, target, options.allowSignalFallback);
    if (attempt.error) {
      failed.push({ agentId, error: attempt.error });
      continue;
    }
    pending.push({ agentId, pid: target.pid, rssBytes: target.rssBytes });
  }

  const exited = await waitForProcessesExit(pending.map((entry) => entry.pid));
  const remaining = await scanAgentProcessesFresh().catch(() => new Map<string, AgentProcessInfo>());
  let freedBytes = 0;
  for (const entry of pending) {
    if (exited.has(entry.pid) || !remaining.has(entry.agentId)) {
      released.push(entry.agentId);
      freedBytes += entry.rssBytes;
    } else {
      failed.push({ agentId: entry.agentId, error: STILL_RUNNING });
    }
  }

  return { released, failed, freedBytes };
}

export async function deleteAgents(agentIds: string[]): Promise<Omit<DeleteAgentsOutcome, "message">> {
  const deleted: string[] = [];
  const failed: DeleteAgentsOutcome["failed"] = [];

  for (const agentId of agentIds) {
    const result = await deleteAgentViaCli(agentId);
    if (result.ok) {
      deleted.push(agentId);
    } else {
      failed.push({ agentId, error: result.output || "Delete failed" });
    }
  }

  return { deleted, failed };
}

const STILL_RUNNING = "The daemon accepted kill_agent but the runtime process is still alive.";

async function killOrSignal(
  agentId: string,
  target: AgentProcessInfo,
  allowSignalFallback: boolean,
): Promise<KillAttempt> {
  try {
    await killAgentViaDaemonMcp(agentId);
    return { error: null, note: null };
  } catch (error) {
    // Deliberately no SIGTERM fallback. Killing the process behind the daemon's
    // back leaves the manager holding a session whose RPC pipe is dead: the next
    // message fails with "Pi RPC process is closed" and no runtime is respawned,
    // so the session is bricked rather than released. The daemon's own kill_agent
    // closes the session, persists the resumable snapshot and re-emits the agent,
    // which is the only correct way to free the memory. If it cannot be reached,
    // skip the release and leave the session intact and resumable.
    return {
      error: describe(error),
      note: allowSignalFallback
        ? "Signal fallback was requested but is unsafe; the session was left intact."
        : null,
    };
  }
}

async function waitForProcessesExit(pids: number[], timeoutMs = 3000): Promise<Set<number>> {
  const remaining = new Set(pids);
  const deadline = Date.now() + timeoutMs;
  while (remaining.size > 0 && Date.now() < deadline) {
    for (const pid of remaining) {
      if (!isRunning(pid)) {
        remaining.delete(pid);
      }
    }
    if (remaining.size > 0) {
      await delay(100);
    }
  }
  const exited = new Set(pids);
  for (const pid of remaining) {
    exited.delete(pid);
  }
  return exited;
}

function isRunning(pid: number): boolean {
  const stat = readProcStatSync(pid);
  if (stat) {
    return stat.state !== "Z" && stat.state !== "X";
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
