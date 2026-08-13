/**
 * Bounds every provider request. Without a timeout the SDK waits ~10 minutes,
 * and the calling tool holds its browser slot for the duration; retries are
 * capped at one so a stalling provider cannot multiply that wait.
 */
export declare function aiClientOptions(): {
    timeout: number;
    maxRetries: number;
};
export interface AIProvider {
    provider: 'anthropic' | 'openai';
    apiKey: string;
    model: string;
}
export interface CallAIOptions {
    system: string;
    userContent: Array<{
        type: string;
        text?: string;
        image_url?: {
            url: string;
        };
    }>;
    maxTokens?: number;
    jsonMode?: boolean;
    ai: AIProvider;
}
export declare function getAIProvider(options: {
    projectRoot: string;
}): AIProvider | null;
export declare function callAI(options: CallAIOptions): Promise<string | null>;
export declare const NO_AI_KEY_MESSAGE = "No AI API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or create .anthropic/.openai file in project root.";
//# sourceMappingURL=provider.d.ts.map