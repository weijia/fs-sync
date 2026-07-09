import { GitContentsProvider, type GitContentsOptions } from './GitContentsProvider';

export type GiteeProviderOptions = GitContentsOptions;

// Gitee sync target. Gitee's REST v5 API mirrors GitHub's Contents/Trees API,
// but authenticates via an `access_token` query parameter.
export class GiteeProvider extends GitContentsProvider {
  protected apiBase: string;

  constructor(opts: GiteeProviderOptions) {
    super(opts, 'gitee');
    this.apiBase = opts.apiBase ?? 'https://gitee.com/api/v5';
  }

  protected authHeaders(): Record<string, string> {
    return {};
  }

  protected authQuery(): Record<string, string> {
    return { access_token: this.token };
  }
}
