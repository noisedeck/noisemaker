/**
 * Abstract Backend Interface
 * Defines the contract that both WebGL2 and WebGPU backends must implement.
 */

/* eslint-disable no-unused-vars */

export class Backend {
    constructor(context) {
        this.context = context
        this.textures = new Map() // physicalId -> GPU texture handle
        this.programs = new Map() // programId -> compiled program/pipeline
        this.uniformBuffers = new Map() // bufferId -> buffer handle

        /**
         * Device capabilities detected at initialization.
         * Used for graceful degradation on mobile devices.
         * @type {{isMobile: boolean, floatBlend: boolean, floatLinear: boolean, colorBufferFloat: boolean, maxDrawBuffers: number, maxTextureSize: number, maxColorBytesPerSample: number, maxStateSize: number}}
         */
        this.capabilities = {
            isMobile: false,
            floatBlend: true,
            floatLinear: true,
            colorBufferFloat: true,
            maxDrawBuffers: 8,
            maxTextureSize: 4096,
            maxColorBytesPerSample: 64,
            maxStateSize: 2048  // Default max particle state texture size
        }
    }

    /**
     * Initialize the backend
     * @returns {Promise<void>}
     */
    async init() {
        throw new Error('Backend.init() must be implemented')
    }

    /**
     * Create a texture with the specified parameters
     * @param {string} id - Physical texture ID
     * @param {object} spec - { width, height, format, usage }
     * @returns {object} Texture handle
     */
    createTexture(id, spec) {
        throw new Error('Backend.createTexture() must be implemented')
    }

    /**
     * Create a 3D texture for volumetric data
     * @param {string} id - Physical texture ID
     * @param {object} spec - { width, height, depth, format, usage }
     * @returns {object} Texture handle
     */
    createTexture3D(id, spec) {
        throw new Error('Backend.createTexture3D() must be implemented')
    }

    /**
     * Destroy a texture
     * @param {string} id - Physical texture ID
     */
    destroyTexture(id) {
        throw new Error('Backend.destroyTexture() must be implemented')
    }

    /**
     * Compile a shader program
     * @param {string} id - Program ID
     * @param {object} spec - { source, type, defines }
     * @returns {Promise<object>} Compiled program/pipeline
     */
    async compileProgram(id, spec) {
        throw new Error('Backend.compileProgram() must be implemented')
    }

    /**
     * Execute a render pass
     * @param {object} pass - Pass specification
     * @param {object} state - Current frame state
     */
    executePass(pass, state) {
        throw new Error('Backend.executePass() must be implemented')
    }

    /**
     * Begin a frame
     * @param {object} state - Frame state
     */
    beginFrame(state) {
        throw new Error('Backend.beginFrame() must be implemented')
    }

    /**
     * End a frame
     */
    endFrame() {
        throw new Error('Backend.endFrame() must be implemented')
    }

    /**
     * Copy one texture to another (blit operation)
     * Used for surface copy operations.
     * @param {string} srcId - Source texture ID
     * @param {string} dstId - Destination texture ID
     */
    copyTexture(srcId, dstId) {
        throw new Error('Backend.copyTexture() must be implemented')
    }

    /**
     * Clear a texture to transparent black.
     * Used to clear surfaces when chains are deleted.
     * @param {string} id - Texture ID
     */
    clearTexture(id) {
        // Optional - concrete backends may implement this
    }

    /**
     * Create a frame export queue when supported by a concrete backend.
     * @param {object} options
     * @returns {object|null}
     */
    createFrameExportQueue(options) {
        return null
    }

    /**
     * Resolve once all submitted GPU work has completed.
     *
     * Applies backpressure for callers that drive many frames in a row without
     * a compositor to pace them (offline renders, long-running tests); without
     * it they queue work faster than the GPU retires it.
     * @returns {Promise<void>}
     */
    async waitForIdle() {
        // Optional - concrete backends may implement this
    }

    /**
     * Get backend name
     * @returns {string}
     */
    getName() {
        throw new Error('Backend.getName() must be implemented')
    }

    /**
     * Check if backend is available
     * @returns {boolean}
     */
    static isAvailable() {
        throw new Error('Backend.isAvailable() must be implemented')
    }

    /**
     * Destroy backend resources
     * @param {object} options
     */
    destroy(options = {}) {
        // Optional for concrete backends
    }
}

/* eslint-enable no-unused-vars */
