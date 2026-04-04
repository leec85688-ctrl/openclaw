import { describe, expect, it } from "vitest";
import { hasSessionWorkspaceDrift } from "./session.js";

function createSystemPromptReport(workspaceDir: string) {
  return {
    source: "run" as const,
    generatedAt: Date.now(),
    workspaceDir,
    systemPrompt: {
      chars: 0,
      projectContextChars: 0,
      nonProjectContextChars: 0,
    },
    injectedWorkspaceFiles: [],
    skills: {
      promptChars: 0,
      entries: [],
    },
    tools: {
      listChars: 0,
      schemaChars: 0,
      entries: [],
    },
  };
}

describe("hasSessionWorkspaceDrift", () => {
  it("returns false when no prior workspace was persisted", () => {
    expect(
      hasSessionWorkspaceDrift({
        sessionEntry: undefined,
        workspaceDir: "/Users/kobe2026/.openclaw/workspace-intel",
      }),
    ).toBe(false);
  });

  it("returns false when the persisted workspace matches the expected workspace", () => {
    expect(
      hasSessionWorkspaceDrift({
        sessionEntry: {
          systemPromptReport: createSystemPromptReport(
            "/Users/kobe2026/.openclaw/workspace-intel",
          ),
        },
        workspaceDir: "/Users/kobe2026/.openclaw/workspace-intel",
      }),
    ).toBe(false);
  });

  it("returns true when the persisted workspace differs from the expected workspace", () => {
    expect(
      hasSessionWorkspaceDrift({
        sessionEntry: {
          systemPromptReport: createSystemPromptReport(
            "/Users/kobe2026/.openclaw/workspace-learn",
          ),
        },
        workspaceDir: "/Users/kobe2026/.openclaw/workspace-intel",
      }),
    ).toBe(true);
  });
});
