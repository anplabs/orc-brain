/**
 * Linear GraphQL client (spec 003 §R10–§R11): hand-written queries over the
 * injectable `fetchFn` (defaults to global fetch) — no SDK dependency. Every
 * response is mapped to the shared {@link ExternalTask} shape; every failure
 * surfaces as a readable Error (never a hang — the server caps the call).
 */

import type { ExternalTask, TaskQuery } from "@orc-brain/shared";

/** Injectable fetch (tests substitute canned GraphQL fixtures, §N3). */
export type FetchFn = typeof fetch;

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/** Human identifier form, e.g. `ENG-123` (§R11 getTask). */
const IDENTIFIER_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

/** Fields fetched for every issue, matching {@link ExternalTask}. */
const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  updatedAt
  state { name type }
  assignee { displayName }
  labels { nodes { name } }
`;

/** Raw issue node as returned by the Linear API. */
interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  updatedAt: string;
  state: { name: string; type: string } | null;
  assignee: { displayName: string } | null;
  labels: { nodes: Array<{ name: string }> } | null;
}

/** A team workflow state (§R12 — transitions resolve by `type`, not name). */
export interface WorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
}

/** Maps a Linear issue node to the normalized {@link ExternalTask} (§R11). */
export function mapIssue(node: IssueNode): ExternalTask {
  return {
    provider: "linear",
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? "",
    url: node.url,
    state: node.state?.name ?? "",
    ...(node.assignee ? { assignee: node.assignee.displayName } : {}),
    labels: (node.labels?.nodes ?? []).map((l) => l.name),
    updated_at: node.updatedAt,
  };
}

/** Builds the Linear `IssueFilter` for a {@link TaskQuery} (§R11). */
export function buildIssueFilter(query: TaskQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  filter.state = query.state
    ? { name: { eqIgnoreCase: query.state } }
    : { type: { nin: ["completed", "canceled"] } };
  if (query.team) {
    filter.team = {
      or: [
        { key: { eqIgnoreCase: query.team } },
        { name: { eqIgnoreCase: query.team } },
      ],
    };
  }
  if (query.search) filter.searchableContent = { contains: query.search };
  if (query.assigned_to_me) filter.assignee = { isMe: { eq: true } };
  return filter;
}

/** Thin GraphQL transport + the queries/mutations the plugin needs. */
export class LinearClient {
  constructor(
    /** Read at call time so a key set after boot works without a reload. */
    private readonly apiKey: () => string | undefined,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private async gql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const key = this.apiKey();
    if (!key) {
      throw new Error(
        "LINEAR_API_KEY is not set — run: orc plugin secret set linear LINEAR_API_KEY",
      );
    }
    const res = await this.fetchFn(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      throw new Error(
        `Linear API HTTP ${res.status}${res.status === 401 || res.status === 400 ? " — check LINEAR_API_KEY" : ""}`,
      );
    }
    const body = (await res.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };
    if (body.errors?.length) {
      throw new Error(
        `Linear API error: ${body.errors.map((e) => e.message).join("; ")}`,
      );
    }
    if (!body.data) throw new Error("Linear API returned no data");
    return body.data;
  }

  /** Issues matching a query, newest-updated first (§R11 listTasks). */
  async listIssues(query: TaskQuery): Promise<ExternalTask[]> {
    const data = await this.gql<{ issues: { nodes: IssueNode[] } }>(
      `query Issues($filter: IssueFilter, $first: Int) {
        issues(filter: $filter, first: $first, orderBy: updatedAt) {
          nodes { ${ISSUE_FIELDS} }
        }
      }`,
      { filter: buildIssueFilter(query), first: query.limit ?? 25 },
    );
    return data.issues.nodes.map(mapIssue);
  }

  /** One issue by UUID or human identifier (`ENG-123`), or null (§R11). */
  async getIssue(idOrIdentifier: string): Promise<ExternalTask | null> {
    const m = IDENTIFIER_RE.exec(idOrIdentifier);
    if (m) {
      const data = await this.gql<{ issues: { nodes: IssueNode[] } }>(
        `query IssueByIdentifier($filter: IssueFilter) {
          issues(filter: $filter, first: 1) {
            nodes { ${ISSUE_FIELDS} }
          }
        }`,
        {
          filter: {
            team: { key: { eqIgnoreCase: m[1] } },
            number: { eq: Number(m[2]) },
          },
        },
      );
      const node = data.issues.nodes[0];
      return node ? mapIssue(node) : null;
    }
    try {
      const data = await this.gql<{ issue: IssueNode | null }>(
        `query Issue($id: String!) {
          issue(id: $id) { ${ISSUE_FIELDS} }
        }`,
        { id: idOrIdentifier },
      );
      return data.issue ? mapIssue(data.issue) : null;
    } catch (err) {
      // Linear answers an unknown id with an "entity not found" error.
      if (/not found/i.test(err instanceof Error ? err.message : "")) {
        return null;
      }
      throw err;
    }
  }

  /** Comments on an issue (§R12). */
  async createComment(issueId: string, body: string): Promise<void> {
    await this.gql<{ commentCreate: { success: boolean } }>(
      `mutation CommentCreate($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }`,
      { issueId, body },
    );
  }

  /** Workflow states of the issue's team, ordered by position (§R12). */
  async listIssueTeamStates(issueId: string): Promise<WorkflowState[]> {
    const data = await this.gql<{
      issue: {
        team: { states: { nodes: WorkflowState[] } };
      } | null;
    }>(
      `query IssueTeamStates($id: String!) {
        issue(id: $id) {
          team { states { nodes { id name type position } } }
        }
      }`,
      { id: issueId },
    );
    return (data.issue?.team.states.nodes ?? [])
      .slice()
      .sort((a, b) => a.position - b.position);
  }

  /**
   * Moves an issue to its team's first state of `type` (e.g. `"started"`,
   * `"completed"`) — resolved by type so any workspace works (§R12). Returns
   * the state moved to, or null when the team has none of that type.
   */
  async moveIssueToStateType(
    issueId: string,
    type: string,
  ): Promise<WorkflowState | null> {
    const state = (await this.listIssueTeamStates(issueId)).find(
      (s) => s.type === type,
    );
    if (!state) return null;
    await this.gql<{ issueUpdate: { success: boolean } }>(
      `mutation IssueUpdate($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: issueId, stateId: state.id },
    );
    return state;
  }
}
