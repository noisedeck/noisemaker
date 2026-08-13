/**
 * Registry of sessions holding a browser right now.
 *
 * An MCP client kills the server with a signal, which by default leaves the
 * Chromium it spawned running and the viewer port bound. Tracking live sessions
 * gives the shutdown path something to close.
 */
export interface Closeable {
    teardown(): Promise<void>;
}
export declare function trackSession(session: Closeable): void;
export declare function untrackSession(session: Closeable): void;
export declare function liveSessionCount(): number;
/** Tears down every live session. One failure must not strand the others. */
export declare function closeAllSessions(): Promise<void>;
//# sourceMappingURL=live-sessions.d.ts.map