import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export type RpcOutput<T extends { output: z.ZodType }> = z.infer<T["output"]>;
export type RpcInput<T extends { input: z.ZodType }> = z.infer<T["input"]>;

export const agentRowSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  status: z.string(),
  archived: z.boolean(),
  workspaceId: z.string().nullable(),
  parentAgentId: z.string().nullable(),
  attentionReason: z.string().nullable(),
  updatedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  lastUserMessageAt: z.string().nullable(),
  labels: z.record(z.string(), z.string()),
  cwd: z.string().nullable(),
  pid: z.number().int().nullable(),
  rssBytes: z.number().int().nullable(),
});

export type AgentRow = z.infer<typeof agentRowSchema>;

export const overviewPayloadSchema = z.object({
  agents: z.array(agentRowSchema),
  totals: z.object({
    total: z.number().int(),
    holdingProcess: z.number().int(),
    closed: z.number().int(),
    archived: z.number().int(),
    rssBytes: z.number().int(),
  }),
  warning: z.string().nullable(),
});

export type OverviewPayload = z.infer<typeof overviewPayloadSchema>;

export const overviewRpc = defineRpc({
  name: "agent-manager.overview",
  input: z.object({}),
  output: overviewPayloadSchema,
});

const failureSchema = z.object({ agentId: z.string(), error: z.string() });

export const releaseManyRpc = defineRpc({
  name: "agent-manager.release-many",
  input: z.object({
    agentIds: z.array(z.string()),
    allowSignalFallback: z.boolean().optional(),
  }),
  output: z.object({
    released: z.array(z.string()),
    failed: z.array(failureSchema),
    freedBytes: z.number().int(),
  }),
});

export const agentDeleteRpc = defineRpc({
  name: "agent-manager.agent-delete",
  input: z.object({ agentIds: z.array(z.string()) }),
  output: z.object({
    deleted: z.array(z.string()),
    failed: z.array(failureSchema),
    message: z.string(),
  }),
});

export const agentRestoreRpc = defineRpc({
  name: "agent-manager.agent-restore",
  input: z.object({ agentId: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const projectRowSchema = z.object({
  projectId: z.string(),
  name: z.string().nullable(),
  rootPath: z.string().nullable(),
  kind: z.string().nullable(),
});

export type ProjectRow = z.infer<typeof projectRowSchema>;

export const workspaceRowSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  name: z.string().nullable(),
  cwd: z.string(),
  kind: z.string(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  worktreeRoot: z.string().nullable(),
  mainRepoRoot: z.string().nullable(),
  isPaseoOwnedWorktree: z.boolean(),
  pinnedAt: z.string().nullable(),
  autoArchivedChangeRequestUrl: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  projectName: z.string().nullable(),
  projectRoot: z.string().nullable(),
});

export type WorkspaceRow = z.infer<typeof workspaceRowSchema>;

export const jobSchema = z.object({
  jobId: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  phase: z.enum(["workspace", "tabs", "done", "failed"]),
  total: z.number().int(),
  done: z.number().int(),
  current: z.string().nullable(),
  restoredWorkspace: z.boolean(),
  failed: z.array(failureSchema),
  message: z.string().nullable(),
  finished: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});

export type JobSnapshot = z.infer<typeof jobSchema>;

export const autoReleaseStateSchema = z.object({
  enabled: z.boolean(),
  idleMinutes: z.number(),
  intervalMinutes: z.number(),
  onLoad: z.enum(["allIdle", "threshold", "off"]),
  removeEmptyWorkspaces: z.boolean(),
  closeIdleTerminals: z.boolean(),
  terminalIdleMinutes: z.number(),
  /** Minutes a released session keeps its tab before it is archived; 0 disables archiving. */
  archiveIdleMinutes: z.number(),
  /** Minutes a `running` session may have no process before it is closed; 0 disables reaping. */
  staleRunningMinutes: z.number(),
  lastRunAt: z.string().nullable(),
  lastReleased: z.array(z.object({ agentId: z.string(), title: z.string().nullable() })),
  lastArchived: z.array(z.object({ agentId: z.string(), title: z.string().nullable() })),
  lastReapedStale: z.array(z.object({ agentId: z.string(), title: z.string().nullable() })),
  lastRemovedWorkspaces: z.array(z.object({ workspaceId: z.string(), name: z.string().nullable() })),
  lastClosedTerminals: z.number().int(),
  lastSkipped: z.number().int(),
  lastError: z.string().nullable(),
  nextRunAt: z.string().nullable(),
});

export type AutoReleaseSnapshot = z.infer<typeof autoReleaseStateSchema>;

export const workspacesRpc = defineRpc({
  name: "agent-manager.workspaces",
  input: z.object({}),
  output: z.object({
    workspaces: z.array(workspaceRowSchema),
    projects: z.array(projectRowSchema),
    home: z.string(),
    serverId: z.string().nullable(),
  }),
});

export const workspaceRenameRpc = defineRpc({
  name: "agent-manager.workspace-rename",
  input: z.object({
    workspaceId: z.string(),
    title: z.string().nullable(),
  }),
  output: z.object({
    ok: z.boolean(),
    title: z.string().nullable(),
    message: z.string(),
  }),
});

export const workspaceArchiveRpc = defineRpc({
  name: "agent-manager.workspace-archive",
  input: z.object({
    workspaceId: z.string(),
    confirmLastActive: z.boolean().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    refused: z.boolean(),
    message: z.string(),
    archivedAt: z.string().nullable(),
    activeAtPath: z.number().int(),
    willReopen: z.object({ workspaceId: z.string(), name: z.string().nullable() }).nullable(),
    touchedOthers: z.array(z.string()),
  }),
});

export const terminalsSummarySchema = z.object({
  workspaceId: z.string(),
  count: z.number().int(),
  shells: z.number().int(),
  busy: z.number().int(),
  working: z.number().int(),
  idle: z.number().int(),
  rssBytes: z.number().int(),
  names: z.array(z.string()),
});

export const systemStatsSchema = z.object({
  load1: z.number().nullable(),
  load5: z.number().nullable(),
  load15: z.number().nullable(),
  cpuPercent: z.number().nullable(),
  memTotalBytes: z.number().nullable(),
  memUsedBytes: z.number().nullable(),
  swapTotalBytes: z.number().nullable(),
  swapUsedBytes: z.number().nullable(),
  uptimeSeconds: z.number().nullable(),
});

export type SystemStats = z.infer<typeof systemStatsSchema>;

export const terminalsCloseRpc = defineRpc({
  name: "agent-manager.terminals-close",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    closed: z.array(z.string()),
    failed: z.array(z.object({ terminalId: z.string(), error: z.string() })),
  }),
});

export const workspaceDeleteRpc = defineRpc({
  name: "agent-manager.workspace-delete",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
    deletedAgents: z.array(z.string()),
    failed: z.array(failureSchema),
  }),
});

