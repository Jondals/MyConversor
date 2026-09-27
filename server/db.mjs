// Tiny JSON-file database (<data>/db.json) for users, sessions and file metadata.
// Writes are batched and atomic so a crash never leaves a half-written file.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Random hex id; 16 bytes = 128 bits, unguessable. */
export const newId = (bytes = 16) => randomBytes(bytes).toString('hex');

export class Db {
  /** Loads `db.json` from `dir` (or starts empty). */
  constructor(dir) {
    this.path = join(dir, 'db.json');
    this.data = { users: {}, sessions: {}, files: {} };
    if (existsSync(this.path)) {
      try {
        this.data = { ...this.data, ...JSON.parse(readFileSync(this.path, 'utf8')) };
      } catch {
        /* corrupt file: start fresh */
      }
    }
    this.timer = null;
  }

  /** Schedules a write (several changes in a row become one write). */
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 50);
  }

  /** Writes now: temp file first, then an atomic rename. */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data));
    renameSync(`${this.path}.tmp`, this.path);
  }

  // ------------------------------------------------------------------ users

  /** Creates an anonymous visitor (no username yet). */
  createGuest() {
    const user = { id: newId(), username: null, avatar: false, created: Date.now() };
    this.data.users[user.id] = user;
    this.save();
    return user;
  }

  /** Finds a user by id. */
  user(id) {
    return this.data.users[id] ?? null;
  }

  /** Finds a registered user by name (case-insensitive). */
  byUsername(username) {
    const name = username.toLowerCase();
    return Object.values(this.data.users).find((u) => u.username?.toLowerCase() === name) ?? null;
  }

  /** Turns a user into a registered account, storing a salted scrypt hash. */
  setPassword(user, username, password) {
    const salt = randomBytes(16).toString('hex');
    user.username = username;
    user.salt = salt;
    user.hash = scryptSync(password, salt, 64).toString('hex');
    user.registered = Date.now();
    this.save();
  }

  /** Constant-time password check. */
  checkPassword(user, password) {
    if (!user?.hash) return false;
    const hash = scryptSync(password, user.salt, 64);
    return timingSafeEqual(hash, Buffer.from(user.hash, 'hex'));
  }

  /** Removes a user and all of its sessions. */
  deleteUser(id) {
    delete this.data.users[id];
    for (const [token, s] of Object.entries(this.data.sessions)) {
      if (s.userId === id) delete this.data.sessions[token];
    }
    this.save();
  }

  // --------------------------------------------------------------- sessions

  /** Starts a session and returns its secret token (stored in a cookie). */
  createSession(userId) {
    const token = newId(32);
    this.data.sessions[token] = { userId, created: Date.now() };
    this.save();
    return token;
  }

  /** Looks up a session by token. */
  session(token) {
    return (token && this.data.sessions[token]) || null;
  }

  /** Ends a session. */
  dropSession(token) {
    delete this.data.sessions[token];
    this.save();
  }

  // ------------------------------------------------------------------ files

  /** Stores the metadata of a file saved on disk. */
  addFile(file) {
    this.data.files[file.id] = file;
    this.save();
    return file;
  }

  /** Finds a file by id. */
  file(id) {
    return this.data.files[id] ?? null;
  }

  /** Files owned by a user, newest first. */
  filesOf(userId) {
    return Object.values(this.data.files)
      .filter((f) => f.userId === userId)
      .sort((a, b) => b.created - a.created);
  }

  /** Bytes used by a user. */
  usedBy(userId) {
    return this.filesOf(userId).reduce((sum, f) => sum + f.size, 0);
  }

  /** Forgets a file (the caller deletes it from disk). */
  removeFile(id) {
    const file = this.data.files[id];
    delete this.data.files[id];
    this.save();
    return file ?? null;
  }
}
