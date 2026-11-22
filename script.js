async function init() {
  const canvas = document.getElementById("glcanvas");
  const video = document.getElementById("bgVideo");
  const img = document.getElementById("streamImg");

  if (!navigator.gpu) {
    console.error("WebGPU is not supported in this browser.");
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  const presentationFormat = navigator.gpu.getPreferredCanvasFormat();

  context.configure({
    device,
    format: presentationFormat,
    alphaMode: "opaque",
  });

  const shaderModule = device.createShaderModule({
    code: `
      struct Uniforms {
        showStream: f32,
        canvasAspect: f32,
        videoAspect: f32,
        streamAspect: f32,
        bgColor: vec3<f32>,
      };

      @group(0) @binding(0) var<uniform> u: Uniforms;
      @group(0) @binding(1) var mediaSampler: sampler;
      @group(0) @binding(2) var videoTex: texture_2d<f32>;
      @group(0) @binding(3) var streamTex: texture_2d<f32>;

      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
      };

      @vertex
      fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
        var pos = array<vec2<f32>, 4>(
          vec2<f32>(-1.0, -1.0),
          vec2<f32>( 1.0, -1.0),
          vec2<f32>(-1.0,  1.0),
          vec2<f32>( 1.0,  1.0)
        );
        var out: VertexOutput;
        let p = pos[vertexIndex];
        out.position = vec4<f32>(p, 0.0, 1.0);
        out.uv = vec2<f32>(p.x * 0.5 + 0.5, 1.0 - (p.y * 0.5 + 0.5));
        return out;
      }

      fn containUV(uv: vec2<f32>, canvasAspect: f32, mediaAspect: f32) -> vec2<f32> {
        var scale = vec2<f32>(1.0, 1.0);
        if (canvasAspect > mediaAspect) {
          scale.x = mediaAspect / canvasAspect;
        } else {
          scale.y = canvasAspect / mediaAspect;
        }
        return (uv - 0.5) / scale + 0.5;
      }

      fn matchVideoWidthUV(uv: vec2<f32>, canvasAspect: f32, videoAspect: f32, streamAspect: f32) -> vec2<f32> {
        var videoScale = vec2<f32>(1.0, 1.0);
        if (canvasAspect > videoAspect) {
          videoScale.x = videoAspect / canvasAspect;
        } else {
          videoScale.y = canvasAspect / videoAspect;
        }

        var streamScale: vec2<f32>;
        streamScale.x = videoScale.x;
        streamScale.y = (streamScale.x * canvasAspect) / streamAspect;

        return (uv - 0.5) / streamScale + 0.5;
      }

      @fragment
      fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
        let vidUV = containUV(in.uv, u.canvasAspect, u.videoAspect);
        var strUV = matchVideoWidthUV(in.uv, u.canvasAspect, u.videoAspect, u.streamAspect);
        strUV.y += 0.025;

        let vidColor = textureSample(videoTex, mediaSampler, vidUV);
        let strColor = textureSample(streamTex, mediaSampler, strUV);
        let bg = vec4<f32>(u.bgColor, 1.0);

        if (u.showStream < 0.5) {
          if (vidUV.x < 0.0 || vidUV.x > 1.0 || vidUV.y < 0.0 || vidUV.y > 1.0) {
            return bg;
          }
          return vidColor;
        } else {
          if (strUV.x < 0.0 || strUV.x > 1.0 || strUV.y < 0.05 || strUV.y > 1.0) {
            return bg;
          }
          return strColor;
        }
      }
    `,
  });

  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: shaderModule,
      entryPoint: "vs_main",
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [{ format: presentationFormat }],
    },
    primitive: {
      topology: "triangle-strip",
    },
  });

  // 32-byte aligned uniform buffer (8 floats)
  const uniformData = new Float32Array(8);
  uniformData[4] = 19 / 255; // bgColor.r
  uniformData[5] = 18 / 255; // bgColor.g
  uniformData[6] = 20 / 255; // bgColor.b

  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  function createMediaTexture(width, height) {
    const tex = device.createTexture({
      size: [width, height],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.writeTexture(
      { texture: tex },
      new Uint8Array(width * height * 4),
      { bytesPerRow: width * 4 },
      [width, height]
    );
    return tex;
  }

  let videoTex = createMediaTexture(1, 1);
  let streamTex = createMediaTexture(1, 1);
  let videoTexSize = { w: 1, h: 1 };
  let streamTexSize = { w: 1, h: 1 };
  let bindGroup = null;

  function rebuildBindGroup() {
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: videoTex.createView() },
        { binding: 3, resource: streamTex.createView() },
      ],
    });
  }
  rebuildBindGroup();

  function resize() {
    canvas.width = Math.max(1, Math.floor(window.innerWidth * window.devicePixelRatio));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * window.devicePixelRatio));
  }
  window.addEventListener("resize", resize);
  resize();

  function ensureVideoPlaying() {
    if (video.paused) {
      video.play().catch(() => {});
    }
  }
  video.addEventListener("canplay", ensureVideoPlaying);

  // Unified input pool: indices 0–6 are Worker streams, index 7 is the local video
  const WORKER_BASE_URL = "https://stream0.jgang1.workers.dev/";
  const TOTAL_STREAMS = 7;
  const VIDEO_INDEX = TOTAL_STREAMS; // 7
  const TOTAL_INPUTS = TOTAL_STREAMS + 1; // 8 total inputs

  // Per-camera polling intervals (ms) for cameras that serve static snapshots or stall
  // Set to 0 for continuous MJPEG streams that don't need forced polling
  const STREAM_POLL_INTERVALS = {
    0: 15000, // mystic-river-mouth: reconnect every 15s if stalled
    1: 15000, // nyc-trucks: reconnect every 15s if stalled
    2: 15000, // nyc-exercise-bike: reconnect every 15s if stalled
    3: 1000,  // nyc-roof-trees (nph-jpeg.cgi?0): poll every 1s for smooth snapshot updates
    4: 15000, // nyc-street0: reconnect every 15s if stalled
    5: 15000, // nyc-lobby0: reconnect every 15s if stalled
    6: 15000  // nyc-beach: reconnect every 15s if stalled
  };

  let currentInputIndex = -1;
  let showingStream = false;
  let switchTimer = null;
  let pollTimer = null;
  let isPollingInFlight = false;

  // Off-screen preloader image so polling swaps frames seamlessly without black flashes
  const preloaderImg = new Image();
  preloaderImg.crossOrigin = "anonymous";

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    isPollingInFlight = false;
    preloaderImg.onload = null;
    preloaderImg.onerror = null;
  }

  function scheduleNextPoll(camIndex) {
    const interval = STREAM_POLL_INTERVALS[camIndex] || 15000;
    if (!interval || !showingStream || currentInputIndex !== camIndex) return;

    pollTimer = setTimeout(() => {
      if (!showingStream || currentInputIndex !== camIndex || isPollingInFlight) return;

      isPollingInFlight = true;
      const nextUrl = `${WORKER_BASE_URL}?cam=${camIndex}&t=${Date.now()}`;

      preloaderImg.onload = () => {
        isPollingInFlight = false;
        if (showingStream && currentInputIndex === camIndex) {
          img.src = nextUrl;
          scheduleNextPoll(camIndex);
        }
      };

      preloaderImg.onerror = () => {
        isPollingInFlight = false;
        if (showingStream && currentInputIndex === camIndex) {
          scheduleNextPoll(camIndex);
        }
      };

      preloaderImg.src = nextUrl;
    }, interval);
  }

  // Also recover immediately if the active stream connection drops or errors out
  img.addEventListener("error", () => {
    if (showingStream && currentInputIndex >= 0 && currentInputIndex < TOTAL_STREAMS) {
      stopPolling();
      setTimeout(() => {
        if (showingStream && currentInputIndex >= 0 && currentInputIndex < TOTAL_STREAMS) {
          img.src = `${WORKER_BASE_URL}?cam=${currentInputIndex}&t=${Date.now()}`;
          scheduleNextPoll(currentInputIndex);
        }
      }, 1500);
    }
  });

  function getRandomIntervalMs(minSec, maxSec) {
    return (minSec + Math.random() * (maxSec - minSec)) * 1000;
  }

  function switchInput(forcedIndex = null) {
    stopPolling();

    let nextIndex = forcedIndex;
    if (nextIndex === null) {
      nextIndex = currentInputIndex;
      while (nextIndex === currentInputIndex) {
        nextIndex = Math.floor(Math.random() * TOTAL_INPUTS);
      }
    }

    currentInputIndex = nextIndex;

    if (currentInputIndex === VIDEO_INDEX) {
      // Switch to local video & drop any active stream connection
      showingStream = false;
      img.removeAttribute("src");
      ensureVideoPlaying();
    } else {
      // Switch to one of the 7 Worker streams & start its auto-refresh polling
      showingStream = true;
      img.src = `${WORKER_BASE_URL}?cam=${currentInputIndex}&t=${Date.now()}`;
      scheduleNextPoll(currentInputIndex);
    }

    // Stay on this input for a random 40–260 seconds unless clicked
    clearTimeout(switchTimer);
    switchTimer = setTimeout(() => switchInput(), getRandomIntervalMs(40, 260));
  }

  // Clicking anywhere immediately switches to a different random input (video or stream)
  window.addEventListener("click", () => {
    ensureVideoPlaying();
    switchInput();
  });

  // Always start on the local video
  switchInput(VIDEO_INDEX);

  function render() {
    let needsBindGroupUpdate = false;

    if (!showingStream) {
      ensureVideoPlaying();
      if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        if (video.videoWidth !== videoTexSize.w || video.videoHeight !== videoTexSize.h) {
          videoTex.destroy();
          videoTex = createMediaTexture(video.videoWidth, video.videoHeight);
          videoTexSize = { w: video.videoWidth, h: video.videoHeight };
          needsBindGroupUpdate = true;
        }
        try {
          device.queue.copyExternalImageToTexture(
            { source: video },
            { texture: videoTex },
            [video.videoWidth, video.videoHeight]
          );
        } catch (e) {}
      }
    } else {
      if (img.naturalWidth > 0) {
        if (img.naturalWidth !== streamTexSize.w || img.naturalHeight !== streamTexSize.h) {
          streamTex.destroy();
          streamTex = createMediaTexture(img.naturalWidth, img.naturalHeight);
          streamTexSize = { w: img.naturalWidth, h: img.naturalHeight };
          needsBindGroupUpdate = true;
        }
        try {
          device.queue.copyExternalImageToTexture(
            { source: img },
            { texture: streamTex },
            [img.naturalWidth, img.naturalHeight]
          );
        } catch (e) {}
      }
    }

    if (needsBindGroupUpdate) {
      rebuildBindGroup();
    }

    const canvasAspect = canvas.width / canvas.height;
    const videoAspect =
      video.videoWidth && video.videoHeight
        ? video.videoWidth / video.videoHeight
        : canvasAspect;
    const streamAspect =
      img.naturalWidth && img.naturalHeight
        ? img.naturalWidth / (img.naturalHeight * 0.95)
        : videoAspect;

    uniformData[0] = showingStream ? 1.0 : 0.0;
    uniformData[1] = canvasAspect;
    uniformData[2] = videoAspect;
    uniformData[3] = streamAspect;
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const commandEncoder = device.createCommandEncoder();
    const textureView = context.getCurrentTexture().createView();

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 19 / 255, g: 18 / 255, b: 20 / 255, a: 1.0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    renderPass.setPipeline(pipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.draw(4);
    renderPass.end();

    device.queue.submit([commandEncoder.finish()]);
    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}

init();
