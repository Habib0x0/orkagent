// orkagent fork -- clone and customize a template
// Implementation: T-42

import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';

const execFileAsync = promisify(execFile);

export interface ForkOptions {
  name?: string;
}

export async function forkTemplate(repoUrl: string, opts: ForkOptions = {}): Promise<string> {
  // derive local directory name from --name or last segment of repo URL
  const repoName = repoUrl.replace(/\.git$/, '').split('/').pop() ?? 'template';
  const localName = opts.name ?? repoName;
  const dest = resolve(process.cwd(), localName);

  await execFileAsync('git', ['clone', repoUrl, dest]);

  return dest;
}
