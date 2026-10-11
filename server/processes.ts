import { readFile, readdir } from "node:fs/promises";

import { readProcStat } from "./util";

export interface AgentProcessInfo {
  pid: number;
  rssBytes: number;
  command: string;
  isDaemonChild: boolean;
}

const PAGE_SIZE_BYTES = 4096;
const ENV_PREFIX = Buffer.from("PASEO_AGENT_ID=");

interface Candidate {
  agentId: string;
  pid: number;
  startTimeTicks: number;
  rssBytes: number;
  command: string;
}

const SCAN_CACHE_MS = 3000;
// Every pid costs a handful of fs calls; running them all at once (600+ on this
// host) spikes memory for no gain, so walk the list with a small pool.
const SCAN_CONCURRENCY = 24;
let scanCache: { at: number; processes: Map<string, AgentProcessInfo> } | null = null;

export async function scanAgentProcesses(): Promise<Map<string, AgentProcessInfo>> {
  if (scanCache && Date.now() - scanCache.at < SCAN_CACHE_MS) {
    return scanCache.processes;
  }
  const processes = await scanAgentProcessesFresh();
  scanCache = { at: Date.now(), processes };
  return processes;
}

export async function scanAgentProcessesFresh(): Promise<Map<string, AgentProcessInfo>> {
  const found = new Map<string, AgentProcessInfo>();
  if (process.platform !== "linux") {
    return found;
  }

  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return found;
  }

  const daemonPid = process.ppid;
  const pids = entries
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => pid !== process.pid && pid !== daemonPid);
  const candidates = (
    await mapLimit(pids, SCAN_CONCURRENCY, (pid) => readCandidate(pid, daemonPid))
  ).filter((candidate): candidate is Candidate => candidate !== null);

  const byAgent = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const list = byAgent.get(candidate.agentId);
    if (list) {
      list.push(candidate);
    } else {
      byAgent.set(candidate.agentId, [candidate]);
    }
  }

  for (const [agentId, group] of byAgent) {
    const winner = group.reduce((best, candidate) =>
      candidate.startTimeTicks < best.startTimeTicks ? candidate : best,
    );
    found.set(agentId, {
      pid: winner.pid,
      rssBytes: winner.rssBytes,
      command: winner.command,
      isDaemonChild: true,
    });
  }

  return found;
}

async function readCandidate(pid: number, daemonPid: number): Promise<Candidate | null> {
  // Cheap gate first: only the daemon's children can be agent runtimes, and a
  // /proc/<pid>/stat read is a few hundred bytes versus a full environ read.
  // Reading environ first for every pid was the whole memory-growth bug.
  const stat = await readProcStat(pid);
  if (!stat || stat.ppid !== daemonPid) {
    return null;
  }
  const agentId = await readAgentId(pid);
  if (!agentId) {
    return null;
  }
  return {
    agentId,
    pid,
    startTimeTicks: stat.startTimeTicks,
    rssBytes: await readResidentBytes(pid),
    command: await readCommand(pid),
  };
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

async function readAgentId(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/environ`);
    const start = raw.indexOf(ENV_PREFIX);
    if (start === -1 || (start !== 0 && raw[start - 1] !== 0)) {
      return null;
    }
    let end = start + ENV_PREFIX.length;
    while (end < raw.length && raw[end] !== 0) {
      end += 1;
    }
    if (end === start + ENV_PREFIX.length) {
      return null;
    }
    return raw.toString("latin1", start + ENV_PREFIX.length, end);
  } catch {
    return null;
  }
}

async function readResidentBytes(pid: number): Promise<number> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "latin1");
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    if (match) {
      return Number(match[1]) * 1024;
    }
  } catch {
    return readStatmResidentBytes(pid);
  }
  return readStatmResidentBytes(pid);
}

async function readStatmResidentBytes(pid: number): Promise<number> {
  try {
    const statm = await readFile(`/proc/${pid}/statm`, "latin1");
    const residentPages = Number(statm.split(/\s+/)[1]);
    if (Number.isFinite(residentPages)) {
      return residentPages * PAGE_SIZE_BYTES;
    }
  } catch {
    return 0;
  }
  return 0;
}

async function readCommand(pid: number): Promise<string> {
  try {
    return (await readFile(`/proc/${pid}/comm`, "latin1")).trim();
  } catch {
    return "";
  }
}
