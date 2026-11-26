// Animowane tło: śnieg, gwiazdy, deszcz, świetliki – lekki canvas (ok. 30 kl./s, pauza w tle)

let canvas, ctx, parts = [], kind = 'off', amount = 2, raf = 0, last = 0, W = 0, H = 0;

const rnd = (a, b) => a + Math.random() * (b - a);

function resize() {
  W = canvas.width = innerWidth;
  H = canvas.height = innerHeight;
}

function spawn(initial) {
  const n = Math.round({ snow: 90, stars: 140, rain: 120, fireflies: 34 }[kind] * [0, 0.45, 1, 1.8][amount]);
  parts = [];
  for (let i = 0; i < n; i++) parts.push(make(initial));
}

function make(initial) {
  switch (kind) {
    case 'snow': return { x: rnd(0, W), y: initial ? rnd(0, H) : rnd(-40, -5), r: rnd(1, 3.6), vy: rnd(18, 55), vx: rnd(-12, 12), ph: rnd(0, 6.28), a: rnd(.45, .95) };
    case 'stars': return { x: rnd(0, W), y: rnd(0, H), r: rnd(.4, 1.7), ph: rnd(0, 6.28), sp: rnd(.6, 2.2), a: rnd(.3, .9) };
    case 'rain': return { x: rnd(-50, W), y: initial ? rnd(0, H) : rnd(-200, -10), len: rnd(10, 24), vy: rnd(520, 820), a: rnd(.12, .35) };
    case 'fireflies': return { x: rnd(0, W), y: rnd(H * .3, H), r: rnd(1.4, 3), vx: rnd(-14, 14), vy: rnd(-12, 6), ph: rnd(0, 6.28), sp: rnd(.6, 1.6) };
  }
  return {};
}

let shooting = null;

function frame(t) {
  raf = requestAnimationFrame(frame);
  if (t - last < 33) return; // ~30 kl./s
  const dt = Math.min(0.1, (t - last) / 1000 || 0.033);
  last = t;
  ctx.clearRect(0, 0, W, H);
  if (kind === 'snow') {
    ctx.fillStyle = '#fff';
    for (const p of parts) {
      p.ph += dt; p.y += p.vy * dt; p.x += (p.vx + Math.sin(p.ph) * 14) * dt;
      if (p.y > H + 5) Object.assign(p, make(false));
      ctx.globalAlpha = p.a;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
    }
  } else if (kind === 'stars') {
    ctx.fillStyle = '#fff';
    for (const p of parts) {
      p.ph += dt * p.sp;
      ctx.globalAlpha = p.a * (0.55 + 0.45 * Math.sin(p.ph));
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
    }
    // spadająca gwiazda co jakiś czas
    if (!shooting && Math.random() < dt * 0.12) shooting = { x: rnd(W * .1, W * .9), y: rnd(0, H * .4), vx: rnd(-700, -420), vy: rnd(180, 300), life: 0 };
    if (shooting) {
      const s = shooting; s.life += dt; s.x += s.vx * dt; s.y += s.vy * dt;
      const g = ctx.createLinearGradient(s.x, s.y, s.x - s.vx * .12, s.y - s.vy * .12);
      g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = Math.max(0, 1 - s.life * 1.2);
      ctx.strokeStyle = g; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx * .12, s.y - s.vy * .12); ctx.stroke();
      if (s.life > 1) shooting = null;
    }
  } else if (kind === 'rain') {
    ctx.strokeStyle = '#cfe3ff'; ctx.lineWidth = 1;
    for (const p of parts) {
      p.y += p.vy * dt; p.x += p.vy * .12 * dt;
      if (p.y > H) Object.assign(p, make(false));
      ctx.globalAlpha = p.a;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.len * .12, p.y - p.len); ctx.stroke();
    }
  } else if (kind === 'fireflies') {
    for (const p of parts) {
      p.ph += dt * p.sp; p.x += (p.vx + Math.sin(p.ph * 1.3) * 10) * dt; p.y += (p.vy + Math.cos(p.ph) * 8) * dt;
      if (p.x < -20) p.x = W + 20; if (p.x > W + 20) p.x = -20;
      if (p.y < H * .15 || p.y > H + 20) { p.vy = -p.vy; p.y = Math.min(Math.max(p.y, H * .15), H + 20); }
      const a = 0.35 + 0.65 * Math.max(0, Math.sin(p.ph * 1.7));
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 6);
      g.addColorStop(0, `rgba(255,240,150,${a})`); g.addColorStop(.25, `rgba(220,255,120,${a * .5})`); g.addColorStop(1, 'rgba(200,255,100,0)');
      ctx.globalAlpha = 1; ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 6, 0, 6.283); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

export function setFx(type, level = 2) {
  canvas ||= document.getElementById('fx');
  ctx ||= canvas.getContext('2d');
  cancelAnimationFrame(raf);
  kind = type || 'off';
  amount = Math.max(1, Math.min(3, level || 2));
  if (kind === 'off') { canvas.hidden = true; ctx.clearRect(0, 0, W, H); return; }
  canvas.hidden = false;
  resize();
  spawn(true);
  last = 0;
  raf = requestAnimationFrame(frame);
}

addEventListener('resize', () => { if (kind !== 'off' && canvas) { resize(); spawn(true); } });
document.addEventListener('visibilitychange', () => {
  if (!canvas || kind === 'off') return;
  if (document.hidden) cancelAnimationFrame(raf);
  else { last = 0; raf = requestAnimationFrame(frame); }
});
