/**
 * LinearClient tests (spec 003 §R10–§R11, §N3): query building, response
 * mapping, and error surfacing — all against a canned fake fetch, no network.
 */

import { describe, expect, it } from "vitest";
import {
  LinearClient,
  buildIssueFilter,
  mapIssue,
  type FetchFn,
} from "./api.js";

const ISSUE_NODE = {
  id: "uuid-1",
  identifier: "ENG-123",
  title: "Fix drift",
  description: "It drifts.",
  url: "https://linear.app/acme/issue/ENG-123",
  updatedAt: "2026-07-12T00:00:00.000Z",
  state: { name: "Todo", type: "unstarted" },
  assignee: { displayName: "Paulo" },
  labels: { nodes: [{ name: "bug" }] },
};

interface Call {
  query: string;
  variables: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A fake fetch returning queued GraphQL payloads and recording calls. */
function fakeFetch(responses: unknown[]): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({
      query: body.query,
      variables: body.variables,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses.shift() ?? { data: {} };
    if (next instanceof Error) throw next;
    const status = (next as { __status?: number }).__status;
    return {
      ok: !status || status < 400,
      status: status ?? 200,
      json: async () => next,
    };
  }) as unknown as FetchFn;
  return { fetchFn, calls };
}

function client(responses: unknown[], key: string | null = "lin_key_1234") {
  const { fetchFn, calls } = fakeFetch(responses);
  return { client: new LinearClient(() => key ?? undefined, fetchFn), calls };
}

describe("buildIssueFilter (spec 003 §R11)", () => {
  it("defaults to non-completed/non-canceled; maps every query field", () => {
    expect(buildIssueFilter({})).toEqual({
      state: { type: { nin: ["completed", "canceled"] } },
    });
    expect(
      buildIssueFilter({
        search: "drift",
        assigned_to_me: true,
        state: "In Review",
        team: "ENG",
      }),
    ).toEqual({
      state: { name: { eqIgnoreCase: "In Review" } },
      team: {
        or: [
          { key: { eqIgnoreCase: "ENG" } },
          { name: { eqIgnoreCase: "ENG" } },
        ],
      },
      searchableContent: { contains: "drift" },
      assignee: { isMe: { eq: true } },
    });
  });
});

describe("LinearClient (spec 003 §R10–§R11)", () => {
  it("lists issues, sending the API key and mapping to ExternalTask", async () => {
    const { client: c, calls } = client([
      { data: { issues: { nodes: [ISSUE_NODE] } } },
    ]);
    const tasks = await c.listIssues({ limit: 5 });
    expect(calls[0]?.headers.Authorization).toBe("lin_key_1234");
    expect(calls[0]?.variables.first).toBe(5);
    expect(tasks).toEqual([
      {
        provider: "linear",
        id: "uuid-1",
        identifier: "ENG-123",
        title: "Fix drift",
        description: "It drifts.",
        url: "https://linear.app/acme/issue/ENG-123",
        state: "Todo",
        assignee: "Paulo",
        labels: ["bug"],
        updated_at: "2026-07-12T00:00:00.000Z",
      },
    ]);
  });

  it("maps an empty description and missing assignee/labels", () => {
    const task = mapIssue({
      ...ISSUE_NODE,
      description: null,
      assignee: null,
      labels: null,
      state: null,
    });
    expect(task.description).toBe("");
    expect(task.assignee).toBeUndefined();
    expect(task.labels).toEqual([]);
    expect(task.state).toBe("");
  });

  it("getIssue accepts a human identifier (team key + number filter)", async () => {
    const { client: c, calls } = client([
      { data: { issues: { nodes: [ISSUE_NODE] } } },
    ]);
    const task = await c.getIssue("ENG-123");
    expect(task?.id).toBe("uuid-1");
    expect(calls[0]?.variables.filter).toEqual({
      team: { key: { eqIgnoreCase: "ENG" } },
      number: { eq: 123 },
    });
  });

  it("getIssue accepts a UUID and returns null when unknown", async () => {
    const uuid = "c0ffee00-1111-4222-8333-abcdef123456";
    const { client: c, calls } = client([
      { data: { issue: ISSUE_NODE } },
      { errors: [{ message: "Entity not found: Issue" }] },
    ]);
    expect((await c.getIssue(uuid))?.identifier).toBe("ENG-123");
    expect(calls[0]?.variables.id).toBe(uuid);
    expect(await c.getIssue("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("surfaces readable errors: missing key, HTTP failure, GraphQL errors", async () => {
    const noKey = client([], null);
    await expect(noKey.client.listIssues({})).rejects.toThrow(
      /LINEAR_API_KEY is not set/,
    );

    const unauthorized = client([{ __status: 401 }]);
    await expect(unauthorized.client.listIssues({})).rejects.toThrow(
      /HTTP 401 — check LINEAR_API_KEY/,
    );

    const gqlError = client([{ errors: [{ message: "rate limited" }] }]);
    await expect(gqlError.client.listIssues({})).rejects.toThrow(
      /rate limited/,
    );
  });

  it("moves an issue to the first state of a type, by position (§R12)", async () => {
    const states = {
      data: {
        issue: {
          team: {
            states: {
              nodes: [
                { id: "s3", name: "Done", type: "completed", position: 3 },
                { id: "s2", name: "In Progress", type: "started", position: 2 },
                { id: "s1", name: "Doing", type: "started", position: 1 },
              ],
            },
          },
        },
      },
    };
    const { client: c, calls } = client([
      states,
      { data: { issueUpdate: { success: true } } },
    ]);
    const moved = await c.moveIssueToStateType("uuid-1", "started");
    expect(moved?.id).toBe("s1"); // lowest position wins
    expect(calls[1]?.variables).toEqual({ id: "uuid-1", stateId: "s1" });

    const none = client([states]);
    expect(
      await none.client.moveIssueToStateType("uuid-1", "triage"),
    ).toBeNull();
  });

  it("comments on an issue", async () => {
    const { client: c, calls } = client([
      { data: { commentCreate: { success: true } } },
    ]);
    await c.createComment("uuid-1", "hello from orc");
    expect(calls[0]?.variables).toEqual({
      issueId: "uuid-1",
      body: "hello from orc",
    });
  });
});
