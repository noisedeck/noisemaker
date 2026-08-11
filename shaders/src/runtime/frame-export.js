function validateAdapter(adapter) {
    if (!adapter ||
        typeof adapter.createSlot !== 'function' ||
        typeof adapter.begin !== 'function' ||
        typeof adapter.poll !== 'function' ||
        typeof adapter.read !== 'function' ||
        typeof adapter.destroySlot !== 'function') {
        throw new TypeError('Frame export adapter must implement createSlot, begin, poll, read, and destroySlot')
    }
}

export class FrameExportQueue {
    constructor(adapter, { slots = 3, onError } = {}) {
        validateAdapter(adapter)
        if (!Number.isInteger(slots) || slots < 2 || slots > 8) {
            throw new RangeError('Frame export slots must be an integer from 2 through 8')
        }

        this.adapter = adapter
        this._onError = onError
        this._slots = new Array(slots)
        for (let i = 0; i < slots; i++) {
            this._slots[i] = {
                adapterSlot: null,
                created: false,
                pending: false,
                textureId: null,
                timestamp: undefined,
                onFrame: null,
                context: undefined
            }
        }
        this._configured = false
        this._closed = false
        this.stats = { accepted: 0, dropped: 0, completed: 0, failed: 0 }
    }

    get available() {
        if (!this._configured || this._closed) return false

        for (let i = 0; i < this._slots.length; i++) {
            if (!this._slots[i].pending) return true
        }
        return false
    }

    configure(descriptor) {
        if (this._closed) return

        const destroyError = this._destroySlots()
        this._configured = false
        if (destroyError) throw destroyError

        try {
            for (let i = 0; i < this._slots.length; i++) {
                const record = this._slots[i]
                record.adapterSlot = this.adapter.createSlot(i, descriptor)
                record.created = true
            }
        } catch (error) {
            const cleanupError = this._destroySlots()
            if (cleanupError) this._report(cleanupError)
            throw error
        }
        this._configured = true
    }

    enqueue(textureId, timestamp, onFrame, context) {
        if (typeof onFrame !== 'function') {
            throw new TypeError('Frame export callback must be a function')
        }
        if (!this._configured || this._closed) {
            this.stats.dropped++
            return false
        }

        let record = null
        for (let i = 0; i < this._slots.length; i++) {
            if (!this._slots[i].pending) {
                record = this._slots[i]
                break
            }
        }
        if (!record) {
            this.stats.dropped++
            return false
        }

        record.pending = true
        record.textureId = textureId
        record.timestamp = timestamp
        record.onFrame = onFrame
        record.context = context
        try {
            this.adapter.begin(record.adapterSlot, textureId, timestamp)
        } catch (error) {
            this._release(record)
            this.stats.failed++
            this._report(error)
            return false
        }

        this.stats.accepted++
        return true
    }

    poll() {
        if (!this._configured || this._closed) return

        for (let i = 0; i < this._slots.length; i++) {
            const record = this._slots[i]
            if (!record.pending) continue

            let frame
            let timestamp
            let onFrame
            let context
            try {
                const ready = this.adapter.poll(record.adapterSlot)
                if (ready === false) continue
                if (ready !== true) {
                    throw new TypeError('Frame export adapter poll must return a boolean')
                }

                frame = this.adapter.read(record.adapterSlot)
                timestamp = record.timestamp
                onFrame = record.onFrame
                context = record.context
            } catch (error) {
                this._release(record)
                this.stats.failed++
                this._report(error)
                continue
            }

            this._release(record)
            try {
                onFrame(frame, timestamp, context)
                this.stats.completed++
            } catch (error) {
                this.stats.failed++
                this._report(error)
            }
        }
    }

    close(options = {}) {
        if (this._closed) return

        this._closed = true
        this._configured = false
        let destroyError
        if (options.backendLost === true) {
            this._abandonSlots()
        } else {
            destroyError = this._destroySlots()
        }
        this.adapter = null
        if (destroyError) throw destroyError
    }

    _release(record) {
        record.pending = false
        record.textureId = null
        record.timestamp = undefined
        record.onFrame = null
        record.context = undefined
    }

    _destroySlots() {
        let firstError

        for (let i = 0; i < this._slots.length; i++) {
            const record = this._slots[i]
            if (!record.created) continue

            const adapterSlot = record.adapterSlot
            record.created = false
            record.adapterSlot = null
            this._release(record)
            try {
                this.adapter.destroySlot(adapterSlot)
            } catch (error) {
                if (!firstError) firstError = error
            }
        }
        return firstError
    }

    _abandonSlots() {
        for (let i = 0; i < this._slots.length; i++) {
            const record = this._slots[i]
            record.created = false
            record.adapterSlot = null
            this._release(record)
        }
    }

    _report(error) {
        if (typeof this._onError !== 'function') return
        try {
            this._onError(error)
        } catch {
            // Export error reporters are isolated from queue progress.
        }
    }
}
