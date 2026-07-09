// Errno-style errors consistent with Node's fs.

export class FsError extends Error {
  code: string;
  path?: string;
  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = 'FsError';
    this.code = code;
    this.path = path;
  }
}

export class ENOENT extends FsError {
  constructor(path: string) {
    super('ENOENT', `no such file or directory, ${path}`, path);
  }
}

export class EEXIST extends FsError {
  constructor(path: string) {
    super('EEXIST', `file already exists, ${path}`, path);
  }
}

export class ENOTDIR extends FsError {
  constructor(path: string) {
    super('ENOTDIR', `not a directory, ${path}`, path);
  }
}

export class EISDIR extends FsError {
  constructor(path: string) {
    super('EISDIR', `illegal operation on a directory, ${path}`, path);
  }
}

export class AuthError extends FsError {
  constructor(message: string) {
    super('EACCES', message);
  }
}
