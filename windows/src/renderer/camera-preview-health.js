'use strict';

// readyState 和 play() 都可能仍对应旧画面；只有新提交的视频帧才能证明预览在更新。
function watchCameraPreview(video, stream, { onReady, onFrame = () => {}, onError, timeoutMs = 8000 }) {
  let stopped = false;
  let ready = false;
  let frameId = null;
  let timer = null;
  let lastTime = video.currentTime;
  const tracks = stream.getVideoTracks();
  const fail = (error) => {
    if (stopped) return;
    stop();
    onError(error);
  };
  const armTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fail(ready ? 'frame_stalled' : 'no_frame'), timeoutMs);
  };
  const frame = () => {
    if (stopped || video.srcObject !== stream) return;
    armTimeout();
    if (!ready) {
      ready = true;
      onReady();
    }
    onFrame();
  };
  const nextFrame = () => {
    frameId = video.requestVideoFrameCallback(() => {
      frameId = null;
      frame();
      if (!stopped) nextFrame();
    });
  };
  const timeUpdate = () => {
    if (video.currentTime === lastTime || video.readyState < 2 || !video.videoWidth) return;
    lastTime = video.currentTime;
    frame();
  };
  const ended = () => fail('device_ended');
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    if (frameId !== null) video.cancelVideoFrameCallback(frameId);
    video.removeEventListener('timeupdate', timeUpdate);
    for (const track of tracks) track.removeEventListener('ended', ended);
  }
  armTimeout();
  for (const track of tracks) track.addEventListener('ended', ended);
  if (!tracks.length || tracks.some((track) => track.readyState === 'ended')) ended();
  else if (typeof video.requestVideoFrameCallback === 'function') nextFrame();
  else video.addEventListener('timeupdate', timeUpdate);
  return stop;
}

module.exports = { watchCameraPreview };
