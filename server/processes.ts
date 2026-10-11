import { readFileSync, readdirSync } from "node:fs";

import { parseProcStat } from "./util";

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
    entries = readdirSync("/proc");
  } catch {
    return found;
  }

  // /proc reads are memory-backed and tiny, so walking them synchronously is
  // ~6x cheaper in CPU than one async fs round-trip per pid through libuv's
  // threadpool — and it allocates no promise machinery in the process.
  const daemonPid = process.ppid;
  const winners = new Map<string, Candidate>();
  for (const name of entries) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const pid = Number(name);
    if (pid === process.pid || pid === daemonPid) {
      continue;
    }
    const candidate = readCandidate(pid, daemonPid);
    if (!candidate) {
      continue;
    }
    const best = winners.get(candidate.agentId);
    if (!best || candidate.startTimeTicks < best.startTimeTicks) {
      winners.set(candidate.agentId, candidate);
    }
  }

  for (const [agentId, winner] of winners) {
    found.set(agentId, {
      pid: winner.pid,
      rssBytes: winner.rssBytes,
      command: winner.command,
      isDaemonChild: true,
    });
  }

  return found;
}

function readCandidate(pid: number, daemonPid: number): Candidate | null {
  // Cheap gate first: only the daemon's children can be agent runtimes, and a
  // /proc/<pid>/stat read is a few hundred bytes versus a full environ read.
  // Reading environ first for every pid was the whole memory-growth bug.
  const stat = readProcStatSync(pid);
  if (!stat || stat.ppid !== daemonPid) {
    return null;
  }
  const agentId = readAgentId(pid);
  if (!agentId) {
    return null;
  }
  return {
    agentId,
    pid,
    startTimeTicks: stat.startTimeTicks,
    rssBytes: readResidentBytes(pid),
    command: readCommand(pid),
  };
}

function readProcStatSync(pid: number) {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "latin1"));
  } catch {
    return null;
  }
}

function readAgentId(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`);
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

function readResidentBytes(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "latin1");
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    if (match) {
      return Number(match[1]) * 1024;
    }
  } catch {
    return readStatmResidentBytes(pid);
  }
  return readStatmResidentBytes(pid);
}

function readStatmResidentBytes(pid: number): number {
  try {
    const statm = readFileSync(`/proc/${pid}/statm`, "latin1");
    const residentPages = Number(statm.split(/\s+/)[1]);
    if (Number.isFinite(residentPages)) {
      return residentPages * PAGE_SIZE_BYTES;
    }
  } catch {
    return 0;
  }
  return 0;
}

function readCommand(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/comm`, "latin1").trim();
  } catch {
    return "";
  }
}
