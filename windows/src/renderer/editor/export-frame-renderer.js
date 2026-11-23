'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { evaluateBackground } = require('../../core/model');
const { orderedClips } = require('../../core/zoom');
const { PointerTrack } = require('../../core/pointer');
const { evaluateScene } = require('../../core/scene');
const timeline = require('../../core/timeline');
const { Compositor, cameraCoversCanvas } = require('./render');
const { FrameSource } = require('./frame-source');

function loadPointerTrack(directory, project) {
  if (!project.media.pointer) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(directory, project.media.pointer), 'utf8'));
    return new PointerTrack(data.events);
  } catch {
    return null;
  }
}

async function openVideoFrames({ project, directory, width, height, frameRate, hardware, indexes }) {
  const { segments } = project.timeline;
  const screen = project.media.screen;
  const camera = project.media.camera && !project.camera.isHidden ? project.media.camera : null;
  const background = project.canvas.background?.kind === 'video' ? project.canvas.background : null;
  const compositor = new Compositor(directory);
  await compositor.prepare(project);
  const zoomClips = orderedClips(project.zoomAnimations);
  const pointerTrack = loadPointerTrack(directory, project);
  const sources = [];
  const close = () => { for (const source of sources) source.close(); };
  function sourceFor(track, index) {
    if (!track) return null;
    const source = new FrameSource(path.join(directory, track.file), index, hardware);
    sources.push(source);
    return source;
  }
  try {
    const screenSource = sourceFor(screen, indexes.screen);
    const cameraSource = sourceFor(camera, indexes.camera);
    const backgroundSource = sourceFor(background, indexes.background);
    for (const source of sources) await source.open();

    async function draw(ctx, n, wait = (promise) => promise) {
      const outputTime = n / frameRate;
      const sourceTime = timeline.locate(segments, outputTime).sourceTime;
      const frames = { screen: null, camera: null, background: null };
      const cameraTime = cameraSource ? sourceTime - ((camera.offset || 0) + (project.camera?.timeOffset || 0)) : -1;
      const hasCamera = cameraTime >= 0 && cameraTime <= camera.duration;
      const cameraAspect = hasCamera ? camera.width / camera.height : null;
      const scene = evaluateScene(project, { time: sourceTime, outputTime, width, height, sourceAspect: screen.width / screen.height, cameraAspect, zoomClips, pointerTrack });
      if (hasCamera) frames.camera = await wait(cameraSource.frameAt(cameraTime), '解码摄像头画面');
      if (!frames.camera || !cameraCoversCanvas(scene)) {
        frames.screen = await wait(screenSource.frameAt(sourceTime), '解码屏幕画面');
        if (backgroundSource) {
          const duration = background.duration || Math.max(backgroundSource.lastTime - backgroundSource.firstTime, 0);
          const backgroundTime = evaluateBackground(project.canvas, outputTime, { duration }).time;
          frames.background = await wait(backgroundSource.frameAt(backgroundTime), '解码动态背景');
        }
      }
      compositor.draw(ctx, project, scene, frames);
      return { sourceTime, scene };
    }
    return { draw, close };
  } catch (error) {
    close();
    throw error;
  }
}

module.exports = { openVideoFrames, loadPointerTrack };
