import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadWorkspaceSkillEntriesMock = vi.fn();
const bumpSkillsSnapshotVersionMock = vi.fn();
const listAgentWorkspaceDirsMock = vi.fn();
const listNodePairingMock = vi.fn();
const updatePairedNodeMetadataMock = vi.fn();

vi.mock("../agents/skills.js", () => ({
  loadWorkspaceSkillEntries: (...args: unknown[]) => loadWorkspaceSkillEntriesMock(...args),
}));

vi.mock("../agents/skills/refresh.js", () => ({
  bumpSkillsSnapshotVersion: (...args: unknown[]) => bumpSkillsSnapshotVersionMock(...args),
}));

vi.mock("../agents/workspace-dirs.js", () => ({
  listAgentWorkspaceDirs: (...args: unknown[]) => listAgentWorkspaceDirsMock(...args),
}));

vi.mock("./node-pairing.js", () => ({
  listNodePairing: (...args: unknown[]) => listNodePairingMock(...args),
  updatePairedNodeMetadata: (...args: unknown[]) => updatePairedNodeMetadataMock(...args),
}));

import {
  getRemoteSkillEligibility,
  recordRemoteNodeBins,
  recordRemoteNodeInfo,
  refreshRemoteNodeBins,
  removeRemoteNodeInfo,
  setSkillsRemoteRegistry,
} from "./skills-remote.js";

describe("skills-remote", () => {
  beforeEach(() => {
    vi.useRealTimers();
    loadWorkspaceSkillEntriesMock.mockReset();
    bumpSkillsSnapshotVersionMock.mockReset();
    listAgentWorkspaceDirsMock.mockReset();
    listNodePairingMock.mockReset();
    updatePairedNodeMetadataMock.mockReset();
    listAgentWorkspaceDirsMock.mockReturnValue(["/tmp/mock-workspace"]);
    loadWorkspaceSkillEntriesMock.mockReturnValue([
      {
        metadata: {
          requires: {
            bins: ["python3"],
          },
        },
      },
    ]);
    updatePairedNodeMetadataMock.mockResolvedValue(undefined);
    setSkillsRemoteRegistry(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    setSkillsRemoteRegistry(null);
  });

  it("removes disconnected nodes from remote skill eligibility", () => {
    const nodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    recordRemoteNodeInfo({
      nodeId,
      displayName: "Remote Mac",
      platform: "darwin",
      commands: ["system.run"],
    });
    recordRemoteNodeBins(nodeId, [bin]);

    expect(getRemoteSkillEligibility()?.hasBin(bin)).toBe(true);

    removeRemoteNodeInfo(nodeId);

    expect(getRemoteSkillEligibility()?.hasBin(bin) ?? false).toBe(false);
  });

  it("supports idempotent remote node removal", () => {
    const nodeId = `node-${randomUUID()}`;
    expect(() => {
      removeRemoteNodeInfo(nodeId);
      removeRemoteNodeInfo(nodeId);
    }).not.toThrow();
  });

  it("ignores non-mac and non-system.run nodes for eligibility", () => {
    const linuxNodeId = `node-${randomUUID()}`;
    const noRunNodeId = `node-${randomUUID()}`;
    const bin = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId: linuxNodeId,
        displayName: "Linux Box",
        platform: "linux",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(linuxNodeId, [bin]);

      recordRemoteNodeInfo({
        nodeId: noRunNodeId,
        displayName: "Remote Mac",
        platform: "darwin",
        commands: ["system.which"],
      });
      recordRemoteNodeBins(noRunNodeId, [bin]);

      expect(getRemoteSkillEligibility()).toBeUndefined();
    } finally {
      removeRemoteNodeInfo(linuxNodeId);
      removeRemoteNodeInfo(noRunNodeId);
    }
  });

  it("aggregates bins and note labels across eligible mac nodes", () => {
    const nodeA = `node-${randomUUID()}`;
    const nodeB = `node-${randomUUID()}`;
    const binA = `bin-${randomUUID()}`;
    const binB = `bin-${randomUUID()}`;
    try {
      recordRemoteNodeInfo({
        nodeId: nodeA,
        displayName: "Mac Studio",
        platform: "darwin",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeA, [binA]);

      recordRemoteNodeInfo({
        nodeId: nodeB,
        platform: "macOS",
        commands: ["system.run"],
      });
      recordRemoteNodeBins(nodeB, [binB]);

      const eligibility = getRemoteSkillEligibility();
      expect(eligibility?.platforms).toEqual(["darwin"]);
      expect(eligibility?.hasBin(binA)).toBe(true);
      expect(eligibility?.hasAnyBin([`missing-${randomUUID()}`, binB])).toBe(true);
      expect(eligibility?.note).toContain("Mac Studio");
      expect(eligibility?.note).toContain(nodeB);
    } finally {
      removeRemoteNodeInfo(nodeA);
      removeRemoteNodeInfo(nodeB);
    }
  });

  it("retries timed-out remote bin probes once and updates bins on success", async () => {
    vi.useFakeTimers();
    const nodeId = `node-${randomUUID()}`;
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { message: "node invoke timed out" },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          bins: ["python3"],
        },
      });
    setSkillsRemoteRegistry({ invoke } as never);

    await refreshRemoteNodeBins({
      nodeId,
      platform: "darwin",
      commands: ["system.which"],
      cfg: {} as never,
    });
    expect(invoke).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(updatePairedNodeMetadataMock).toHaveBeenCalledWith(nodeId, {
      bins: ["python3"],
    });
  });

  it("does not retry timed-out remote bin probes more than once per refresh", async () => {
    vi.useFakeTimers();
    const nodeId = `node-${randomUUID()}`;
    const invoke = vi.fn().mockResolvedValue({
      ok: false,
      error: { message: "node invoke timed out" },
    });
    setSkillsRemoteRegistry({ invoke } as never);

    await refreshRemoteNodeBins({
      nodeId,
      platform: "darwin",
      commands: ["system.which"],
      cfg: {} as never,
    });
    expect(invoke).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(invoke).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
