import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeRegistry } from "./node-registry.js";

describe("NodeRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to nested system.run params timeoutMs when top-level timeoutMs is omitted", async () => {
    vi.useFakeTimers();

    const registry = new NodeRegistry();
    registry.register(
      {
        connId: "conn-1",
        socket: { send: vi.fn() },
        connect: {
          device: { id: "node-1" },
          client: { id: "node-1" },
          caps: [],
          commands: ["system.run"],
        },
      } as never,
      {},
    );

    let settled = false;
    const invokePromise = registry
      .invoke({
        nodeId: "node-1",
        command: "system.run",
        params: { command: ["echo", "hi"], timeoutMs: 12 },
      })
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.advanceTimersByTimeAsync(11);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(invokePromise).resolves.toMatchObject({
      ok: false,
      error: { code: "TIMEOUT", message: "node invoke timed out" },
    });
  });

  it("cancels pending invokes when the requester connection disconnects", async () => {
    const send = vi.fn();
    const registry = new NodeRegistry();
    registry.register(
      {
        connId: "conn-1",
        socket: { send },
        connect: {
          device: { id: "node-1" },
          client: { id: "node-1" },
          caps: [],
          commands: ["system.run"],
        },
      } as never,
      {},
    );

    const invokePromise = registry.invoke({
      nodeId: "node-1",
      command: "system.run",
      params: { command: ["echo", "hi"] },
      requesterConnId: "caller-1",
    });

    expect(registry.cancelByRequesterConnId("caller-1")).toEqual({
      canceled: 1,
      requestIds: expect.any(Array),
    });

    await expect(invokePromise).resolves.toMatchObject({
      ok: false,
      error: { code: "CANCELED", message: "node invoke canceled" },
    });

    const sentEvents = send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as { event?: string });
    expect(sentEvents.map((entry) => entry.event)).toEqual([
      "node.invoke.request",
      "node.invoke.cancel",
    ]);
  });
});
