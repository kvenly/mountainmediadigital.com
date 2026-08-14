// terrain.js — the course generator, ported from the game's Swift source.
//
// G builds every hole from an analytic height function plus seeded
// features; there is no baked geometry anywhere. That means the same
// equations that decide where your ball rolls on the phone can run here
// and draw the identical course. This file is a direct port of
// Shared/Terrain.swift — keep it in step if the Swift changes.

// --- SplitMix64, so seeded features land exactly where the game puts them.
export class SplitMix64 {
  constructor(seed) { this.state = BigInt.asUintN(64, BigInt(seed)); }
  next() {
    this.state = BigInt.asUintN(64, this.state + 0x9E3779B97F4A7C15n);
    let z = this.state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94D049BB133111EBn);
    return z ^ (z >> 31n);
  }
  unit() { return Number(this.next() >> 11n) / 9007199254740992; }
  range(lo, hi) { return lo + this.unit() * (hi - lo); }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const len2 = (x, y) => Math.hypot(x, y);

function smoothstep(e0, e1, v) {
  const t = clamp((v - e0) / Math.max(e1 - e0, 0.0001), 0, 1);
  return t * t * (3 - 2 * t);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const dd = abx * abx + aby * aby;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / Math.max(dd, 0.0001), 0, 1);
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

