import { describe, it, expect } from 'vitest';
import { layoutSegment, autoRowGap, solsticeSun, alignToLongestEdge, DEFAULT_MODULE, type Segment, type LngLat } from './layout';

// 20 m (east-west) x 10 m (north-south) rectangle in Qurum, Muscat
const lat0 = 23.61, lon0 = 58.478;
const dx = 20 / (111320 * Math.cos((lat0 * Math.PI) / 180));
const dy = 10 / 110540;
const rect: LngLat[] = [[lon0, lat0], [lon0 + dx, lat0], [lon0 + dx, lat0 + dy], [lon0, lat0 + dy]];

const base: Segment = {
  id: 's1', name: 'Roof 1', ring: rect, mount: 'flush', tilt: 0, azimuth: 180, orientation: 'portrait',
  setback: 0, rowSpacing: 'auto', rowGap: 0, moduleGap: 0.02,
};

describe('layout', () => {
  it('fills a 20x10 m flat area with 17 x 4 portrait modules', () => {
    const r = layoutSegment(base, [], DEFAULT_MODULE);
    expect(r.count).toBe(68);
    expect(r.kwp).toBeCloseTo(37.4, 1);
    expect(r.roofAreaM2).toBeGreaterThan(199);
    expect(r.roofAreaM2).toBeLessThan(201);
  });

  it('setback removes edge modules', () => {
    const r = layoutSegment({ ...base, setback: 1 }, [], DEFAULT_MODULE);
    // 18 x 8 m usable -> 15 x 3
    expect(r.count).toBe(45);
  });

  it('keepout in the middle removes modules', () => {
    const cx = lon0 + dx / 2, cy = lat0 + dy / 2, e = 1 / 111000;
    const ko = { id: 'k1', name: 'AC', ring: [[cx - e, cy - e], [cx + e, cy - e], [cx + e, cy + e], [cx - e, cy + e]] as LngLat[], setback: 0.5, height: 1.5 };
    const r = layoutSegment(base, [ko], DEFAULT_MODULE);
    expect(r.count).toBeLessThan(68);
    expect(r.count).toBeGreaterThan(55);
  });

  it('tilted racks get a winter-solstice row gap', () => {
    const gap = autoRowGap(23.6, 10, 2.278, 180);
    // Muscat: low winter sun at 9:00 -> gap roughly 0.6-1.0 m for 10 deg portrait
    expect(gap).toBeGreaterThan(0.5);
    expect(gap).toBeLessThan(1.2);
    const r = layoutSegment({ ...base, mount: 'tilted', tilt: 10 }, [], DEFAULT_MODULE);
    expect(r.count).toBeLessThan(68);
  });

  it('sun is due south at solar noon in winter', () => {
    const s = solsticeSun(23.6, 12);
    expect(s.azimuth).toBeCloseTo(180, 0);
    expect(s.altitude).toBeCloseTo(90 - 23.6 - 23.44, 0);
  });

  it('aligns facing to the longest edge', () => {
    expect(alignToLongestEdge(rect)).toBe(180);
  });
});
