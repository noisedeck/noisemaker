Renderer Output
===============

``CanvasRenderer`` normally presents the selected ``render(oN)`` surface to
its canvas. Output sinks let a host send that same rendered surface to
additional destinations. The bounded frame-export queue provides an
asynchronous GPU-to-CPU path for recording, streaming, or analysis.

Both APIs require an active compiled pipeline and belong to that pipeline.
A successful in-place recompile preserves its registered sinks. The following
actions close the old sinks:

- Switching backends
- Disposing the renderer
- A fallback that replaces the pipeline

The host must register new sinks on the replacement pipeline.

Output Sinks
------------

A sink implements three methods:

.. code-block:: javascript

    const sink = {
        configure(descriptor) {},
        submit(textureId, presentationTimestamp) { return true },
        close(options) {}
    }

    const remove = renderer.addSink(sink)

    // Later: unregister and close the sink. Repeated calls are safe.
    remove()

``configure(descriptor)``
    Receives the current output dimensions and format. It runs when the
    pipeline resizes. It also runs immediately when the host adds a sink to an
    already configured pipeline.

``submit(textureId, presentationTimestamp)``
    Receives the selected output texture once per rendered frame. Return
    ``true`` when the sink accepts the frame or ``false`` when it drops the frame.
    Throwing from one sink does not stop the remaining sinks or the renderer.

``close(options)``
    Releases sink resources. During backend loss, ``options.backendLost`` is
    ``true`` so the sink can abandon invalid GPU resources without trying to
    destroy them.

The pipeline supplies this descriptor:

.. code-block:: javascript

    {
        width,
        height,
        format: 'rgba8unorm',
        colorSpace: 'srgb',
        alphaMode: 'premultiplied',
        fps: 60
    }

Per-sink counters are available from
``renderer.pipeline.sinkManager.stats.get(sink)`` as ``accepted``, ``dropped``,
and ``failed`` while the sink is registered. Copy them before calling the
removal function if you need them afterward.

Asynchronous Frame Export
-------------------------

``createFrameExportQueue()`` creates a fixed ring of reusable readback slots.
The default is three slots. The ``slots`` value may be any integer from 2 through 8.
When every slot is busy, ``enqueue()`` returns ``false`` immediately instead
of blocking the render loop.

``FrameExportQueue`` is not itself a sink. Adapt it with a small sink.
Poll the queue from the host event loop:

.. code-block:: javascript

    // Compile before creating or registering output resources.
    await renderer.compile(dsl)

    const queue = renderer.createFrameExportQueue({
        slots: 3,
        onError(error) {
            console.error('Frame export failed', error)
        }
    })

    if (!queue) {
        throw new Error('The active backend does not support frame export')
    }

    function consumeFrame(frame, timestamp, context) {
        // frame.data is a top-down Uint8Array of tightly packed RGBA8 rows.
        // Copy it if work will retain the pixels across later callbacks.
        uploadFrame({
            width: frame.width,
            height: frame.height,
            rowStride: frame.rowStride,
            data: frame.data.slice(),
            timestamp,
            context
        })
    }

    const exportSink = {
        configure(descriptor) {
            queue.configure({ ...descriptor, alphaMode: 'straight' })
        },
        submit(textureId, timestamp) {
            return queue.enqueue(textureId, timestamp, consumeFrame, {
                source: 'preview'
            })
        },
        close(options) {
            queue.close(options)
        }
    }

    const removeExportSink = renderer.addSink(exportSink)

    let pollExports = true
    function serviceExports() {
        if (!pollExports) return
        queue.poll()
        requestAnimationFrame(serviceExports)
    }
    serviceExports()

    // Later: stop polling, then unregister and close the queue-backed sink.
    pollExports = false
    removeExportSink()

The host must call ``poll()``. The queue does not create a timer. A completed
callback receives ``(frame, timestamp, context)``. The timestamp and optional
context are the same values passed to ``enqueue()``. ``queue.available`` says
whether a configured, open queue currently has a free slot, and ``queue.stats``
tracks ``accepted``, ``dropped``, ``completed``, and ``failed`` frames.

.. warning::

    Reconfiguring or closing a queue releases pending frames without invoking
    their callbacks or incrementing ``completed``, ``failed``, or ``dropped``.
    If terminal delivery or accounting is required, do not reconfigure or close
    the queue while accepted frames are pending.

Frame Format and Backends
-------------------------

The current WebGL2 and WebGPU backends both support frame export. Both deliver
the same frame contract:

.. code-block:: javascript

    {
        width,
        height,
        rowStride: width * 4,
        data: Uint8Array // top-down, tightly packed RGBA8
    }

Each slot reuses its frame object and pixel array. Copy ``frame.data`` before a
later delivery on the same slot if the consumer needs to retain it.

The export descriptor accepts ``straight``, ``opaque``, and ``premultiplied``
alpha modes. ``straight`` preserves RGBA, ``opaque`` forces alpha to one, and
``premultiplied`` multiplies RGB by alpha. The adapters validate ``colorSpace`` and ``fps`` as metadata. They do not
convert colors or throttle the frame rate.

Frame export does not relax the pipeline rule against synchronous GPU readback
inside an effect pass. It is a bounded asynchronous host-output path, serviced
after rendering through the sink boundary.
