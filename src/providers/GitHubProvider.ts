import { GitContentsProvider, type GitContentsOptions } from './GitContentsProvider';

export type GitHubProviderOptions = GitContentsOptions;

// GitHub sync target via the Contents API + Git Trees API.
// Auth: personal access token in the Authorization header.
export class GitHubProvider extends GitContentsProvider {
  protected apiBase: string;

  constructor(opts: GitHubProviderOptions) {
    super(opts, 'github');
    this.apiBase = opts.apiBase ?? 'https://api.github.com';
  }

  protected authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  protected authQuery(): Record<string, string> {
    return {};
  }
}
