const EMPTY_DESCRIPTOR = Object.freeze({})

function normalizeDescriptor(descriptor) {
    return descriptor === undefined ? EMPTY_DESCRIPTOR : descriptor
}

function validateSink(sink) {
    if (!sink || typeof sink.configure !== 'function' || typeof sink.submit !== 'function' || typeof sink.close !== 'function') {
        throw new TypeError('Sink must implement configure, submit, and close')
    }
}

export class CanvasSink {
    constructor(backend) {
        this.backend = backend
        this.descriptor = EMPTY_DESCRIPTOR
        this.closed = false
    }

    configure(descriptor) {
        this.descriptor = normalizeDescriptor(descriptor)
    }

    submit(textureId, time) {
        this.backend.present(textureId)
        return true
    }

    close() {
        if (this.closed) return
        this.closed = true
    }
}

export class SinkManager {
    constructor({ onError } = {}) {
        this._onError = onError
        this._registrations = []
        this._registrationsBySink = new Map()
        this._stats = new Map()
        this._descriptor = EMPTY_DESCRIPTOR
        this._configured = false
        this._closed = false
        this._iterationDepth = 0
        this._hasTombstones = false
    }

    get stats() {
        return this._stats
    }

    add(sink) {
        if (this._closed) {
            throw new Error('SinkManager is closed')
        }

        validateSink(sink)

        if (this._registrationsBySink.has(sink)) {
            throw new Error('Sink is already registered')
        }

        if (this._configured) {
            sink.configure(this._descriptor)
        }

        const registration = {
            sink,
            stats: { accepted: 0, dropped: 0, failed: 0 },
            active: true
        }
        this._registrations.push(registration)
        this._registrationsBySink.set(sink, registration)
        this._stats.set(sink, registration.stats)

        let removed = false
        return () => {
            if (removed) return
            removed = true
            this._removeRegistration(registration)
        }
    }

    remove(sink) {
        this._removeRegistration(this._registrationsBySink.get(sink))
    }

    _removeRegistration(registration) {
        if (!registration || !registration.active) return

        const sink = registration.sink
        registration.active = false
        this._hasTombstones = true
        if (this._registrationsBySink.get(sink) === registration) {
            this._registrationsBySink.delete(sink)
            this._stats.delete(sink)
        }
        registration.sink = null

        try {
            sink.close()
        } finally {
            if (this._iterationDepth === 0) {
                this._compactRegistrations()
            }
        }
    }

    _compactRegistrations() {
        if (!this._hasTombstones) return

        let writeIndex = 0
        for (let readIndex = 0; readIndex < this._registrations.length; readIndex++) {
            const registration = this._registrations[readIndex]
            if (registration.active) {
                this._registrations[writeIndex] = registration
                writeIndex++
            }
        }
        this._registrations.length = writeIndex
        this._hasTombstones = false
    }

    configure(descriptor) {
        if (this._closed) return

        this._descriptor = normalizeDescriptor(descriptor)
        this._configured = true

        this._iterationDepth++
        try {
            for (let i = 0; i < this._registrations.length; i++) {
                const registration = this._registrations[i]
                if (!registration.active) continue
                const sink = registration.sink

                try {
                    sink.configure(this._descriptor)
                } catch (error) {
                    registration.stats.failed++
                    if (typeof this._onError === 'function') {
                        try {
                            this._onError(error, sink)
                        } catch {
                            // Sink error reporters are isolated from rendering.
                        }
                    }
                }
            }
        } finally {
            this._iterationDepth--
            if (this._iterationDepth === 0) {
                this._compactRegistrations()
            }
        }
    }

    submit(textureId, timestamp) {
        if (this._closed) return

        this._iterationDepth++
        try {
            for (let i = 0; i < this._registrations.length; i++) {
                const registration = this._registrations[i]
                if (!registration.active) continue
                const sink = registration.sink
                let result

                try {
                    result = sink.submit(textureId, timestamp)
                } catch (error) {
                    registration.stats.failed++
                    if (typeof this._onError === 'function') {
                        try {
                            this._onError(error, sink)
                        } catch {
                            // Sink error reporters are isolated from rendering.
                        }
                    }
                    continue
                }

                if (result === true) {
                    registration.stats.accepted++
                } else if (result === false) {
                    registration.stats.dropped++
                }
            }
        } finally {
            this._iterationDepth--
            if (this._iterationDepth === 0) {
                this._compactRegistrations()
            }
        }
    }

    close(options) {
        if (this._closed) return

        this._closed = true
        let firstError

        for (let i = 0; i < this._registrations.length; i++) {
            const registration = this._registrations[i]
            if (!registration.active) continue
            const sink = registration.sink
            registration.active = false
            registration.sink = null

            try {
                sink.close(options)
            } catch (error) {
                if (!firstError) firstError = error
            }
        }

        this._registrations.length = 0
        this._registrationsBySink.clear()
        this._stats.clear()
        this._hasTombstones = false

        if (firstError) throw firstError
    }
}
