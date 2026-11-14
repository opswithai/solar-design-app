// Auto panel layout engine (pure functions, no map code).
// Works in a local flat metric frame around the roof, which is accurate for areas up to a few km.
import * as turf from '@turf/turf';
import type { Feature, Polygon, MultiPolygon } from 'geojson';

export type LngLat = [number, number];

export interface ModuleSpec {
  name: string;
  watts: number; // Wp
  length: number; // m (long side)
  width: number; // m (short side)
}

export interface Segment {
  id: string;
  name: string;
  ring: LngLat[]; // open ring (first point not repeated)
  mount: 'flush' | 'tilted'; // flush = on sloped roof; tilted = racks on flat roof / ground
  tilt: number; // degrees
  azimuth: number; // degrees, direction modules face (180 = south)
  orientation: 'portrait' | 'landscape';
  setback: number; // m from roof edge
  rowSpacing: 'auto' | 'manual';
  rowGap: number; // m, clear gap between rows when manual
  moduleGap: number; // m between modules in a row
}

export interface Keepout {
  id: string;
  name: string;
  ring: LngLat[];
  setback: number; // m clearance around obstruction
  height: number; // m (used for shading in a later milestone)
}

export interface LayoutResult {
  panels: LngLat[][]; // each panel as 4 corners (lon/lat)
  count: number;
  kwp: number;
  roofAreaM2: number;
  rowGap: number; // clear gap actually used between rows
  pitch: number; // row-to-row distance
}

export const DEFAULT_MODULE: ModuleSpec = { name: '550 W mono PERC', watts: 550, length: 2.278, width: 1.134 };

const DEG = Math.PI / 180;

// ---------- solar geometry ----------

/** Sun altitude and azimuth (deg from north) at winter solstice for a latitude and solar hour. */
export function solsticeSun(latDeg: number, solarHour: number) {
  const north = latDeg >= 0;
  const decl = (north ? -23.44 : 23.44) * DEG; // winter solstice for the hemisphere
  const lat = latDeg * DEG;
  const h = 15 * (solarHour - 12) * DEG;
  const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(h);
  const alt = Math.asin(sinAlt);
  let cosAz = (Math.sin(decl) - sinAlt * Math.sin(lat)) / (Math.cos(alt) * Math.cos(lat));
  cosAz = Math.max(-1, Math.min(1, cosAz));
  let az = Math.acos(cosAz) / DEG;
  if (h > 0) az = 360 - az;
  return { altitude: alt / DEG, azimuth: az };
}

/**
 * Clear gap between tilted rows so the front row does not shade the next row
 * between 09:00 and 15:00 solar time on the winter solstice.
 */
export function autoRowGap(latDeg: number, tiltDeg: number, slopeLength: number, facingAz: number) {
  const height = slopeLength * Math.sin(tiltDeg * DEG);
  if (height <= 0) return 0;
  let gap = 0;
  for (let t = 9; t <= 15; t += 0.5) {
    const sun = solsticeSun(latDeg, t);
    if (sun.altitude <= 1) continue;
    const behind = Math.cos((sun.azimuth - facingAz) * DEG); // shadow component cast behind the row
    if (behind <= 0) continue;
    gap = Math.max(gap, (height * behind) / Math.tan(sun.altitude * DEG));
  }
  return gap;
}

// ---------- flat geometry helpers ----------

type P = [number, number];
type Ring = P[];
type Poly = Ring[]; // outer ring + holes

