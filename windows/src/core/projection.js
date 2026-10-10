'use strict';
// 屏幕投影几何计算：四边形单应性矩阵映射、透视投影、包含检测。
// 移植自 RecorderCore/ScreenProjection.swift。

class ProjectedScreenPointMapper {
  constructor(quad, sourceRect) {
    if (
      !sourceRect ||
      !Number.isFinite(sourceRect.width) ||
      !Number.isFinite(sourceRect.height) ||
      sourceRect.width <= 0 ||
      sourceRect.height <= 0
    ) {
      this.valid = false;
      return;
    }

    const corners = quad ? quad.corners : null;
    if (
      !corners ||
      corners.length !== 4 ||
      !corners.every((pt) => pt && Number.isFinite(pt.x) && Number.isFinite(pt.y))
    ) {
      this.valid = false;
      return;
    }

    const dx1 = quad.topRight.x - quad.bottomRight.x;
    const dx2 = quad.bottomLeft.x - quad.bottomRight.x;
    const dx3 = quad.topLeft.x - quad.topRight.x + quad.bottomRight.x - quad.bottomLeft.x;
    const dy1 = quad.topRight.y - quad.bottomRight.y;
    const dy2 = quad.bottomLeft.y - quad.bottomRight.y;
    const dy3 = quad.topLeft.y - quad.topRight.y + quad.bottomRight.y - quad.bottomLeft.y;
    const denominator = dx1 * dy2 - dx2 * dy1;

    let perspectiveX = 0;
    let perspectiveY = 0;

    if (Math.abs(dx3) <= 1e-9 && Math.abs(dy3) <= 1e-9) {
      perspectiveX = 0;
      perspectiveY = 0;
    } else {
      if (Math.abs(denominator) <= 1e-9) {
        this.valid = false;
        return;
      }
      perspectiveX = (dx3 * dy2 - dx2 * dy3) / denominator;
      perspectiveY = (dx1 * dy3 - dx3 * dy1) / denominator;
    }

    this.sourceRect = {
      x: sourceRect.x,
      y: sourceRect.y,
      width: sourceRect.width,
      height: sourceRect.height,
    };
    this.topLeft = { x: quad.topLeft.x, y: quad.topLeft.y };
    this.perspectiveX = perspectiveX;
    this.perspectiveY = perspectiveY;

    this.a = quad.topRight.x - quad.topLeft.x + perspectiveX * quad.topRight.x;
    this.b = quad.bottomLeft.x - quad.topLeft.x + perspectiveY * quad.bottomLeft.x;
    this.d = quad.topRight.y - quad.topLeft.y + perspectiveX * quad.topRight.y;
    this.e = quad.bottomLeft.y - quad.topLeft.y + perspectiveY * quad.bottomLeft.y;
    this.valid = true;
  }

  project(point) {
    if (!this.valid || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return null;
    }
    const x = (point.x - this.sourceRect.x) / this.sourceRect.width;
    const y = (point.y - this.sourceRect.y) / this.sourceRect.height;
    const divisor = this.perspectiveX * x + this.perspectiveY * y + 1;
    if (!Number.isFinite(divisor) || Math.abs(divisor) <= 1e-9) {
      return null;
    }
    const px = (this.a * x + this.b * y + this.topLeft.x) / divisor;
    const py = (this.d * x + this.e * y + this.topLeft.y) / divisor;
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      return null;
    }
    return { x: px, y: py };
  }

  unproject(point) {
    if (!this.valid || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return null;
    }
    const aa = this.a - point.x * this.perspectiveX;
    const bb = this.b - point.x * this.perspectiveY;
    const dd = this.d - point.y * this.perspectiveX;
    const ee = this.e - point.y * this.perspectiveY;
    const determinant = aa * ee - bb * dd;
    if (Math.abs(determinant) <= 1e-9) {
      return null;
    }
    const x = point.x - this.topLeft.x;
    const y = point.y - this.topLeft.y;
    const u = (x * ee - bb * y) / determinant;
    const v = (aa * y - x * dd) / determinant;
    const rx = this.sourceRect.x + u * this.sourceRect.width;
    const ry = this.sourceRect.y + v * this.sourceRect.height;
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) {
      return null;
    }
    return { x: rx, y: ry };
  }
}

class ProjectedScreenQuad {
  constructor(topLeft, topRight, bottomRight, bottomLeft) {
    this.topLeft = topLeft;
    this.topRight = topRight;
    this.bottomRight = bottomRight;
    this.bottomLeft = bottomLeft;
  }

  get corners() {
    return [this.topLeft, this.topRight, this.bottomRight, this.bottomLeft];
  }

