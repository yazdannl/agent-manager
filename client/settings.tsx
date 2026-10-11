import { Pressable, Text, View } from "react-native";

import type { AutoReleaseSnapshot } from "../shared/contracts";
import { formatTime } from "./format";
import type { StyleMap } from "./styles";

export interface AutoReleasePatch {
  enabled?: boolean;
  idleMinutes?: number;
  intervalMinutes?: number;
  onLoad?: "allIdle" | "threshold" | "off";
  removeEmptyWorkspaces?: boolean;
  closeIdleTerminals?: boolean;
  terminalIdleMinutes?: number;
  archiveIdleMinutes?: number;
  staleRunningMinutes?: number;
  runNow?: boolean;
}

const IDLE_PRESETS = [5, 10, 15, 30, 60];
const TERMINAL_PRESETS = [15, 30, 60, 120];
const ARCHIVE_PRESETS = [0, 60, 360, 1440, 4320];
const STALE_RUNNING_PRESETS = [0, 5, 15, 60];
const ON_LOAD_MODES: Array<{ id: AutoReleaseSnapshot["onLoad"]; label: string }> = [
  { id: "threshold", label: "Respect timer" },
  { id: "allIdle", label: "All idle" },
  { id: "off", label: "Do nothing" },
];

export function settingsSummary(state: AutoReleaseSnapshot | undefined): string {
  if (!state) {
    return "";
  }
  return [
    state.enabled ? `idle ${state.idleMinutes}m` : "off",
    state.archiveIdleMinutes > 0 ? `archive ${formatMinutes(state.archiveIdleMinutes)}` : null,
    state.lastRunAt ? `last sweep ${formatTime(state.lastRunAt)}` : "no sweep yet",
    state.lastReleased.length > 0 ? `${state.lastReleased.length} released` : null,
    state.lastArchived.length > 0 ? `${state.lastArchived.length} archived` : null,
    state.lastReapedStale.length > 0 ? `${state.lastReapedStale.length} stale reaped` : null,
    state.lastClosedTerminals > 0 ? `${state.lastClosedTerminals} terminal(s) closed` : null,
    state.lastSkipped > 0 ? `${state.lastSkipped} waiting on you` : null,
    state.nextRunAt ? `next ${formatCountdown(state.nextRunAt)}` : null,
    state.lastError ? `error: ${state.lastError}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

export function SettingsSection({
  state,
  pending,
  onPatch,
  styles,
  compact,
  scope,
  onScope,
  unarchivedCount,
  recordCount,
}: {
  state: AutoReleaseSnapshot | undefined;
  pending: boolean;
  onPatch: (patch: AutoReleasePatch) => void;
  styles: StyleMap;
  compact: boolean;
  scope: "unarchived" | "all";
  onScope: (scope: "unarchived" | "all") => void;
  unarchivedCount: number;
  recordCount: number;
}) {
  if (!state) {
    return null;
  }

  const segmented = (
    key: string,
    options: readonly { id: string; label: string }[],
    value: string,
    onSelect: (id: string) => void,
  ) => (
    <View key={key} style={styles.segment}>
      {options.map((option, index) => {
        const active = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            disabled={pending}
            style={[
              styles.segmentItem,
              index === 0 ? styles.segmentItemFirst : null,
              active ? styles.segmentItemActive : null,
              pending ? styles.disabled : null,
            ]}
            onPress={() => onSelect(option.id)}
          >
            <Text style={active ? styles.segmentTextActive : styles.segmentText} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <View style={styles.settingsPanel}>
      <View style={styles.autoRow}>
        <Text style={styles.autoLabel}>Show</Text>
        {segmented(
          "scope",
          [
            { id: "unarchived", label: `Unarchived (${unarchivedCount})` },
            { id: "all", label: `All (${recordCount})` },
          ],
          scope,
          (id) => onScope(id === "all" ? "all" : "unarchived"),
        )}
      </View>
      <Text style={styles.autoStatus}>
        Unarchived hides archived workspaces and sessions; All shows every record.
      </Text>
      <View style={styles.autoDivider} />
      <View style={styles.autoRow}>
        <Text style={styles.autoLabel}>Auto-release</Text>
        {segmented(
          "enabled",
          [
            { id: "on", label: "On" },
            { id: "off", label: "Off" },
          ],
          state.enabled ? "on" : "off",
          (id) => onPatch({ enabled: id === "on" }),
        )}
      </View>
      <View style={styles.autoDivider} />
      <View style={styles.autoRow}>
        <Text style={styles.autoLabel}>Release idle after</Text>
        {segmented(
          "idle",
          IDLE_PRESETS.map((minutes) => ({ id: `${minutes}`, label: `${minutes}m` })),
          `${state.idleMinutes}`,
          (id) => onPatch({ idleMinutes: Number(id) }),
        )}
      </View>
      <View style={styles.autoDivider} />
      <View style={styles.autoRow}>
        <Text style={styles.autoLabel}>Archive released after</Text>
        {segmented(
          "archive-idle",
          ARCHIVE_PRESETS.map((minutes) => ({
            id: `${minutes}`,
            label: minutes === 0 ? "Off" : formatMinutes(minutes),
          })),
          `${state.archiveIdleMinutes}`,
          (id) => onPatch({ archiveIdleMinutes: Number(id) }),
        )}
      </View>
      <View style={styles.autoDivider} />
      <View style={styles.autoRow}>
        <Text style={styles.autoLabel}>Reap stale running after</Text>
        {segmented(
          "stale-running",
          STALE_RUNNING_PRESETS.map((minutes) => ({
            id: `${minutes}`,
            label: minutes === 0 ? "Off" : `${minutes}m`,
          })),
          `${state.staleRunningMinutes}`,
          (id) => onPatch({ staleRunningMinutes: Number(id) }),
        )}
      </View>
      <View style={styles.autoDivider} />
      <View style={styles.autoRow}>
        <Text style={styles.autoLabel}>After a reload</Text>
        {segmented("load", ON_LOAD_MODES, state.onLoad, (id) =>
          onPatch({ onLoad: id as AutoReleaseSnapshot["onLoad"] }),
        )}
      </View>
      <View style={styles.autoDivider} />
      <View style={styles.autoRow}>
        <Text style={styles.autoLabel}>Remove empty workspaces</Text>
        {segmented(
          "empty",
          [
            { id: "on", label: "On" },
            { id: "off", label: "Off" },
          ],
          state.removeEmptyWorkspaces ? "on" : "off",
          (id) => onPatch({ removeEmptyWorkspaces: id === "on" }),
        )}
      </View>
      <View style={styles.autoDivider} />
      <View style={styles.autoRow}>
        <Text style={styles.autoLabel}>Close idle terminals</Text>
        {segmented(
          "terminals",
          [
            { id: "on", label: "On" },
            { id: "off", label: "Off" },
          ],
          state.closeIdleTerminals ? "on" : "off",
          (id) => onPatch({ closeIdleTerminals: id === "on" }),
        )}
      </View>
      {state.closeIdleTerminals ? (
        <>
          <View style={styles.autoDivider} />
          <View style={styles.autoRow}>
            <Text style={styles.autoLabel}>Terminal idle for</Text>
            {segmented(
              "terminal-idle",
              TERMINAL_PRESETS.map((minutes) => ({
                id: `${minutes}`,
                label: minutes < 60 ? `${minutes}m` : `${minutes / 60}h`,
              })),
              `${state.terminalIdleMinutes}`,
              (id) => onPatch({ terminalIdleMinutes: Number(id) }),
            )}
          </View>
        </>
      ) : null}
      <View style={styles.autoDivider} />
      <View style={styles.autoRow}>
        <Text style={styles.autoLabel}>Sweep now</Text>
        <Pressable
          accessibilityRole="button"
          disabled={pending}
          style={[styles.chip, pending ? styles.disabled : null]}
          onPress={() => onPatch({ runNow: true })}
        >
          <Text style={styles.chipText}>Run now</Text>
        </Pressable>
      </View>
      <Text style={state.lastError ? styles.autoStatusWarn : styles.autoStatus} numberOfLines={3}>
        {settingsSummary(state)}
      </Text>
    </View>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes >= 1440) {
    return `${Math.round(minutes / 1440)}d`;
  }
  if (minutes >= 60) {
    return `${Math.round(minutes / 60)}h`;
  }
  return `${minutes}m`;
}

function formatCountdown(value: string): string {
  const target = Date.parse(value);
  if (!Number.isFinite(target)) {
    return "—";
  }
  const minutes = Math.round((target - Date.now()) / 60000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.round(minutes / 60)}h`;
}
