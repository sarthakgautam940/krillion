// Canvas effects: shard bursts, shockwave rings and drifting embers. Flat colors only.

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class FX {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.shards = [];
    this.rings = [];
    this.frame = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(window.innerWidth * this.dpr);
    this.canvas.height = Math.round(window.innerHeight * this.dpr);
  }

  /** Throw a burst of shards from (x, y) in CSS pixels. */
  burst(x, y, { colors, count = 24, speed = 7, gravity = 0.22, size = [5, 11], life = [40, 75], up = 0 } = {}) {
    const n = reducedMotion() ? Math.ceil(count / 4) : count;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.75);
      const max = life[0] + Math.random() * (life[1] - life[0]);
      this.shards.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - up, g: gravity,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
        w: size[0] + Math.random() * (size[1] - size[0]), h: 0.45 + Math.random() * 0.5,
        tri: Math.random() < 0.45, color: colors[i % colors.length], life: max, max,
      });
    }
    this.run();
  }

  /** A crisp expanding ring. */
  ring(x, y, { color, radius = 220, width = 8, life = 34 } = {}) {
    if (reducedMotion()) return;
    this.rings.push({ x, y, color, radius, width, life, max: life });
    this.run();
  }

  /** Slow shards rising from the bottom edge, used behind the big reveal. */
  ember(colors) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.shards.push({
      x: Math.random() * w, y: h + 10, vx: (Math.random() - 0.5) * 0.6, vy: -(1.2 + Math.random() * 2.2), g: -0.004,
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.08, w: 4 + Math.random() * 7, h: 0.5,
      tri: Math.random() < 0.5, color: colors[Math.floor(Math.random() * colors.length)], life: 220, max: 220,
    });
    this.run();
  }

  clear() {
    this.shards.length = 0;
    this.rings.length = 0;
  }

  run() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.step());
  }

  step() {
    const { g, dpr } = this;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.rings = this.rings.filter((r) => {
      r.life -= 1;
      const t = 1 - r.life / r.max;
      const ease = 1 - (1 - t) ** 3;
      g.globalAlpha = Math.max(0, 1 - t);
      g.strokeStyle = r.color;
      g.lineWidth = Math.max(0.5, r.width * (1 - t));
      g.beginPath();
      g.arc(r.x, r.y, 8 + r.radius * ease, 0, Math.PI * 2);
      g.stroke();
      return r.life > 0;
    });

    this.shards = this.shards.filter((s) => {
      s.life -= 1;
      s.vy += s.g;
      s.vx *= 0.985;
      s.x += s.vx;
      s.y += s.vy;
      s.rot += s.vr;
      g.globalAlpha = Math.min(1, (s.life / s.max) * 1.6);
      g.fillStyle = s.color;
      g.save();
      g.translate(s.x, s.y);
      g.rotate(s.rot);
      if (s.tri) {
        g.beginPath();
        g.moveTo(-s.w / 2, s.w / 2);
        g.lineTo(s.w / 2, s.w / 2);
        g.lineTo(0, -s.w / 2);
        g.closePath();
        g.fill();
      } else {
        g.fillRect(-s.w / 2, (-s.w * s.h) / 2, s.w, s.w * s.h);
      }
      g.restore();
      return s.life > 0 && s.y < window.innerHeight + 60 && s.y > -80;
    });

    g.globalAlpha = 1;
    this.frame = 0;
    if (this.shards.length || this.rings.length) this.run();
  }
}

/** Shake an element. Strength is in pixels. */
export function shake(el, strength = 8, duration = 380) {
  if (reducedMotion() || !el.animate) return;
  const frames = [];
  for (let i = 0; i < 8; i++) {
    const k = 1 - i / 8;
    const x = (Math.random() * 2 - 1) * strength * k;
    const y = (Math.random() * 2 - 1) * strength * k * 0.6;
    frames.push({ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` });
  }
  frames.push({ transform: 'translate(0, 0)' });
  el.animate(frames, { duration, easing: 'linear' });
}
