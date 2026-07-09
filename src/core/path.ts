// POSIX-style path normalization helpers.

export function normalizePath(input: string): string {
  if (!input) input = '/';
  if (!input.startsWith('/')) input = '/' + input;
  const parts = input.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length && stack[stack.length - 1] !== '..') stack.pop();
      else if (stack.length === 0) continue;
      else stack.push('..');
    } else {
      stack.push(part);
    }
  }
  return '/' + stack.join('/');
}

export function dirname(p: string): string {
  const norm = normalizePath(p);
  if (norm === '/') return '/';
  const idx = norm.lastIndexOf('/');
  if (idx <= 0) return '/';
  return norm.slice(0, idx);
}

export function basename(p: string): string {
  const norm = normalizePath(p);
  if (norm === '/') return '';
  return norm.slice(norm.lastIndexOf('/') + 1);
}

export function joinPath(dir: string, name: string): string {
  return normalizePath(dir + '/' + name);
}

export function isInside(parent: string, child: string): boolean {
  const np = normalizePath(parent);
  const nc = normalizePath(child);
  if (np === '/') return nc !== '/';
  return nc === np + '/' || nc.startsWith(np + '/');
}
