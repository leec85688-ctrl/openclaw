import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  seedMainSessionStore,
  withTempHeartbeatSandbox,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

installHeartbeatRunnerTestRuntime();

describe("runHeartbeatOnce ack handling", () => {
  const WHATSAPP_GROUP = "120363140186826074@g.us";
  const TELEGRAM_GROUP = "-1001234567890";

  function createHeartbeatConfig(params: {
    tmpDir: string;
    storePath: string;
    heartbeat: Record<string, unknown>;
    channels: Record<string, unknown>;
    messages?: Record<string, unknown>;
  }): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: params.tmpDir,
          heartbeat: params.heartbeat as never,
        },
      },
      channels: params.channels as never,
      ...(params.messages ? { messages: params.messages as never } : {}),
      session: { store: params.storePath },
    };
  }

  function makeWhatsAppDeps(
    params: {
      sendWhatsApp?: ReturnType<typeof vi.fn>;
      getQueueSize?: () => number;
      nowMs?: () => number;
      webAuthExists?: () => Promise<boolean>;
      hasActiveWebListener?: () => boolean;
    } = {},
  ) {
    return {
      ...(params.sendWhatsApp ? { whatsapp: params.sendWhatsApp as unknown } : {}),
      getQueueSize: params.getQueueSize ?? (() => 0),
      nowMs: params.nowMs ?? (() => 0),
      webAuthExists: params.webAuthExists ?? (async () => true),
      hasActiveWebListener: params.hasActiveWebListener ?? (() => true),
    } satisfies HeartbeatDeps;
  }

  function makeTelegramDeps(
    params: {
      sendTelegram?: ReturnType<typeof vi.fn>;
      getQueueSize?: () => number;
      nowMs?: () => number;
    } = {},
  ) {
    return {
      ...(params.sendTelegram ? { telegram: params.sendTelegram as unknown } : {}),
      getQueueSize: params.getQueueSize ?? (() => 0),
      nowMs: params.nowMs ?? (() => 0),
    } satisfies HeartbeatDeps;
  }

  function createMessageSendSpy(extra: Record<string, unknown> = {}) {
    return vi.fn().mockResolvedValue({
      messageId: "m1",
      toJid: "jid",
      ...extra,
    });
  }

  async function runTelegramHeartbeatWithDefaults(params: {
    tmpDir: string;
    storePath: string;
    replySpy: ReturnType<typeof vi.spyOn>;
    replyText: string;
    messages?: Record<string, unknown>;
    telegramOverrides?: Record<string, unknown>;
  }) {
    const cfg = createHeartbeatConfig({
      tmpDir: params.tmpDir,
      storePath: params.storePath,
      heartbeat: { every: "5m", target: "telegram" },
      channels: {
        telegram: {
          token: "test-token",
          allowFrom: ["*"],
          heartbeat: { showOk: false },
          ...params.telegramOverrides,
        },
      },
      ...(params.messages ? { messages: params.messages } : {}),
    });

    await seedMainSessionStore(params.storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: TELEGRAM_GROUP,
    });

    params.replySpy.mockResolvedValue({ text: params.replyText });
    const sendTelegram = createMessageSendSpy();
    await runHeartbeatOnce({
      cfg,
      deps: makeTelegramDeps({ sendTelegram }),
    });
    return sendTelegram;
  }

  function createWhatsAppHeartbeatConfig(params: {
    tmpDir: string;
    storePath: string;
    heartbeat?: Record<string, unknown>;
    visibility?: Record<string, unknown>;
  }): OpenClawConfig {
    return createHeartbeatConfig({
      tmpDir: params.tmpDir,
      storePath: params.storePath,
      heartbeat: {
        every: "5m",
        target: "whatsapp",
        ...params.heartbeat,
      },
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          ...(params.visibility ? { heartbeat: params.visibility } : {}),
        },
      },
    });
  }

  async function createSeededWhatsAppHeartbeatConfig(params: {
    tmpDir: string;
    storePath: string;
    heartbeat?: Record<string, unknown>;
    visibility?: Record<string, unknown>;
  }): Promise<OpenClawConfig> {
    const cfg = createWhatsAppHeartbeatConfig(params);
    await seedMainSessionStore(params.storePath, cfg, {
      lastChannel: "whatsapp",
      lastProvider: "whatsapp",
      lastTo: WHATSAPP_GROUP,
    });
    return cfg;
  }

  it("respects ackMaxChars for heartbeat acks", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createWhatsAppHeartbeatConfig({
        tmpDir,
        storePath,
        heartbeat: { ackMaxChars: 0 },
      });

      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: WHATSAPP_GROUP,
      });

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK 🦞" });
      const sendWhatsApp = createMessageSendSpy();

      await runHeartbeatOnce({
        cfg,
        deps: makeWhatsAppDeps({ sendWhatsApp }),
      });

      expect(sendWhatsApp).toHaveBeenCalled();
    });
  });

  it("sends HEARTBEAT_OK when visibility.showOk is true", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createWhatsAppHeartbeatConfig({
        tmpDir,
        storePath,
        visibility: { showOk: true },
      });

      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: WHATSAPP_GROUP,
      });

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
      const sendWhatsApp = createMessageSendSpy();

      await runHeartbeatOnce({
        cfg,
        deps: makeWhatsAppDeps({ sendWhatsApp }),
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith(WHATSAPP_GROUP, "HEARTBEAT_OK", expect.any(Object));
    });
  });

  it.each([
    {
      title: "does not deliver HEARTBEAT_OK to telegram when showOk is false",
      replyText: "HEARTBEAT_OK",
      expectedCalls: 0,
    },
    {
      title: "strips responsePrefix before HEARTBEAT_OK detection and suppresses short ack text",
      replyText: "[openclaw] HEARTBEAT_OK all good",
      messages: { responsePrefix: "[openclaw]" },
      expectedCalls: 0,
    },
    {
      title: "does not strip alphanumeric responsePrefix from larger words",
      replyText: "History check complete",
      messages: { responsePrefix: "Hi" },
      expectedCalls: 1,
      expectedText: "History check complete",
    },
  ])("$title", async ({ replyText, messages, expectedCalls, expectedText }) => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const sendTelegram = await runTelegramHeartbeatWithDefaults({
        tmpDir,
        storePath,
        replySpy,
        replyText,
        messages,
      });

      expect(sendTelegram).toHaveBeenCalledTimes(expectedCalls);
      if (expectedText) {
        expect(sendTelegram).toHaveBeenCalledWith(TELEGRAM_GROUP, expectedText, expect.any(Object));
      }
    });
  });

  it("skips heartbeat LLM calls when visibility disables all output", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createWhatsAppHeartbeatConfig({
        tmpDir,
        storePath,
        visibility: { showOk: false, showAlerts: false, useIndicator: false },
      });

      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: WHATSAPP_GROUP,
      });

      const sendWhatsApp = createMessageSendSpy();

      const result = await runHeartbeatOnce({
        cfg,
        deps: makeWhatsAppDeps({ sendWhatsApp }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(sendWhatsApp).not.toHaveBeenCalled();
      expect(result).toEqual({ status: "skipped", reason: "alerts-disabled" });
    });
  });

  it("skips delivery for markup-wrapped HEARTBEAT_OK", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = await createSeededWhatsAppHeartbeatConfig({
        tmpDir,
        storePath,
      });

      replySpy.mockResolvedValue({ text: "<b>HEARTBEAT_OK</b>" });
      const sendWhatsApp = createMessageSendSpy();

      await runHeartbeatOnce({
        cfg,
        deps: makeWhatsAppDeps({ sendWhatsApp }),
      });

      expect(sendWhatsApp).not.toHaveBeenCalled();
    });
  });

  it("retries once when heartbeat only reports pending work in Chinese", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = await createSeededWhatsAppHeartbeatConfig({
        tmpDir,
        storePath,
      });

      replySpy
        .mockResolvedValueOnce({
          text: "今日招标日报仍未生成；browser 已恢复可用，系统其余正常，需继续执行招标监控。",
        })
        .mockResolvedValueOnce({
          text: "已补跑今日招标监控并生成日报。",
        });
      const sendWhatsApp = createMessageSendSpy();

      await runHeartbeatOnce({
        cfg,
        deps: makeWhatsAppDeps({ sendWhatsApp }),
      });

      expect(replySpy).toHaveBeenCalledTimes(2);
      expect(replySpy.mock.calls[1]?.[0]?.Body).toContain(
        "Your previous response was only a status update",
      );
      expect(sendWhatsApp).toHaveBeenCalledWith(
        WHATSAPP_GROUP,
        "已补跑今日招标监控并生成日报。",
        expect.any(Object),
      );
    });
  });

  it("retries twice and hardens the second follow-up when pending work repeats", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = await createSeededWhatsAppHeartbeatConfig({
        tmpDir,
        storePath,
      });

      replySpy
        .mockResolvedValueOnce({
          text: "\u4eca\u65e5\u62db\u6807\u65e5\u62a5\u4ecd\u672a\u751f\u6210\uff1bbrowser \u5df2\u6062\u590d\u53ef\u7528\uff0c\u9700\u7ee7\u7eed\u6267\u884c\u3002",
        })
        .mockResolvedValueOnce({
          text: "\u4eca\u65e5\u62a5\u544a\u4ecd\u672a\u751f\u6210\uff0c\u9700\u7ee7\u7eed\u76d1\u63a7\u3002",
        })
        .mockResolvedValueOnce({
          text: "\u5df2\u5b8c\u6210\u8865\u8dd1\uff0c\u62a5\u544a\u8def\u5f84\uff1a/Users/kobe2026/.openclaw/workspace/reports/2026-03-20.md",
        });
      const sendWhatsApp = createMessageSendSpy();

      await runHeartbeatOnce({
        cfg,
        deps: makeWhatsAppDeps({ sendWhatsApp }),
      });

      expect(replySpy).toHaveBeenCalledTimes(3);
      expect(replySpy.mock.calls[2]?.[0]?.Body).toContain("do not re-read HEARTBEAT.md");
      expect(sendWhatsApp).toHaveBeenCalledWith(
        WHATSAPP_GROUP,
        "\u5df2\u5b8c\u6210\u8865\u8dd1\uff0c\u62a5\u544a\u8def\u5f84\uff1a/Users/kobe2026/.openclaw/workspace/reports/2026-03-20.md",
        expect.any(Object),
      );
    });
  });

  it("does not fall back to the original interim text when the retry returns empty", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = await createSeededWhatsAppHeartbeatConfig({
        tmpDir,
        storePath,
      });

      replySpy
        .mockResolvedValueOnce({
          text: "\u4eca\u65e5\u62db\u6807\u65e5\u62a5\u4ecd\u672a\u751f\u6210\uff0c\u9700\u7ee7\u7eed\u6267\u884c\u3002",
        })
        .mockResolvedValueOnce(undefined);
      const sendWhatsApp = createMessageSendSpy();

      await runHeartbeatOnce({
        cfg,
        deps: makeWhatsAppDeps({ sendWhatsApp }),
      });

      expect(replySpy).toHaveBeenCalledTimes(2);
      expect(sendWhatsApp).not.toHaveBeenCalled();
    });
  });

  it("refreshes BodyForAgent on retries even if getReplyFromConfig mutated the prior context", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = await createSeededWhatsAppHeartbeatConfig({
        tmpDir,
        storePath,
      });

      replySpy
        .mockImplementationOnce(async (ctx: { Body: string; BodyForAgent?: string }) => {
          ctx.BodyForAgent = ctx.Body;
          return {
            text: "\u4eca\u65e5\u62db\u6807\u65e5\u62a5\u4ecd\u672a\u751f\u6210\uff0c\u9700\u7ee7\u7eed\u6267\u884c\u3002",
          };
        })
        .mockResolvedValueOnce({
          text: "\u5df2\u8865\u8dd1\u5b8c\u6210\uff0c\u62a5\u544a\u5df2\u751f\u6210\u3002",
        });
      const sendWhatsApp = createMessageSendSpy();

      await runHeartbeatOnce({
        cfg,
        deps: makeWhatsAppDeps({ sendWhatsApp }),
      });

      expect(replySpy).toHaveBeenCalledTimes(2);
      expect(replySpy.mock.calls[1]?.[0]?.BodyForAgent).toContain(
        "Your previous response was only a status update",
      );
      expect(sendWhatsApp).toHaveBeenCalledWith(
        WHATSAPP_GROUP,
        "\u5df2\u8865\u8dd1\u5b8c\u6210\uff0c\u62a5\u544a\u5df2\u751f\u6210\u3002",
        expect.any(Object),
      );
    });
  });

  it("does not regress updatedAt when restoring heartbeat sessions", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const originalUpdatedAt = 1000;
      const bumpedUpdatedAt = 2000;
      const cfg = createWhatsAppHeartbeatConfig({
        tmpDir,
        storePath,
      });

      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        updatedAt: originalUpdatedAt,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: WHATSAPP_GROUP,
      });

      replySpy.mockImplementationOnce(async () => {
        const raw = await fs.readFile(storePath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, { updatedAt?: number } | undefined>;
        if (parsed[sessionKey]) {
          parsed[sessionKey] = {
            ...parsed[sessionKey],
            updatedAt: bumpedUpdatedAt,
          };
        }
        await fs.writeFile(storePath, JSON.stringify(parsed, null, 2));
        return { text: "" };
      });

      await runHeartbeatOnce({
        cfg,
        deps: makeWhatsAppDeps(),
      });

      const finalStore = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        { updatedAt?: number } | undefined
      >;
      expect(finalStore[sessionKey]?.updatedAt).toBe(bumpedUpdatedAt);
    });
  });

  it("skips WhatsApp delivery when not linked or running", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = await createSeededWhatsAppHeartbeatConfig({
        tmpDir,
        storePath,
      });

      replySpy.mockResolvedValue({ text: "Heartbeat alert" });
      const sendWhatsApp = createMessageSendSpy();

      const res = await runHeartbeatOnce({
        cfg,
        deps: makeWhatsAppDeps({
          sendWhatsApp,
          webAuthExists: async () => false,
          hasActiveWebListener: () => false,
        }),
      });

      expect(res.status).toBe("skipped");
      expect(res).toMatchObject({ reason: "whatsapp-not-linked" });
      expect(sendWhatsApp).not.toHaveBeenCalled();
    });
  });

  async function expectTelegramHeartbeatAccountId(params: {
    heartbeat: Record<string, unknown>;
    telegram: Record<string, unknown>;
    expectedAccountId: string | undefined;
  }): Promise<void> {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createHeartbeatConfig({
        tmpDir,
        storePath,
        heartbeat: params.heartbeat,
        channels: { telegram: params.telegram },
      });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });

      replySpy.mockResolvedValue({ text: "Hello from heartbeat" });
      const sendTelegram = createMessageSendSpy({ chatId: TELEGRAM_GROUP });

      await runHeartbeatOnce({
        cfg,
        deps: makeTelegramDeps({ sendTelegram }),
      });

      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        TELEGRAM_GROUP,
        "Hello from heartbeat",
        expect.objectContaining({ accountId: params.expectedAccountId, verbose: false }),
      );
    });
  }

  it.each([
    {
      title: "passes through accountId for telegram heartbeats",
      heartbeat: { every: "5m", target: "telegram" },
      telegram: { botToken: "test-bot-token-123" },
      expectedAccountId: undefined,
    },
    {
      title: "does not pre-resolve telegram accountId (allows config-only account tokens)",
      heartbeat: { every: "5m", target: "telegram" },
      telegram: {
        accounts: {
          work: { botToken: "test-bot-token-123" },
        },
      },
      expectedAccountId: undefined,
    },
    {
      title: "uses explicit heartbeat accountId for telegram delivery",
      heartbeat: { every: "5m", target: "telegram", accountId: "work" },
      telegram: {
        accounts: {
          work: { botToken: "test-bot-token-123" },
        },
      },
      expectedAccountId: "work",
    },
  ])("$title", async ({ heartbeat, telegram, expectedAccountId }) => {
    await expectTelegramHeartbeatAccountId({ heartbeat, telegram, expectedAccountId });
  });
});