  get bounds() {
    const pts = this.corners;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      x: minX,
      y: minY,
      width: Math.max(maxX - minX, 0),
      height: Math.max(maxY - minY, 0),
    };
  }

  get center() {
    const pts = this.corners;
    return {
      x: pts.reduce((sum, p) => sum + p.x, 0) / 4,
      y: pts.reduce((sum, p) => sum + p.y, 0) / 4,
    };
  }

  get resizeHandlePoint() {
    return this.bottomRight;
  }

  projector(sourceRect) {
    const mapper = new ProjectedScreenPointMapper(this, sourceRect);
    return mapper.valid ? mapper : null;
  }

  project(point, sourceRect) {
    const mapper = this.projector(sourceRect);
    return mapper ? mapper.project(point) : null;
  }

  unproject(point, sourceRect) {
    const mapper = this.projector(sourceRect);
    return mapper ? mapper.unproject(point) : null;
  }

  semanticResizeDelta(translation, referenceLength) {
    if (
      !translation ||
      !Number.isFinite(translation.x) ||
      !Number.isFinite(translation.y) ||
      !Number.isFinite(referenceLength)
    ) {
      return 0;
    }
    const dx = this.resizeHandlePoint.x - this.topLeft.x;
    const dy = this.resizeHandlePoint.y - this.topLeft.y;
    const length = Math.hypot(dx, dy);
    if (length <= 1e-6) return 0;
    const unitX = dx / length;
    const unitY = dy / length;
    const projectedTravel = translation.x * unitX + translation.y * unitY;
    const identityEquivalentGain = Math.abs(unitX) + Math.abs(unitY);
    return (projectedTravel * identityEquivalentGain) / Math.max(referenceLength, 1);
  }

  contains(point, tolerance = 1e-6) {
    return contains(point, this, tolerance);
  }
}

function cross(start, end, point) {
  return (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
}

function pointLiesOnSegment(point, start, end, tolerance) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= tolerance * tolerance) {
    return Math.hypot(point.x - start.x, point.y - start.y) <= tolerance;
  }
  const parameter = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  if (parameter < -tolerance || parameter > 1 + tolerance) {
    return false;
  }
  const nearest = {
    x: start.x + parameter * dx,
    y: start.y + parameter * dy,
  };
  return Math.hypot(point.x - nearest.x, point.y - nearest.y) <= tolerance;
}

function contains(point, quad, tolerance = 1e-6) {
  if (
    !point ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isFinite(tolerance) ||
    !quad
  ) {
    return false;
  }
  const corners = quad.corners || [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  if (!corners.every((pt) => pt && Number.isFinite(pt.x) && Number.isFinite(pt.y))) {
    return false;
  }

  const epsilon = Math.max(tolerance, 0);
  let twiceArea = 0;
  for (let i = 0; i < corners.length; i++) {
    const start = corners[i];
    const end = corners[(i + 1) % corners.length];
    twiceArea += start.x * end.y - end.x * start.y;
  }
  if (Math.abs(twiceArea) <= epsilon) {
    return false;
  }

  let windingNumber = 0;
  for (let i = 0; i < corners.length; i++) {
    const start = corners[i];
    const end = corners[(i + 1) % corners.length];

    if (pointLiesOnSegment(point, start, end, epsilon)) {
      return true;
    }

    if (start.y <= point.y) {
      if (end.y > point.y && cross(start, end, point) > epsilon) {
        windingNumber += 1;
      }
    } else if (end.y <= point.y && cross(start, end, point) < -epsilon) {
      windingNumber -= 1;
    }
  }

  return windingNumber !== 0;
}

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

class ScreenProjection {
  static project({
    rect,
    rotationX = 0,
    rotationY = 0,
    rotationZ = 0,
    perspective = 0,
    anchor = null,
  }) {
    const safeWidth = Math.max(rect.width, 0);
    const safeHeight = Math.max(rect.height, 0);
    const midX = rect.x + safeWidth / 2;
    const midY = rect.y + safeHeight / 2;
    const pivot =
      anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
        ? anchor
        : { x: midX, y: midY };

    const maximumDimension = Math.max(rect.width, rect.height, 1);
    const depth = Math.min(Math.max(perspective, 0), 2);
    const cameraDistance =
      depth > 0 ? (maximumDimension * 2) / Math.max(depth, 0.0001) : Infinity;

    const rx = degreesToRadians(rotationX);
    const ry = degreesToRadians(rotationY);
    const rz = degreesToRadians(rotationZ);
    const sinX = Math.sin(rx);
    const cosX = Math.cos(rx);
    const sinY = Math.sin(ry);
    const cosY = Math.cos(ry);
    const sinZ = Math.sin(rz);
    const cosZ = Math.cos(rz);

    function transformPoint(x, y) {
      // Rotate around X, then Y, then Z. Screen plane is at z=0.
      const xAfterX = x;
      const yAfterX = y * cosX;
      const zAfterX = y * sinX;

      const xAfterY = xAfterX * cosY + zAfterX * sinY;
      const yAfterY = yAfterX;
      const zAfterY = -xAfterX * sinY + zAfterX * cosY;

      const xAfterZ = xAfterY * cosZ - yAfterY * sinZ;
      const yAfterZ = xAfterY * sinZ + yAfterY * cosZ;

      let projectionScale = 1;
      if (Number.isFinite(cameraDistance)) {
        const denominator = Math.max(cameraDistance - zAfterY, cameraDistance * 0.12);
        projectionScale = cameraDistance / denominator;
      }

      return {
        x: pivot.x + xAfterZ * projectionScale,
        y: pivot.y + yAfterZ * projectionScale,
      };
    }

    const topLeft = transformPoint(rect.x - pivot.x, rect.y - pivot.y);
    const topRight = transformPoint(rect.x + safeWidth - pivot.x, rect.y - pivot.y);
    const bottomRight = transformPoint(rect.x + safeWidth - pivot.x, rect.y + safeHeight - pivot.y);
    const bottomLeft = transformPoint(rect.x - pivot.x, rect.y + safeHeight - pivot.y);

    return new ProjectedScreenQuad(topLeft, topRight, bottomRight, bottomLeft);
  }
}

module.exports = {
  ScreenProjection,
  ProjectedScreenQuad,
  ProjectedScreenPointMapper,
  contains,
};
