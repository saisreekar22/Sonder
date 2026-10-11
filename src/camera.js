// @ts-check
// CameraController — rear-camera acquisition with spoken denial handling (Issue 01).
// System-boundary seam: getUserMedia + speech are injected so tests stay at the
// public start()/stop() interface without touching browser internals.

/** Spoken + on-screen message when the user denies camera permission. */
export const DENIED_MESSAGE =
  'Camera permission was denied. To use EchoPath, open Chrome site Settings, allow the camera, then press Start again.';

/** Default constraints: rear camera, 1280px ideal width (stepped down later by Issue 08). */
export const CAMERA_CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
};

/**
 * @typedef {object} CameraDeps
 * @property {(constraints: MediaStreamConstraints) => Promise<MediaStream>} getUserMedia
 * @property {(message: string) => void} speak
 */

/**
 * @param {CameraDeps} deps
 */
export function createCameraController({ getUserMedia, speak }) {
  /** @type {MediaStream | null} */
  let stream = null;

  async function start() {
    try {
      stream = await getUserMedia(CAMERA_CONSTRAINTS);
      return stream;
    } catch (err) {
      if (err && typeof err === 'object' && /** @type {any} */ (err).name === 'NotAllowedError') {
        speak(DENIED_MESSAGE);
      }
      throw err;
    }
  }

  function stop() {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
  }

  function getStream() {
    return stream;
  }

  return { start, stop, getStream };
}
