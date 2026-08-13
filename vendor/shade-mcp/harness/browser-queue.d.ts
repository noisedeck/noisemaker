/**
 * Async semaphore for pipelining browser sessions.
 * Prevents CPU contention when multiple tool calls arrive concurrently.
 */
export declare function setMaxBrowsers(n: number): void;
export declare function getMaxBrowsers(): number;
export declare function getActiveBrowsers(): number;
export declare function getQueueDepth(): number;
export declare function acquireBrowserSlot(): Promise<void>;
export declare function releaseBrowserSlot(): void;
export declare function resetBrowserQueue(): void;
//# sourceMappingURL=browser-queue.d.ts.map