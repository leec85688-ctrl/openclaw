import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  countActiveDescendantRunsMock,
  listDescendantRunsForRequesterMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  pickLastNonEmptyTextFromPayloadsMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — interim ack retry", () => {
  setupRunCronIsolatedAgentTurnSuite();

  const runTurnAndExpectOk = async (expectedFallbackCalls: number, expectedAgentCalls: number) => {
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());
    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(expectedFallbackCalls);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(expectedAgentCalls);
    return result;
  };

  const usePayloadTextExtraction = () => {
    pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
      (payloads?: Array<{ text?: string }>) => {
        for (let idx = (payloads?.length ?? 0) - 1; idx >= 0; idx -= 1) {
          const text = payloads?.[idx]?.text;
          if (typeof text === "string" && text.trim()) {
            return text;
          }
        }
        return "";
      },
    );
  };

  it("regression, retries once when cron returns interim acknowledgement and no descendants were spawned", async () => {
    usePayloadTextExtraction();
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [
          {
            text: "On it, grabbing current SF and SD weather now and I will summarize right after both come back.",
          },
        ],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "SF is 62F and SD is 67F. SD is warmer by 5F." }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      });

    mockRunCronFallbackPassthrough();
    await runTurnAndExpectOk(2, 2);
    expect(runEmbeddedPiAgentMock.mock.calls[1]?.[0]?.prompt).toContain(
      "previous response was only an acknowledgement",
    );
  });

  it("does not retry when the first turn is already a concrete result", async () => {
    usePayloadTextExtraction();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "SF is 62F and SD is 67F. SD is warmer by 5F." }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    mockRunCronFallbackPassthrough();
    await runTurnAndExpectOk(1, 1);
  });

  it("does not retry when descendants were spawned in this run even if they already settled", async () => {
    usePayloadTextExtraction();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "On it, I spawned a subagent and it will auto-announce when done." }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });
    listDescendantRunsForRequesterMock.mockReturnValue([
      {
        startedAt: Date.now() + 60_000,
      },
    ]);
    countActiveDescendantRunsMock.mockReturnValue(0);

    mockRunCronFallbackPassthrough();
    await runTurnAndExpectOk(1, 1);
  });

  it("retries once when a Chinese heartbeat status only reports pending work", async () => {
    usePayloadTextExtraction();
    runEmbeddedPiAgentMock
      .mockResolvedValueOnce({
        payloads: [
          {
            text: "\u4eca\u65e5\u62db\u6807\u65e5\u62a5\u4ecd\u672a\u751f\u6210\uff1bbrowser \u5df2\u6062\u590d\u53ef\u7528\uff0c\u7cfb\u7edf\u5176\u4f59\u6b63\u5e38\uff0c\u9700\u7ee7\u7eed\u6267\u884c\u62db\u6807\u76d1\u63a7\u3002",
          },
        ],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      })
      .mockResolvedValueOnce({
        payloads: [{ text: "\u5df2\u8865\u8dd1\u4eca\u65e5\u62db\u6807\u76d1\u63a7\u5e76\u751f\u6210\u65e5\u62a5\u3002" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      });

    mockRunCronFallbackPassthrough();
    await runTurnAndExpectOk(2, 2);
    expect(runEmbeddedPiAgentMock.mock.calls[1]?.[0]?.prompt).toContain(
      "previous response was only an acknowledgement",
    );
  });
});
