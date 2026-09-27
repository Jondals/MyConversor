// Error type shared by the server. Every error carries a stable `code` that the
// web app translates into the visitor's language; `message` is an English fallback.

export class AppError extends Error {
  /**
   * @param {number} status HTTP status to answer with.
   * @param {string} code Stable identifier, e.g. `unsupported_platform`.
   * @param {string} message English description (logs and fallback text).
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
