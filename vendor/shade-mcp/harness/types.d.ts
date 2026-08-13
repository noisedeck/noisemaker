import type { Backend } from '../config.js';
export interface ViewerGlobals {
    canvasRenderer: string;
    renderingPipeline: string;
    currentBackend: string;
    currentEffect: string;
    setPaused: string;
    setPausedTime: string;
    frameCount: string;
}
export declare const DEFAULT_GLOBALS: ViewerGlobals;
export declare function globalsFromPrefix(prefix: string): ViewerGlobals;
export interface BrowserSessionOptions {
    backend: Backend;
    headless?: boolean;
    viewerPort?: number;
    viewerRoot?: string;
    viewerPath?: string;
    effectsDir?: string;
    globals?: ViewerGlobals;
    timeoutMs?: number;
}
export interface ImageMetrics {
    mean_rgb: [number, number, number];
    mean_alpha: number;
    std_rgb: [number, number, number];
    luma_variance: number;
    unique_sampled_colors: number;
    is_all_zero: boolean;
    is_all_transparent: boolean;
    is_essentially_blank: boolean;
    is_monochrome: boolean;
}
export interface CompileResult {
    status: 'ok' | 'error';
    backend: string;
    passes: Array<{
        id: string;
        status: 'ok' | 'error';
        errors?: string[];
    }>;
    message: string;
    console_errors?: string[];
}
export interface RenderResult {
    status: 'ok' | 'error';
    backend: string;
    frame?: {
        image_uri?: string;
        width: number;
        height: number;
    };
    metrics?: ImageMetrics;
    console_errors?: string[];
}
export interface BenchmarkResult {
    status: 'ok' | 'error';
    backend: string;
    achieved_fps: number;
    meets_target: boolean;
    stats: {
        frame_count: number;
        avg_frame_time_ms: number;
        jitter_ms: number;
        min_frame_time_ms: number;
        max_frame_time_ms: number;
    };
    console_errors?: string[];
}
export interface ParityResult {
    status: 'ok' | 'error' | 'mismatch';
    maxDiff: number;
    meanDiff: number;
    mismatchCount: number;
    mismatchPercent: number;
    resolution: [number, number];
    details: string;
    console_errors?: string[];
    glslSolid?: boolean;
    wgslSolid?: boolean;
    glslVariance?: number[];
    wgslVariance?: number[];
    yFlipDetected?: boolean;
    yFlipCleanFlip?: boolean;
    yFlipMismatchPercent?: number;
    yFlipMeanDiff?: number;
    yFlipRatio?: number;
    issues?: string[];
}
//# sourceMappingURL=types.d.ts.map