import { readFileSync } from 'node:fs';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { GithubRole } from '@orch/shared';
import type {
  CreateIssueInput,
  CreatePullRequestInput,
  GithubClient,
  GithubIssue,
  GithubRepoAccess,
  GithubTokens,
  GithubUserInfo,
  InstallationTokenScope,
} from './client';

export interface OctokitGithubOptions {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKeyPath: string;
  /** REST API base URL (default https://api.github.com). */
  apiUrl?: string;
  /** Web base URL for the OAuth token exchange (default https://github.com). */
  webUrl?: string;
}

const ROLES: Record<string, GithubRole> = {
  admin: 'ADMIN',
  maintain: 'MAINTAIN',
  write: 'WRITE',
  triage: 'TRIAGE',
  read: 'READ',
};

export function mapGithubRoleName(name: string | null | undefined): GithubRole {
  return (name && ROLES[name]) || 'NONE';
}

function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) throw new Error(`Invalid repository name: ${fullName}`);
  return { owner, repo };
}

function toIssue(d: {
  number: number;
  node_id: string;
  html_url: string;
  title: string;
  body?: string | null;
  labels: Array<string | { name?: string }>;
}): GithubIssue {
  return {
    number: d.number,
    nodeId: d.node_id,
    htmlUrl: d.html_url,
    title: d.title,
    body: d.body ?? '',
    labels: d.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
  };
}

