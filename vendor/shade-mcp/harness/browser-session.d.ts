import { type Page } from 'playwright';
import type { Backend } from '../config.js';
import type { BrowserSessionOptions, ViewerGlobals } from './types.js';
interface ConsoleEntry {
    type: string;
    text: string;
}
export declare class BrowserSession {
    private options;
    private viewerPath;
    /** Ceiling for every page operation this session performs. */
    readonly timeoutMs: number;
    private browser;
    private context;
    page: Page | null;
    globals: ViewerGlobals;
    private baseUrl;
    private consoleMessages;
    private _isSetup;
    private _serverAcquired;
    private _slotAcquired;
    constructor(opts: BrowserSessionOptions);
    setup(): Promise<void>;
    /**
     * Hands back the server ref and browser slot exactly once. Tools call
     * teardown() from a finally block that also runs after a failed setup, so
     * releasing unconditionally would hand back another session's resources.
     */
    private releaseShared;
    teardown(): Promise<void>;
    setBackend(backend: Backend): Promise<void>;
    clearConsoleMessages(): void;
    getConsoleMessages(): ConsoleEntry[];
    runWithConsoleCapture<T>(fn: () => Promise<T>): Promise<T & {
        console_errors?: string[];
    }>;
    get backend(): Backend;
    selectEffect(effectId: string): Promise<void>;
    getEffectGlobals(): Promise<Record<string, any>>;
    resetUniformsToDefaults(): Promise<void>;
}
export {};
//# sourceMappingURL=browser-session.d.ts.map