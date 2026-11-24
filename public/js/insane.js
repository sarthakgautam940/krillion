// The INSANE ANSWER moment. Time slows down on the game screen while the answer floats up,
// then snaps back to full speed into the reveal: the badge slams in, charges up, bursts open,
// and the title stamps in. Every phone in the room plays it.
import { shake, reducedMotion } from './fx.js';

const $ = (id) => document.getElementById(id);
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const SLOW_MS = 950;

function rays() {
  const n = 18;
  const point = (a) => `${(Math.cos(a) * 150).toFixed(1)} ${(Math.sin(a) * 150).toFixed(1)}`;
  let out = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out += `<path d="M0 0 L${point(a)} L${point(a + Math.PI / n)} Z"/>`;
  }
  return out;
}

let current = null;

/**
 * Play the moment. Returns a handle whose close() fades it out.
 *   answer         what was typed            player  { name, initials, color }
 *   origin         [x, y] the answer box     scene   the game screen to slow down
 *   canContinueAt  ms from now when Continue may be pressed
 */
export function playInsane({ answer, player, points, fx, sound, onContinue, origin, scene, canContinueAt = 4000 }) {
  current?.close(true);
  const root = $('insane');
  const reduced = reducedMotion();
  const slow = reduced ? 0 : SLOW_MS;
  const R = (ms) => (reduced ? Math.round(ms * 0.15) : ms);
  const red = css('--tier-insane');
  const white = css('--white');
  const shards = [red, red, white, css('--insane-deep')];
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const fill = 'both';
  const slowed = [];
  let sceneAnim = null;
  let ghost = null;
  let embers = 0;
  let spin = null;

  const go = $('insaneGo');
  go.disabled = true;
  const unlock = Math.max(slow + R(2900), canContinueAt);

  // 0. Time slows down. Everything already moving drops to a crawl, then ramps back up.
  if (slow) {
    sound.slowmo(slow / 1000);
    fx.ramp(0.08, 180, 'out');
    later(slow - 200, () => fx.ramp(1, 200, 'in'));
    if (scene) {
      scene.getAnimations({ subtree: true }).forEach((a) => {
        a.updatePlaybackRate(0.12);
        slowed.push(a);
      });
      sceneAnim = scene.animate(
        [
          { filter: 'saturate(1) brightness(1)', transform: 'scale(1)' },
          { filter: 'saturate(.25) brightness(.62)', transform: 'scale(1.035)', offset: 0.8 },
          { filter: 'saturate(0) brightness(.35)', transform: 'scale(1.14)' },
        ],
        { duration: slow, easing: 'cubic-bezier(.25,.1,.25,1)', fill: 'forwards' },
      );
      later(slow - 160, () => slowed.forEach((a) => a.updatePlaybackRate(1)));
    }
    if (origin) {
      ghost = make('div', 'slowmo-answer', answer);
      Object.assign(ghost.style, { left: `${origin[0]}px`, top: `${origin[1]}px` });
      document.body.append(ghost);
      ghost.animate(
        [
          { transform: 'translateY(0) scale(.92)', opacity: 0 },
          { transform: 'translateY(-30px) scale(1.05)', opacity: 1, offset: 0.2 },
          { transform: 'translateY(-70px) scale(1.18)', opacity: 1, offset: 0.82 },
          { transform: 'translateY(-90px) scale(6)', opacity: 0 },
        ],
        { duration: slow + 140, easing: 'linear', fill: 'forwards' },
      );
    }
    navigator.vibrate?.(30);
  }

  later(slow, reveal);

  function reveal() {
    const raysSvg = $('insaneRays');
    if (!raysSvg.childElementCount) raysSvg.innerHTML = rays();
    $('insaneAnswer').textContent = answer;
    $('insaneBy').textContent = player.name;
    const av = $('insaneAvatar');
    av.textContent = player.initials;
    av.style.setProperty('--c', `var(--p${player.color + 1})`);
    $('insanePts').textContent = '+0';
    const title = $('insaneTitle');
    title.replaceChildren(
      ...'INSANE ANSWER'.split(' ').map((word) => {
        const w = make('span', 'word');
        w.setAttribute('aria-hidden', 'true');
        [...word].forEach((ch) => w.append(make('span', 'ch', ch)));
        return w;
      }),
    );
    root.hidden = false;

    const badge = $('insaneBadge');
    const box = badge.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const halves = root.querySelectorAll('.badge__half');
    const mark = root.querySelector('.badge__mark');
    const flash = $('insaneFlash');

    // 1. Impact.
    sound.insaneImpact();
    root.querySelector('.insane__bg').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, fill });
    flash.style.background = red;
    flash.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration: 380, easing: 'ease-out' });
    shake(root, 16, 520);
    root.querySelector('.insane__rays').animate([{ transform: 'scale(0)' }, { transform: 'scale(1)' }], { duration: 800, easing: 'cubic-bezier(.2,.9,.3,1.15)', fill });
    spin = raysSvg.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 26000, iterations: Infinity });
    navigator.vibrate?.([60, 40, 120]);

    // 2. The badge slams down.
    badge.animate(
      [
        { transform: 'translateY(-80px) scale(2.8)', opacity: 0 },
        { transform: 'translateY(0) scale(.9)', opacity: 1, offset: 0.72 },
        { transform: 'translateY(0) scale(1)', opacity: 1 },
      ],
      { duration: 440, delay: 120, easing: 'cubic-bezier(.4,0,.2,1)', fill },
    );
    later(R(430), () => {
      fx.ring(cx, cy, { color: red, radius: 260, width: 10 });
      fx.burst(cx, cy, { colors: shards, count: 40, speed: 9 });
      shake(root, 10, 300);
    });
    embers = setInterval(() => fx.ember(shards), 70);

    // 3. It charges up.
    later(R(620), () => {
      sound.insaneRiser(1.15);
      spin.updatePlaybackRate(6);
      if (reduced) return;
      const frames = [];
      for (let i = 0; i <= 14; i++) {
        const k = i / 14;
        const amp = 2 + k * 9;
        frames.push({ transform: `rotate(${(i % 2 ? amp : -amp).toFixed(1)}deg) scale(${(1 + k * 0.16).toFixed(3)})` });
      }
      badge.animate(frames, { duration: 1120, easing: 'linear' });
    });

    // 4. Burst open.
    later(R(1750), () => {
      sound.insaneBurst();
      spin.updatePlaybackRate(1);
      const out = (dx, dy, deg) => [{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) rotate(${deg}deg)`, opacity: 0 }];
      halves[0].animate(out(-70, -26, -40), { duration: 640, easing: 'cubic-bezier(.2,.7,.2,1)', fill });
      halves[1].animate(out(70, 26, 40), { duration: 640, easing: 'cubic-bezier(.2,.7,.2,1)', fill });
      mark.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(3.2)', opacity: 0 }], { duration: 420, easing: 'ease-out', fill });
      flash.style.background = white;
      flash.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration: 460, easing: 'ease-out' });
      fx.burst(cx, cy, { colors: shards, count: 150, speed: 17, size: [6, 16], life: [55, 110] });
      [0, 130, 260].forEach((d, i) => later(d, () => fx.ring(cx, cy, { color: i === 1 ? white : red, radius: 320 + i * 260, width: 14 - i * 3, life: 40 + i * 8 })));
      shake(root, 22, 620);
      navigator.vibrate?.(200);
    });

    // 5. The title stamps in, then the answer, the player and the points.
    title.querySelectorAll('.ch').forEach((ch, i) => {
      ch.animate(
        [
          { opacity: 0, transform: 'translateY(-46px) scale(2.3)' },
          { opacity: 1, transform: 'translateY(0) scale(.88)', offset: 0.7 },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 360, delay: R(1820) + i * 38, easing: 'cubic-bezier(.2,.9,.3,1.25)', fill },
      );
    });
    $('insaneAnswer').animate(
      [
        { opacity: 0, transform: 'scale(.5) rotate(-5deg)' },
        { opacity: 1, transform: 'scale(1.08) rotate(1.5deg)', offset: 0.7 },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 420, delay: R(2420), easing: 'cubic-bezier(.2,.9,.3,1.2)', fill },
    );
    root.querySelector('.insane__meta').animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: R(2750), fill });
    later(R(2800), () => {
      const t0 = performance.now();
      const count = (now) => {
        const k = Math.min(1, (now - t0) / 650);
        $('insanePts').textContent = `+${Math.round(points * (1 - (1 - k) ** 3))}`;
        if (k < 1 && !root.hidden) requestAnimationFrame(count);
      };
      requestAnimationFrame(count);
      sound.correct(6);
    });
    go.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: Math.max(0, unlock - slow), fill });
  }

  later(unlock, () => {
    go.disabled = false;
  });
  go.onclick = () => {
    onContinue?.();
    handle.close();
  };

  const handle = {
    get ready() {
      return !go.disabled;
    },
    close(instant = false) {
      if (current !== handle) return;
      current = null;
      go.disabled = true;
      timers.forEach(clearTimeout);
      clearInterval(embers);
      fx.ramp(1, 1);
      slowed.forEach((a) => a.updatePlaybackRate(1));
      sceneAnim?.cancel();
      ghost?.remove();
      const reset = () => {
        root.hidden = true;
        root.querySelectorAll('*').forEach((n) => n.getAnimations().forEach((a) => a.cancel()));
        $('insaneRays').getAnimations().forEach((a) => a.cancel());
      };
      if (instant || root.hidden) reset();
      else root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: 'ease-in' }).finished.then(reset, reset);
    },
  };
  current = handle;
  return handle;
}
