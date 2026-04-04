import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

const hoisted = vi.hoisted(() => ({
  testConfigDir: "/tmp/openclaw-browser-launch-ready-test",
  spawnMock: vi.fn(),
  ensurePortAvailableMock: vi.fn(async () => undefined),
  resolveExecutableMock: vi.fn(() => ({
    kind: "chrome",
    path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  })),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: hoisted.spawnMock,
  };
});

vi.mock("../infra/ports.js", () => ({
  ensurePortAvailable: hoisted.ensurePortAvailableMock,
}));

vi.mock("../utils.js", () => ({
  CONFIG_DIR: hoisted.testConfigDir,
}));

vi.mock("./chrome.executables.js", () => ({
  resolveBrowserExecutableForPlatform: hoisted.resolveExecutableMock,
}));

vi.mock("./chrome.profile-decoration.js", () => ({
  decorateOpenClawProfile: vi.fn(),
  ensureProfileCleanExit: vi.fn(),
  isProfileDecorated: vi.fn(() => true),
}));

import { launchOpenClawChrome } from "./chrome.js";

function makeChromeProc(stderrLine: string) {
  const proc = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stderr = new EventEmitter();
  Object.assign(proc, {
    pid: 43210,
    stderr,
    kill: vi.fn(),
    exitCode: null,
    killed: false,
  });
  setTimeout(() => {
    stderr.emit("data", Buffer.from(`${stderrLine}\n`, "utf8"));
  }, 0);
  return proc;
}

describe("browser chrome launch readiness", () => {
  beforeEach(async () => {
    await fsp.rm(hoisted.testConfigDir, { recursive: true, force: true });
    hoisted.spawnMock.mockReset();
    hoisted.ensurePortAvailableMock.mockClear();
    hoisted.resolveExecutableMock.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fsp.rm(hoisted.testConfigDir, { recursive: true, force: true });
  });

  it("accepts Chrome startup when stderr exposes a working DevTools websocket before /json/version is reachable", async () => {
    const cdpPort = 18991;
    const wsPath = "/devtools/browser/fallback-ready";
    const wsUrl = `ws://127.0.0.1:${cdpPort}${wsPath}`;
    const userDataDir = path.join(hoisted.testConfigDir, "browser", "openclaw", "user-data");

    await fsp.mkdir(path.join(userDataDir, "Default"), { recursive: true });
    await fsp.writeFile(path.join(userDataDir, "Local State"), "{}", "utf8");
    await fsp.writeFile(path.join(userDataDir, "Default", "Preferences"), "{}", "utf8");

    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: cdpPort,
      path: wsPath,
    });
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        let message: { id?: unknown; method?: unknown } | null = null;
        try {
          message = JSON.parse(String(raw)) as { id?: unknown; method?: unknown };
        } catch {
          return;
        }
        if (message?.id === 1 && message.method === "Browser.getVersion") {
          ws.send(JSON.stringify({ id: 1, result: { product: "Chrome/Mock" } }));
        }
      });
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("not ready yet")));
    hoisted.spawnMock.mockImplementation(() => makeChromeProc(`DevTools listening on ${wsUrl}`));

    try {
      const running = await launchOpenClawChrome(
        {
          headless: true,
          noSandbox: false,
          extraArgs: [],
        } as Parameters<typeof launchOpenClawChrome>[0],
        {
          name: "openclaw",
          cdpPort,
          cdpUrl: `http://127.0.0.1:${cdpPort}`,
          cdpIsLoopback: true,
          color: "#FF4500",
        } as Parameters<typeof launchOpenClawChrome>[1],
      );

      expect(running.pid).toBe(43210);
      expect(hoisted.ensurePortAvailableMock).toHaveBeenCalledWith(cdpPort);
      expect(hoisted.spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
