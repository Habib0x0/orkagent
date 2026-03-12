// orkagent save -- package config as a shareable template
// Implementation: T-40

export interface SaveOptions {
  file?: string;
  description?: string;
}

export async function saveTemplate(name: string, opts: SaveOptions = {}): Promise<void> {
  const { readFileSync, writeFileSync } = await import('fs');
  const { resolve } = await import('path');

  const src = resolve(process.cwd(), opts.file ?? 'agents.yaml');
  const dest = resolve(process.cwd(), `${name}.template.yaml`);

  let content: string;
  try {
    content = readFileSync(src, 'utf8');
  } catch {
    throw new Error(`Cannot read config file: ${src}`);
  }

  const lines = [`# Template: ${name}`];
  if (opts.description) lines.push(`# ${opts.description}`);
  lines.push('', content);

  writeFileSync(dest, lines.join('\n'));
}
