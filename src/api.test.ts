import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatCommandError,
  getCommandErrorCode,
  loadWorkspaceFromStorage,
  saveWorkspaceToStorage,
} from "./api";
import type { WorkspaceRecord } from "./types";

const storage = new Map<string, string>();

vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
});

afterEach(() => {
  storage.clear();
});

describe("loadWorkspaceFromStorage", () => {
  it("returns a default workspace for corrupt JSON", async () => {
    localStorage.setItem("grok-web.workspace", "{broken");
    const workspace = await loadWorkspaceFromStorage();
    expect(workspace.projects).toHaveLength(1);
    expect(workspace.threads).toEqual([]);
  });

  it("filters malformed entries and preserves valid workspace records", async () => {
    const validWorkspace: WorkspaceRecord = {
      projects: [
        {
          id: "project-1",
          name: "Grok",
          createdAt: "2026-03-16T10:00:00.000Z",
          updatedAt: "2026-03-16T10:00:00.000Z",
        },
      ],
      threads: [
        {
          id: "thread-1",
          projectId: "project-1",
          title: "Hello",
          createdAt: "2026-03-16T10:00:00.000Z",
          updatedAt: "2026-03-16T10:00:00.000Z",
          lastResponseId: "resp-1",
          continuationLost: false,
          contextStatus: "normal",
          contextDetail: null,
          messages: [],
        },
      ],
    };

    await saveWorkspaceToStorage(validWorkspace);
    await expect(loadWorkspaceFromStorage()).resolves.toEqual(validWorkspace);
  });

  it("hydrates legacy flat thread storage into a default project", async () => {
    localStorage.setItem(
      "grok-web.threads",
      JSON.stringify([
        {
          id: "thread-legacy",
          title: "Legacy",
          createdAt: "2026-03-16T10:00:00.000Z",
          updatedAt: "2026-03-16T10:00:00.000Z",
          messages: [],
        },
      ]),
    );

    const workspace = await loadWorkspaceFromStorage();
    expect(workspace.projects).toHaveLength(1);
    expect(workspace.threads).toHaveLength(1);
    expect(workspace.threads[0].projectId).toBe(workspace.projects[0].id);
  });
});

describe("command error helpers", () => {
  it("returns custom messages for normalized error codes", () => {
    const error = Object.assign(new Error("upstream"), { code: "invalid_previous_response_id" });
    expect(getCommandErrorCode(error)).toBe("invalid_previous_response_id");
    expect(formatCommandError(error)).toContain("lost server-side continuation");
  });

  it("formats rate limit and upstream unavailable errors", () => {
    const rateLimited = Object.assign(new Error("upstream"), { code: "rate_limited" });
    const upstreamUnavailable = Object.assign(new Error("upstream"), {
      code: "upstream_unavailable",
    });

    expect(formatCommandError(rateLimited)).toContain("rate-limited");
    expect(formatCommandError(upstreamUnavailable)).toContain("temporarily unavailable");
  });

  it("formats aborted requests cleanly", () => {
    const aborted = Object.assign(new Error("upstream"), { code: "aborted" });
    expect(formatCommandError(aborted)).toContain("Request stopped");
  });

  it("returns the unreadable utf-8 attachment message verbatim", () => {
    expect(
      formatCommandError(new Error('"broken.txt" could not be read as UTF-8 text.')),
    ).toContain("could not be read as UTF-8 text");
  });

  it("maps fetch failures to the local server warning", () => {
    expect(formatCommandError(new Error("Failed to fetch"))).toContain("Cannot reach the local Grok server");
  });
});
