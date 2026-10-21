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

/** Everything the server needs from GitHub. Tests inject a fake. */
export interface GithubClient {
  exchangeCode(code: string, redirectUri: string): Promise<GithubTokens>;
  refreshUserToken(refreshToken: string): Promise<GithubTokens>;
  getUser(accessToken: string): Promise<GithubUserInfo>;
  /** Repos where the App is installed and the user has access (user-to-server token). */
  listUserRepos(accessToken: string): Promise<GithubRepoAccess[]>;
  /** The user's role on a repo, read with an installation token. */
  getUserRole(installationId: number, fullName: string, login: string): Promise<GithubRole>;
}