async function tokenRequest(
  opts: OctokitGithubOptions,
  params: Record<string, string>,
): Promise<GithubTokens> {
  const web = (opts.webUrl ?? 'https://github.com').replace(/\/+$/, '');
  const res = await fetch(`${web}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      ...params,
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(`GitHub token exchange failed: ${data.error ?? res.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined,
  };
}

export class OctokitGithubClient implements GithubClient {
  private readonly privateKey: string;
  private readonly installationClients = new Map<number, Octokit>();
  private readonly baseUrl: string;

  constructor(private readonly opts: OctokitGithubOptions) {
    this.privateKey = readFileSync(opts.privateKeyPath, 'utf8');
    this.baseUrl = (opts.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  }

  private userClient(accessToken: string): Octokit {
    return new Octokit({ auth: accessToken, baseUrl: this.baseUrl });
  }

  exchangeCode(code: string, redirectUri: string): Promise<GithubTokens> {
    return tokenRequest(this.opts, { code, redirect_uri: redirectUri });
  }

  refreshUserToken(refreshToken: string): Promise<GithubTokens> {
    return tokenRequest(this.opts, { grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async getUser(accessToken: string): Promise<GithubUserInfo> {
    const { data } = await this.userClient(accessToken).rest.users.getAuthenticated();
    return { id: data.id, login: data.login, name: data.name, avatarUrl: data.avatar_url };
  }

  async isOrgMember(accessToken: string, org: string): Promise<boolean> {
    try {
      const { data } = await this.userClient(
        accessToken,
      ).rest.orgs.getMembershipForAuthenticatedUser({ org });
      return data.state === 'active';
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 403) return false;
      throw err;
    }
  }

  async listUserRepos(accessToken: string): Promise<GithubRepoAccess[]> {
    const octokit = this.userClient(accessToken);
    const installations = await octokit.paginate(
      octokit.rest.apps.listInstallationsForAuthenticatedUser,
      { per_page: 100 },
    );
    const out: GithubRepoAccess[] = [];
    for (const inst of installations) {
      const account = inst.account as { login?: string; slug?: string; type?: string } | null;
      const repos = await octokit.paginate(
        octokit.rest.apps.listInstallationReposForAuthenticatedUser,
        { installation_id: inst.id, per_page: 100 },
      );
      for (const r of repos) {
        out.push({
          githubRepoId: r.id,
          fullName: r.full_name,
          private: r.private,
          defaultBranch: r.default_branch,
          installationId: inst.id,
          accountLogin: account?.login ?? account?.slug ?? '',
          accountType: account?.type ?? 'User',
          admin: r.permissions?.admin === true,
        });
      }
    }
    return out;
  }

  async getUserRole(installationId: number, fullName: string, login: string): Promise<GithubRole> {
    const [owner, repo] = fullName.split('/');
    if (!owner || !repo) return 'NONE';
    try {
      const { data } = await this.forInstallation(
        installationId,
      ).rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: login });
      return mapGithubRoleName(data.role_name);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return 'NONE';
      throw err;
    }
  }

  async createIssue(
    installationId: number,
    fullName: string,
    input: CreateIssueInput,
  ): Promise<GithubIssue> {
    const { owner, repo } = splitFullName(fullName);
    const { data } = await this.forInstallation(installationId).rest.issues.create({
      owner,
      repo,
      title: input.title,
      body: input.body,
      labels: input.labels,
    });
    return toIssue(data);
  }

  async listIssuesByLabel(
    installationId: number,
    fullName: string,
    label: string,
  ): Promise<GithubIssue[]> {
    const { owner, repo } = splitFullName(fullName);
    const octokit = this.forInstallation(installationId);
    const items = await octokit.paginate(octokit.rest.issues.listForRepo, {
      owner,
      repo,
      labels: label,
      state: 'open',
      per_page: 100,
    });
    return items.filter((i) => !i.pull_request).map(toIssue);
  }

  async createInstallationToken(
    installationId: number,
    scope: InstallationTokenScope,
  ): Promise<{ token: string; expiresAt: Date }> {
    const auth = createAppAuth({
      appId: this.opts.appId,
      privateKey: this.privateKey,
      // Same base URL as the REST calls (GitHub Enterprise, E2E fake).
      request: new Octokit({ baseUrl: this.baseUrl }).request,
    });
    const res = await auth({
      type: 'installation',
      installationId,
      repositoryNames: [scope.repository],
      permissions: scope.permissions,
      refresh: true,
    });
    return { token: res.token, expiresAt: new Date(res.expiresAt ?? Date.now() + 3600_000) };
  }

  async createPullRequest(
    installationId: number,
    fullName: string,
    input: CreatePullRequestInput,
  ): Promise<{ number: number; htmlUrl: string }> {
    const { owner, repo } = splitFullName(fullName);
    const { data } = await this.forInstallation(installationId).rest.pulls.create({
      owner,
      repo,
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft,
    });
    return { number: data.number, htmlUrl: data.html_url };
  }

  async getBranchSha(
    installationId: number,
    fullName: string,
    branch: string,
  ): Promise<string | null> {
    const { owner, repo } = splitFullName(fullName);
    try {
      const { data } = await this.forInstallation(installationId).rest.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      return data.object.sha;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  async createBranch(
    installationId: number,
    fullName: string,
    branch: string,
    sha: string,
  ): Promise<void> {
    const { owner, repo } = splitFullName(fullName);
    try {
      await this.forInstallation(installationId).rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha,
      });
    } catch (err) {
      // 422 "Reference already exists": someone created it meanwhile.
      if ((err as { status?: number }).status === 422) return;
      throw err;
    }
  }

  async closeIssue(
    installationId: number,
    fullName: string,
    issueNumber: number,
    addLabels: string[],
  ): Promise<void> {
    const { owner, repo } = splitFullName(fullName);
    const octokit = this.forInstallation(installationId);
    if (addLabels.length > 0) {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels: addLabels,
      });
    }
    await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      state: 'closed',
      state_reason: 'not_planned',
    });
  }

  private forInstallation(installationId: number): Octokit {
    let client = this.installationClients.get(installationId);
    if (!client) {
      client = new Octokit({
        authStrategy: createAppAuth,
        auth: { appId: this.opts.appId, privateKey: this.privateKey, installationId },
        baseUrl: this.baseUrl,
      });
      this.installationClients.set(installationId, client);
    }
    return client;
  }
}