export class HoleTerrain {
  constructor(hole, seed) {
    this.hole = hole;
    const rng = new SplitMix64(BigInt(seed) + BigInt(hole.number) * 613n);
    this.phase1 = rng.range(0, 6.28);
    this.phase2 = rng.range(0, 6.28);
    this.phase3 = rng.range(0, 6.28);

    this.amplitude = hole.hillAmplitude;
    this.gc = [hole.greenCenter.x, hole.greenCenter.y];
    this.greenRadius = hole.greenRadius;
    this.greenElevation = hole.greenElevation;
    this.greenWave = hole.greenWave;
    this.canyonWalls = hole.canyonWalls;
    this.oceanSide = hole.oceanSide;
    this.oceanDistance = hole.oceanDistance;
    this.rollingFairway = hole.rollingFairway;
    this.pads = hole.islands.map(i => [i.c.x, i.c.y, i.r, i.oval]);
    this.islandMode = this.pads.length > 0;
    this.maxZ = hole.lengthYards + 44;

    // River — the rng draws happen either way so other seeded features
    // don't reshuffle on a dry hole.
    this.river = [];
    const baseX = hole.riverSide * 36;
    for (let z = -24; z < hole.lengthYards + 44; z += 42) {
      const wobble = rng.range(-14, 14);
      if (hole.riverSide !== 0) this.river.push([baseX + wobble, z]);
    }

    // Corridor: Catmull-Rom through the authored polyline for organic
    // holes; the raw line for classic ones.
    let pts = hole.corridor.map(p => [p.x, p.y]);
    let ws = hole.fairwayWidths.length ? hole.fairwayWidths.slice() : pts.map(() => 13);
    while (ws.length < pts.length) ws.push(ws[ws.length - 1] ?? 13);

    if (hole.organic && pts.length >= 3) {
      const sp = [], sw = [], n = pts.length;
      for (let i = 0; i < n - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)], p1 = pts[i];
        const p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
        const w0 = ws[Math.max(0, i - 1)], w1 = ws[i];
        const w2 = ws[i + 1], w3 = ws[Math.min(n - 1, i + 2)];
        for (let s = 0; s < 6; s++) {
          const t = s / 6, t2 = t * t, t3 = t2 * t;
          const ka = -0.5 * t3 + t2 - 0.5 * t;
          const kb = 1.5 * t3 - 2.5 * t2 + 1;
          const kc = -1.5 * t3 + 2 * t2 + 0.5 * t;
          const kd = 0.5 * t3 - 0.5 * t2;
          sp.push([p0[0]*ka + p1[0]*kb + p2[0]*kc + p3[0]*kd,
                   p0[1]*ka + p1[1]*kb + p2[1]*kc + p3[1]*kd]);
          sw.push(w0*ka + w1*kb + w2*kc + w3*kd);
        }
      }
      sp.push(pts[n - 1]); sw.push(ws[n - 1]);
      pts = sp; ws = sw;
    }
    this.segs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      this.segs.push([pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1], ws[i], ws[i+1]]);
    }

    this.ponds = hole.ponds.map(p => [p.c.x, p.c.y, p.r]);
    this.creeks = [];
    for (const c of hole.creeks) {
      for (let i = 0; i < c.length - 1; i++) {
        this.creeks.push([c[i].x, c[i].y, c[i+1].x, c[i+1].y]);
      }
    }

    // Bunkers: authored, else a seeded pair guarding the green. The
    // range hole gets none.
    this.bunkers = [];
    if (hole.bunkers.length === 0 && !hole.rangeMarkings) {
      const count = 1 + Math.floor(rng.range(0, 1.99));
      for (let i = 0; i < count; i++) {
        const angle = rng.range(0, 6.28);
        const dist = this.greenRadius * rng.range(1.6, 2.2);
        this.bunkers.push([this.gc[0] + Math.sin(angle) * dist,
                           this.gc[1] + Math.cos(angle) * dist,
                           rng.range(4.5, 7)]);
      }
    } else {
      this.bunkers = hole.bunkers.map(b => [b.c.x, b.c.y, b.r]);
    }

    this.mesas = (hole.mesas || []).map(m => [m.c.x, m.c.y, m.r, m.h]);
  }

  islandEdge(x, z) {
    if (!this.islandMode) return -Infinity;
    let best = len2(x - this.gc[0], z - this.gc[1]) - this.greenRadius * 2.0;
    best = Math.min(best, len2(x, z) - 13);
    for (const [cx, cy, r, oval] of this.pads) {
      const dx = x - cx, dy = z - cy;
      const hx = r, hz = r * oval;
      const corner = 0.45 * Math.min(hx, hz);
      const qx = Math.abs(dx) - (hx - corner);
      const qy = Math.abs(dy) - (hz - corner);
      const outside = len2(Math.max(qx, 0), Math.max(qy, 0));
      const inside = Math.min(Math.max(qx, qy), 0);
      best = Math.min(best, outside + inside - corner);
    }
    return best;
  }

  fairwayEdge(x, z) {
    let best = Infinity;
    for (const [ax, ay, bx, by, w0, w1] of this.segs) {
      const abx = bx - ax, aby = by - ay;
      const dd = abx * abx + aby * aby;
      const t = clamp(((x - ax) * abx + (z - ay) * aby) / Math.max(dd, 0.0001), 0, 1);
      const d = Math.hypot(x - (ax + abx * t), z - (ay + aby * t));
      best = Math.min(best, d - (w0 + (w1 - w0) * t));
    }
    return best;
  }

  coastSeaward(x, z) {
    if (this.oceanSide === 0) return -Infinity;
    const wander = 9 * Math.sin(z * 0.013 + this.phase2) + 5 * Math.sin(z * 0.031 + this.phase3);
    const edge = this.oceanDistance + wander;
    return (this.oceanSide > 0 ? x : -x) - edge;
  }

  riverDistance(x, z) {
    if (this.river.length < 2) return Infinity;
    let best = Infinity;
    for (let i = 0; i < this.river.length - 1; i++) {
      best = Math.min(best, distToSegment(x, z, this.river[i][0], this.river[i][1],
                                          this.river[i+1][0], this.river[i+1][1]));
    }
    return best;
  }

  creekDistance(x, z) {
    if (!this.creeks.length) return Infinity;
    let best = Infinity;
    for (const [ax, ay, bx, by] of this.creeks) {
      best = Math.min(best, distToSegment(x, z, ax, ay, bx, by));
    }
    return best;
  }

  pondEdge(x, z) {
    if (!this.ponds.length) return Infinity;
    let best = Infinity;
    for (const [cx, cy, r] of this.ponds) best = Math.min(best, len2(x - cx, z - cy) - r);
    return best;
  }

  heightAt(x, z) {
    let h = this.amplitude * (1.9 * Math.sin(x * 0.045 + this.phase1)
                            + 1.5 * Math.sin(z * 0.031 + this.phase2)
                            + 0.9 * Math.sin((x + z) * 0.021 + this.phase3));

    const fe = this.fairwayEdge(x, z);
    const damp = 0.3 + 0.7 * smoothstep(-2, 13, fe);
    h *= damp + (1 - damp) * this.rollingFairway;

    const micro = 0.3 + 0.7 * smoothstep(-4, 9, fe);
    h += 0.2 * Math.sin(x * 0.9 + this.phase3) * Math.sin(z * 0.85 + this.phase1)
       * (micro + (1 - micro) * this.rollingFairway);

    if (this.canyonWalls > 0) {
      h += this.canyonWalls * smoothstep(6, 31, fe)
         * (0.82 + 0.18 * Math.sin(x * 0.12 + this.phase1) * Math.sin(z * 0.09 + this.phase3));
    }

    if (this.islandMode) {
      const ie = this.islandEdge(x, z);
      h *= 0.35;
      h += 0.9 * (1 - smoothstep(-7, 1, ie));
      h -= 6.0 * smoothstep(2.2, 6.5, ie);
    }

    if (this.oceanSide !== 0) {
      h -= 26 * smoothstep(-2, 13, this.coastSeaward(x, z));
    }

    // The green: one table, at most one authored grade.
    const gd = len2(x - this.gc[0], z - this.gc[1]);
    const gBlend = 1 - smoothstep(this.greenRadius * 1.2, this.greenRadius * 2.4, gd);
    h = h * (1 - gBlend) + this.greenElevation * gBlend;
    if (this.greenWave > 0) {
      const ux = (x - this.gc[0]) / Math.max(this.greenRadius, 1);
      const uy = (z - this.gc[1]) / Math.max(this.greenRadius, 1);
      const tilt = clamp(ux * Math.cos(this.phase2) + uy * Math.sin(this.phase2), -1.4, 1.4);
      const crownSign = this.phase3 > 3.14 ? 1 : -1;
      const crown = crownSign * Math.max(0, 1 - (ux * ux + uy * uy));
      h += this.greenWave * gBlend * (0.7 * tilt + 0.3 * crown);
    }

    // Tee pad sits at zero.
    const tBlend = 1 - smoothstep(9, 30, len2(x, z));
    h *= (1 - tBlend);

    // Water carves, but never through the putting surface.
    const carveKeep = 1 - gBlend;
    const rd = this.riverDistance(x, z);
    h -= 3.4 * (1 - smoothstep(0, 10, Math.min(rd, 1e5))) * carveKeep;
    const ck = this.creekDistance(x, z);
    h -= 2.6 * (1 - smoothstep(0, 7, Math.min(ck, 1e5))) * carveKeep;
    const pe = this.pondEdge(x, z);
    h -= 3.2 * (1 - smoothstep(0, 9, Math.max(0, Math.min(pe, 1e5)))) * carveKeep;
    if (rd > 12 && ck > 9 && pe > 6
        && !(this.islandMode && this.islandEdge(x, z) > 2)
        && !(this.oceanSide !== 0 && this.coastSeaward(x, z) > 0)) {
      h = Math.max(h, -1.6);
    }

    for (const [bx, by, br] of this.bunkers) {
      const d = len2(x - bx, z - by);
      h -= 0.7 * (1 - smoothstep(br * 0.4, br, d));
    }

    return h;
  }

  isWater(x, z) {
    if (this.islandMode && this.islandEdge(x, z) > 3.6) return true;
    if (this.oceanSide !== 0 && this.coastSeaward(x, z) > 7) return true;
    return this.riverDistance(x, z) < 5.4 || this.creekDistance(x, z) < 3.2
        || this.pondEdge(x, z) < 0;
  }

  inBunker(x, z) {
    return this.bunkers.some(([bx, by, br]) => len2(x - bx, z - by) < br);
  }

  // green / fringe / fairway / rough / sand / water
  surface(x, z) {
    if (this.isWater(x, z)) return 'water';
    if (this.inBunker(x, z)) return 'sand';
    const gd = len2(x - this.gc[0], z - this.gc[1]);
    if (gd < this.greenRadius * 1.35) return 'green';
    if (gd < this.greenRadius * 1.8) return 'fringe';
    if (this.islandMode) {
      const ie = this.islandEdge(x, z);
      if (ie > 1.6) return 'sand';
      if (ie > -0.5) return 'rough';
      return 'fairway';
    }
    if (this.fairwayEdge(x, z) < 0) return 'fairway';
    return 'rough';
  }

  get waterLevel() { return -2.1; }
}