function pointInRing(p: P, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPoly(p: P, poly: Poly) {
  if (!pointInRing(p, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (pointInRing(p, poly[k])) return false;
  return true;
}

function segIntersect(a: P, b: P, c: P, d: P) {
  const cross = (o: P, p: P, q: P) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function ringsCross(r1: Ring, r2: Ring) {
  for (let i = 0; i < r1.length; i++) {
    const a = r1[i], b = r1[(i + 1) % r1.length];
    for (let j = 0; j < r2.length; j++) {
      if (segIntersect(a, b, r2[j], r2[(j + 1) % r2.length])) return true;
    }
  }
  return false;
}

function rectInside(rect: Ring, polys: Poly[]) {
  return polys.some(
    (poly) => rect.every((c) => pointInPoly(c, poly)) && !poly.some((ring) => ringsCross(rect, ring)),
  );
}

function rectHits(rect: Ring, obstacle: Poly) {
  if (rect.some((c) => pointInPoly(c, obstacle))) return true;
  if (obstacle[0].some((c) => pointInRing(c, rect))) return true;
  return ringsCross(rect, obstacle[0]);
}

function closeRing(r: LngLat[]): LngLat[] {
  const f = r[0], l = r[r.length - 1];
  return f[0] === l[0] && f[1] === l[1] ? r : [...r, f];
}

function toPolys(f: Feature<Polygon | MultiPolygon> | null | undefined): LngLat[][][] {
  if (!f) return [];
  if (f.geometry.type === 'Polygon') return [f.geometry.coordinates as LngLat[][]];
  return f.geometry.coordinates as LngLat[][][];
}

// ---------- main layout ----------

export function layoutSegment(seg: Segment, keepouts: Keepout[], mod: ModuleSpec): LayoutResult {
  const empty = (area: number, gap = 0, pitch = 0): LayoutResult => ({ panels: [], count: 0, kwp: 0, roofAreaM2: area, rowGap: gap, pitch });
  if (seg.ring.length < 3) return empty(0);

  const roof = turf.polygon([closeRing(seg.ring)]);
  const roofArea = turf.area(roof);
  const [lon0, lat0] = turf.centroid(roof).geometry.coordinates;

  // local metric frame (x east, y north) rotated so rows run along "a" and modules face toward -"b"
  const kx = 111320 * Math.cos(lat0 * DEG), ky = 110540;
  const az = seg.azimuth * DEG;
  const u: P = [-Math.cos(az), Math.sin(az)];
  const v: P = [-Math.sin(az), -Math.cos(az)];
  const fwd = ([lon, lat]: LngLat): P => {
    const x = (lon - lon0) * kx, y = (lat - lat0) * ky;
    return [x * u[0] + y * u[1], x * v[0] + y * v[1]];
  };
  const back = ([a, b]: P): LngLat => {
    const x = a * u[0] + b * v[0], y = a * u[1] + b * v[1];
    return [lon0 + x / kx, lat0 + y / ky];
  };

  let allowedF: Feature<Polygon | MultiPolygon> | null | undefined = roof;
  if (seg.setback > 0) allowedF = turf.buffer(roof, -seg.setback, { units: 'meters' }) as typeof allowedF;
  const allowed: Poly[] = toPolys(allowedF).map((p) => p.map((r) => r.slice(0, -1).map(fwd)));

  const obstacles: Poly[] = [];
  for (const k of keepouts) {
    if (k.ring.length < 3) continue;
    const kp = turf.polygon([closeRing(k.ring)]);
    if (!turf.booleanIntersects(kp, roof)) continue;
    const grown = k.setback > 0 ? (turf.buffer(kp, k.setback, { units: 'meters' }) as Feature<Polygon | MultiPolygon>) : kp;
    for (const p of toPolys(grown)) obstacles.push(p.map((r) => r.slice(0, -1).map(fwd)));
  }

  const portrait = seg.orientation === 'portrait';
  const alongRow = portrait ? mod.width : mod.length;
  const slope = portrait ? mod.length : mod.width;
  const tilt = Math.max(0, Math.min(89, seg.tilt));
  const depth = slope * Math.cos(tilt * DEG);
  let rowGap: number;
  if (seg.rowSpacing === 'manual') rowGap = Math.max(0, seg.rowGap);
  else if (seg.mount === 'flush') rowGap = seg.moduleGap;
  else rowGap = autoRowGap(lat0, tilt, slope, seg.azimuth);
  const pitch = depth + rowGap;
  const step = alongRow + seg.moduleGap;
  if (!allowed.length) return empty(roofArea, rowGap, pitch);

  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (const poly of allowed) for (const [a, b] of poly[0]) {
    minA = Math.min(minA, a); maxA = Math.max(maxA, a); minB = Math.min(minB, b); maxB = Math.max(maxB, b);
  }

  const run = (offA: number, offB: number) => {
    const rects: Ring[] = [];
    for (let b = minB + offB; b + depth <= maxB + 1e-9; b += pitch) {
      for (let a = minA + offA; a + alongRow <= maxA + 1e-9; a += step) {
        const rect: Ring = [[a, b], [a + alongRow, b], [a + alongRow, b + depth], [a, b + depth]];
        if (!rectInside(rect, allowed)) continue;
        if (obstacles.some((o) => rectHits(rect, o))) continue;
        rects.push(rect);
      }
    }
    return rects;
  };

  // try a few grid offsets and keep the one that fits the most modules
  let best: Ring[] = [];
  const n = 4;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const r = run((step * i) / n, (pitch * j) / n);
    if (r.length > best.length) best = r;
  }

  const panels = best.map((r) => r.map(back));
  return { panels, count: panels.length, kwp: (panels.length * mod.watts) / 1000, roofAreaM2: roofArea, rowGap, pitch };
}

/** Azimuth (facing) perpendicular to the roof's longest edge, choosing the side closest to south. */
export function alignToLongestEdge(ring: LngLat[]): number {
  let best = 0, bearing = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const d = turf.distance(a, b, { units: 'meters' });
    if (d > best) { best = d; bearing = turf.bearing(a, b); }
  }
  const options = [bearing + 90, bearing - 90].map((x) => ((x % 360) + 360) % 360);
  const diff = (x: number) => Math.abs(((x - 180 + 540) % 360) - 180);
  return Math.round(diff(options[0]) <= diff(options[1]) ? options[0] : options[1]);
}
