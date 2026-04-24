/**
 * Linear client wrapper.
 *
 * Thin layer over `@linear/sdk`. Lazy-imported; install the dep and set
 * LINEAR_API_KEY before enabling the operations_linear_* tools.
 *
 * Tool-layer code is responsible for scope:
 *   read  → operations.linear_read === true
 *   write → operations.linear_write === true
 *
 * Status: scaffold.
 */

import { AppError } from '../errors';

export interface LinearIssueSummary {
  id: string;
  identifier: string;
  title: string;
  state: string;
  team: string;
  assignee: string | null;
  priority: number;
  url: string;
  created_at: string;
  updated_at: string;
}

async function getClient() {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new AppError('internal', 'LINEAR_API_KEY is not set', 500);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('@linear/sdk').catch(() => {
    throw new AppError(
      'internal',
      '@linear/sdk is not installed; add it to package.json before calling operations_linear_*',
      500
    );
  });
  const LinearClient = mod.LinearClient;
  return new LinearClient({ apiKey: key });
}

export async function searchLinearIssues(params: {
  query?: string;
  team_key?: string;
  state?: string;
  assignee?: string;
  limit?: number;
}): Promise<LinearIssueSummary[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = await getClient();
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const filter: Record<string, unknown> = {};
  if (params.team_key) filter.team = { key: { eq: params.team_key } };
  if (params.state) filter.state = { type: { eq: params.state } };
  if (params.assignee) {
    filter.assignee = {
      or: [{ name: { eq: params.assignee } }, { id: { eq: params.assignee } }],
    };
  }
  if (params.query) {
    filter.or = [
      { title: { containsIgnoreCase: params.query } },
      { description: { containsIgnoreCase: params.query } },
    ];
  }

  const result = await client.issues({ filter, first: limit });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes: any[] = result.nodes ?? [];
  const summaries: LinearIssueSummary[] = [];
  for (const issue of nodes) {
    const [team, state, assignee] = await Promise.all([
      issue.team,
      issue.state,
      issue.assignee,
    ]);
    summaries.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: state?.name ?? 'unknown',
      team: team?.key ?? 'unknown',
      assignee: assignee?.name ?? null,
      priority: issue.priority,
      url: issue.url,
      created_at: issue.createdAt.toISOString(),
      updated_at: issue.updatedAt.toISOString(),
    });
  }
  return summaries;
}

export async function getLinearIssue(identifier: string): Promise<LinearIssueSummary & {
  description: string | null;
  labels: string[];
  comments: Array<{ author: string; body: string; created_at: string }>;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = await getClient();
  const issue = await client.issue(identifier);
  if (!issue) throw new AppError('not_found', `Issue ${identifier} not found`, 404);
  const [team, state, assignee, labelsConn, commentsConn] = await Promise.all([
    issue.team,
    issue.state,
    issue.assignee,
    issue.labels(),
    issue.comments(),
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const labels: string[] = (labelsConn?.nodes ?? []).map((l: any) => l.name);
  const comments = await Promise.all(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (commentsConn?.nodes ?? []).map(async (c: any) => {
      const user = await c.user;
      return {
        author: user?.name ?? 'unknown',
        body: c.body,
        created_at: c.createdAt.toISOString(),
      };
    })
  );
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    state: state?.name ?? 'unknown',
    team: team?.key ?? 'unknown',
    assignee: assignee?.name ?? null,
    priority: issue.priority,
    url: issue.url,
    created_at: issue.createdAt.toISOString(),
    updated_at: issue.updatedAt.toISOString(),
    description: issue.description ?? null,
    labels,
    comments,
  };
}

export async function createLinearIssue(params: {
  team_key: string;
  title: string;
  description?: string;
  assignee?: string;
  labels?: string[];
  priority?: number;
  project?: string;
}): Promise<{ id: string; identifier: string; url: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = await getClient();
  const team = await client.team(params.team_key);
  if (!team) throw new AppError('not_found', `Team ${params.team_key} not found`, 404);

  let assigneeId: string | undefined;
  if (params.assignee) {
    const users = await client.users({ filter: { name: { eq: params.assignee } } });
    assigneeId = users.nodes[0]?.id;
  }

  let labelIds: string[] | undefined;
  if (params.labels && params.labels.length > 0) {
    const allLabels = await team.labels();
    labelIds = (allLabels.nodes ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((l: any) => params.labels!.includes(l.name))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((l: any) => l.id);
  }

  const payload = await client.createIssue({
    teamId: team.id,
    title: params.title,
    description: params.description,
    assigneeId,
    labelIds,
    priority: params.priority,
  });
  const issue = await payload.issue;
  if (!issue) throw new AppError('internal', 'Linear createIssue returned no issue', 500);
  return { id: issue.id, identifier: issue.identifier, url: issue.url };
}

export async function updateLinearIssue(params: {
  identifier: string;
  state?: string;
  assignee?: string;
  priority?: number;
  comment?: string;
}): Promise<{ id: string; updated: string[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = await getClient();
  const issue = await client.issue(params.identifier);
  if (!issue) throw new AppError('not_found', `Issue ${params.identifier} not found`, 404);

  const updated: string[] = [];
  const updatePayload: Record<string, unknown> = {};

  if (params.state) {
    const team = await issue.team;
    if (!team) throw new AppError('internal', 'Issue has no team', 500);
    const states = await team.states();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const match = (states.nodes ?? []).find((s: any) => s.name === params.state);
    if (!match) throw new AppError('invalid_input', `State "${params.state}" not found`, 400);
    updatePayload.stateId = match.id;
    updated.push('state');
  }
  if (params.assignee) {
    const users = await client.users({ filter: { name: { eq: params.assignee } } });
    const uid = users.nodes[0]?.id;
    if (!uid) throw new AppError('invalid_input', `Assignee "${params.assignee}" not found`, 400);
    updatePayload.assigneeId = uid;
    updated.push('assignee');
  }
  if (params.priority != null) {
    updatePayload.priority = params.priority;
    updated.push('priority');
  }

  if (Object.keys(updatePayload).length > 0) {
    await issue.update(updatePayload);
  }

  if (params.comment) {
    await client.createComment({ issueId: issue.id, body: params.comment });
    updated.push('comment');
  }

  return { id: issue.id, updated };
}
