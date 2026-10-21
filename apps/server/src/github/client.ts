import type { GithubRole } from '@orch/shared';

export interface GithubTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

export interface GithubUserInfo {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/** A repo the user can reach through an installation of the App. */
export interface GithubRepoAccess {
  githubRepoId: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  /** The user has admin rights on the repo. */
  admin: boolean;
}

export interface GithubIssue {
  number: number;
  nodeId: string;
  htmlUrl: string;
  title: string;
  body: string;
  labels: string[];
}

export interface CreateIssueInput {
  title: string;
  body: string;
  labels: string[];
}

export interface CreatePullRequestInput {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface InstallationTokenScope {
  /** Repository NAME without the owner. The token is limited to this single repository. */
  repository: string;
  permissions: Record<string, 'read' | 'write'>;
}

/** Everything the server needs from GitHub. Tests inject a fake. */
export interface GithubClient {
  exchangeCode(code: string, redirectUri: string): Promise<GithubTokens>;
  refreshUserToken(refreshToken: string): Promise<GithubTokens>;
  getUser(accessToken: string): Promise<GithubUserInfo>;
  /** Repos where the App is installed and the user has access (user-to-server token). */
  listUserRepos(accessToken: string): Promise<GithubRepoAccess[]>;
  /** The user's role on a repo, read with an installation token. */
  getUserRole(installationId: number, fullName: string, login: string): Promise<GithubRole>;
  /** Creates an issue with an installation token. */
  createIssue(
    installationId: number,
    fullName: string,
    input: CreateIssueInput,
  ): Promise<GithubIssue>;
  /** Open issues (not pull requests) carrying the label. */
  listIssuesByLabel(
    installationId: number,
    fullName: string,
    label: string,
  ): Promise<GithubIssue[]>;
  /** Mints an installation token limited to one repository and the given permissions. */
  createInstallationToken(
    installationId: number,
    scope: InstallationTokenScope,
  ): Promise<{ token: string; expiresAt: Date }>;
  createPullRequest(
    installationId: number,
    fullName: string,
    input: CreatePullRequestInput,
  ): Promise<{ number: number; htmlUrl: string }>;
  /** M5: head commit of a branch, or null when it does not exist. */
  getBranchSha(installationId: number, fullName: string, branch: string): Promise<string | null>;
  /** M5: creates a branch at a commit (no error when it already exists). */
  createBranch(
    installationId: number,
    fullName: string,
    branch: string,
    sha: string,
  ): Promise<void>;
  /** M5: closes an issue (not planned) after adding labels. Compensation of a failed batch. */
  closeIssue(
    installationId: number,
    fullName: string,
    issueNumber: number,
    addLabels: string[],
  ): Promise<void>;
}