export const workspaceCloseTabsRpc = defineRpc({
  name: "agent-manager.workspace-close-tabs",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
    closed: z.array(z.string()),
    touchedOthers: z.array(z.string()),
  }),
});

export const workspaceActivateRpc = defineRpc({
  name: "agent-manager.workspace-activate",
  input: z.object({
    workspaceId: z.string(),
    workspaceName: z.string().optional(),
    tabsOnly: z.boolean().optional(),
  }),
  output: z.object({ jobId: z.string() }),
});

export const terminalEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  workspaceId: z.string(),
  cwd: z.string(),
  state: z.string().nullable(),
  attention: z.string().nullable(),
  changedAt: z.number().nullable(),
});

export type TerminalEntryRow = z.infer<typeof terminalEntrySchema>;

export const terminalCloseRpc = defineRpc({
  name: "agent-manager.terminal-close",
  input: z.object({ terminalIds: z.array(z.string()) }),
  output: z.object({
    closed: z.array(z.string()),
    failed: z.array(z.object({ terminalId: z.string(), error: z.string() })),
  }),
});

export const snapshotRpc = defineRpc({
  name: "agent-manager.snapshot",
  input: z.object({}),
  output: z.object({
    overview: overviewPayloadSchema,
    workspaces: z.array(workspaceRowSchema),
    projects: z.array(projectRowSchema),
    terminals: z.array(terminalsSummarySchema),
    terminalList: z.array(terminalEntrySchema),
    system: systemStatsSchema,
    autoRelease: autoReleaseStateSchema,
  }),
});

export const autoReleaseSetRpc = defineRpc({
  name: "agent-manager.auto-release-set",
  input: z.object({
    enabled: z.boolean().optional(),
    idleMinutes: z.number().optional(),
    intervalMinutes: z.number().optional(),
    onLoad: z.enum(["allIdle", "threshold", "off"]).optional(),
    removeEmptyWorkspaces: z.boolean().optional(),
    closeIdleTerminals: z.boolean().optional(),
    terminalIdleMinutes: z.number().optional(),
    archiveIdleMinutes: z.number().optional(),
    staleRunningMinutes: z.number().optional(),
    runNow: z.boolean().optional(),
  }),
  output: autoReleaseStateSchema,
});

export const jobStatusRpc = defineRpc({
  name: "agent-manager.job",
  input: z.object({ jobId: z.string() }),
  output: jobSchema,
});

export type RenameOutcome = RpcOutput<typeof workspaceRenameRpc>;
export type ArchiveOutcome = RpcOutput<typeof workspaceArchiveRpc>;
export type CloseGroupOutcome = RpcOutput<typeof workspaceCloseTabsRpc>;
export type DeleteWorkspaceOutcome = RpcOutput<typeof workspaceDeleteRpc>;
export type ReleaseOutcome = RpcOutput<typeof releaseManyRpc>;
export type DeleteAgentsOutcome = RpcOutput<typeof agentDeleteRpc>;
export type TerminalSummaryRow = z.infer<typeof terminalsSummarySchema>;
export type AutoReleasePatch = RpcInput<typeof autoReleaseSetRpc>;
