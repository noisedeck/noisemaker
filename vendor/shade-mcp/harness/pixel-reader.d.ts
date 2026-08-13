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
/**
 * Compute statistical metrics from RGBA pixel data.
 * Handles both Uint8Array (0-255) and Float32Array (0-1) input.
 * Samples ~1000 pixels via strided iteration for performance.
 *
 * This is the library-mode entry point — consumers that read pixels in Node
 * (see the harness barrel) call it directly. The browser tools do NOT: their
 * metrics run inside `page.evaluate`, whose body is serialized to the browser
 * and cannot reference a Node import. The near-duplicate loops in
 * `tools/browser/render.ts` and `tools/browser/dsl.ts` exist for that reason
 * and cannot be collapsed into this function.
 *
 * They are not interchangeable, and the difference is deliberate to preserve:
 * this function calls a frame blank when it is dark with few distinct colors,
 * while the in-page version calls it blank when luma variance is near zero
 * (flat, at any brightness). Verifying a change to the in-page rule needs a
 * real browser and viewer, so it is left as shipped.
 */
export declare function computeImageMetrics(data: Uint8Array | Float32Array, width: number, height: number): ImageMetrics;
//# sourceMappingURL=pixel-reader.d.ts.map