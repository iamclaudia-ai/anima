/**
 * Well-known constants shared across packages and extensions.
 */

/**
 * Sentinel sessionId for persistent sessions.
 *
 * When passed as `sessionId` to `session.send_prompt`, the session extension
 * resolves the real sessionId from the `cwd` + `source` combination.
 * It handles creation, recovery, and rotation automatically.
 *
 * Extensions like iMessage and Voice Mode use this so they never have to
 * manage session lifecycle themselves.
 */
export const PERSISTENT_SESSION_ID = "00000000-0000-0000-0000-000000000000";
