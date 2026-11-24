// Draws a made-up game HUD onto a 2D canvas: health and stamina bars, a minimap, a crosshair, an ammo counter,
// objective text, a hotbar and a compass, each present or not at random. The same random function gives the same
// overlay, so it is drawn identically on the clean and glitched frames and never ends up in the glitch mask.

const pick = (r, list) => list[Math.floor(r() * list.length)];
const range = (r, lo, hi) => lo + (hi - lo) * r();
const SYLLABLES = ['ka', 'ren', 'tor', 'vel', 'mi', 'sha', 'dor', 'lin', 'ex', 'qua', 'zu', 'pol', 'an', 'the', 'ro'];
const word = (r) => Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(r, SYLLABLES)).join('');
const phrase = (r) => Array.from({ length: 2 + Math.floor(r() * 4) }, () => word(r)).join(' ');

export function drawHud(g, w, h, r) {
  const s = h / 432; // scale everything to the frame height
  const accent = pick(r, ['#ffd166', '#4cc9f0', '#f72585', '#80ed99', '#ffffff', '#ff9f1c']);
  const font = pick(r, ['system-ui', 'Georgia', 'monospace', 'Impact', 'Arial Black']);
  g.save();
  g.globalAlpha = range(r, 0.7, 0.95);
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 3 * s;

  if (r() < 0.75) {
    // health and stamina bars, bottom left
    const x = 18 * s, y = h - 34 * s, bw = range(r, 110, 200) * s, bh = 9 * s;
    for (const [i, color] of [[0, pick(r, ['#e63946', '#52b788', '#ef476f'])], [1, pick(r, ['#4cc9f0', '#ffd166', '#90be6d'])]]) {
      if (i === 1 && r() < 0.4) break;
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(x, y + i * 14 * s, bw, bh);
      g.fillStyle = color;
      g.fillRect(x + 1.5 * s, y + i * 14 * s + 1.5 * s, (bw - 3 * s) * range(r, 0.15, 1), bh - 3 * s);
    }
  }
  if (r() < 0.5) {
    // minimap, top right
    const R = range(r, 34, 52) * s, cx = w - R - 16 * s, cy = R + 16 * s;
    g.fillStyle = `rgba(${Math.floor(range(r, 20, 70))},${Math.floor(range(r, 30, 80))},${Math.floor(range(r, 20, 60))},0.75)`;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 1.2 * s;
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.moveTo(cx + range(r, -R, R) * 0.7, cy + range(r, -R, R) * 0.7);
      g.lineTo(cx + range(r, -R, R) * 0.7, cy + range(r, -R, R) * 0.7);
      g.stroke();
    }
    g.lineWidth = 2 * s;
    g.strokeStyle = accent;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = accent;
    g.beginPath();
    g.moveTo(cx, cy - 6 * s);
    g.lineTo(cx + 4 * s, cy + 4 * s);
    g.lineTo(cx - 4 * s, cy + 4 * s);
    g.fill();
  }
  if (r() < 0.45) {
    // crosshair
    const cx = w / 2, cy = h / 2, a = range(r, 4, 9) * s, gap = range(r, 2, 5) * s;
    g.strokeStyle = accent;
    g.lineWidth = 1.5 * s;
    g.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      g.moveTo(cx + dx * gap, cy + dy * gap);
      g.lineTo(cx + dx * (gap + a), cy + dy * (gap + a));
    }
    g.stroke();
  }
  g.fillStyle = '#ffffff';
  if (r() < 0.5) {
    // ammo counter, bottom right
    g.font = `bold ${Math.round(range(r, 16, 26) * s)}px ${font}`;
    g.textAlign = 'right';
    g.fillText(`${Math.floor(r() * 40)} / ${Math.floor(r() * 300)}`, w - 18 * s, h - 20 * s);
  }
  if (r() < 0.5) {
    // objective text, top left
    g.textAlign = 'left';
    g.font = `${Math.round(range(r, 10, 14) * s)}px ${font}`;
    g.fillStyle = accent;
    g.fillText(phrase(r).toUpperCase(), 18 * s, 26 * s);
    g.fillStyle = '#ffffff';
    for (let i = 0, n = Math.floor(r() * 3); i < n; i++) g.fillText(`• ${phrase(r)}`, 18 * s, (44 + i * 16) * s);
  }
  if (r() < 0.4) {
    // hotbar, bottom centre
    const n = 4 + Math.floor(r() * 5), size = range(r, 22, 32) * s, gap = 4 * s;
    const x0 = w / 2 - (n * (size + gap)) / 2;
    for (let i = 0; i < n; i++) {
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(x0 + i * (size + gap), h - size - 12 * s, size, size);
      g.fillStyle = `hsl(${Math.floor(r() * 360)},${Math.floor(range(r, 30, 70))}%,${Math.floor(range(r, 40, 65))}%)`;
      g.fillRect(x0 + i * (size + gap) + size * 0.25, h - size - 12 * s + size * 0.25, size * 0.5, size * 0.5);
    }
  }
  if (r() < 0.3) {
    // compass strip, top centre
    const cw = range(r, 180, 300) * s, x0 = w / 2 - cw / 2, y = 14 * s;
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.fillRect(x0, y, cw, 16 * s);
    g.fillStyle = '#ffffff';
    g.font = `${Math.round(10 * s)}px ${font}`;
    g.textAlign = 'center';
    const offset = r();
    ['N', 'E', 'S', 'W'].forEach((c, i) => g.fillText(c, x0 + ((i / 4 + offset) % 1) * cw, y + 12 * s));
  }
  g.restore();
}

// Draws an engine or editor debug overlay: a title line, a frame-time box and a settings panel with sliders,
// each present or not at random. Like the HUD, it is identical on the clean and glitched frames.
export function drawDebugOverlay(g, w, h, r) {
  const s = h / 432;
  const font = pick(r, ['monospace', 'system-ui', 'Helvetica', 'Arial']);
  const accent = pick(r, ['#2cc9ff', '#4cc9f0', '#80ed99', '#ffd166', '#ff9f1c', '#c77dff']);
  g.save();
  if (r() < 0.8) {
    // a title or instructions, top centre
    g.font = `${Math.round(range(r, 10, 14) * s)}px ${font}`;
    g.textAlign = 'center';
    g.fillStyle = pick(r, ['#ffffff', '#cccccc', '#222222', '#88ccff']);
    for (let i = 0, n = 1 + Math.floor(r() * 2); i < n; i++) g.fillText(phrase(r), w / 2, (16 + i * 15) * s);
  }
  if (r() < 0.45) {
    // frame-time box with a little bar graph, top left
    const bw = 80 * s, bh = 48 * s;
    const [bgc, fg] = pick(r, [['#002', '#0ff'], ['#020', '#0f0'], ['#201', '#f08'], ['#111', '#fff']]);
    g.globalAlpha = 0.9;
    g.fillStyle = bgc;
    g.fillRect(0, 0, bw, bh);
    g.fillStyle = fg;
    g.font = `bold ${Math.round(9 * s)}px Helvetica`;
    g.textAlign = 'left';
    g.fillText(`${Math.round(range(r, 24, 144))} ${pick(r, ['FPS', 'MS', 'MB'])}`, 3 * s, 10 * s);
    g.globalAlpha = 0.6;
    for (let x = 3 * s; x < bw - 3 * s; x += s) g.fillRect(x, bh - 3 * s - range(r, 4, 30) * s, s, range(r, 4, 30) * s);
    g.globalAlpha = 1;
  }
  if (r() < 0.5) {
    // a settings panel with labels, sliders, checkboxes and colour swatches, top right
    const pw = range(r, 170, 250) * s, rh = 22 * s, rows = 2 + Math.floor(r() * 8);
    const x = w - pw - range(r, 0, 16) * s;
    g.globalAlpha = range(r, 0.85, 1);
    g.fillStyle = pick(r, ['#1f1f1f', '#2a2a2e', '#f2f2f2']);
    const light = g.fillStyle === '#f2f2f2';
    g.fillRect(x, 0, pw, rows * rh + 6 * s);
    g.font = `${Math.round(10.5 * s)}px ${font}`;
    g.textAlign = 'left';
    for (let i = 0; i < rows; i++) {
      const y = 3 * s + i * rh;
      g.fillStyle = light ? '#333' : '#ebebeb';
      g.fillText(word(r), x + 6 * s, y + rh * 0.65);
      const vx = x + pw * 0.42, vw = pw * 0.55 - 6 * s;
      const kind = pick(r, ['slider', 'slider', 'check', 'color', 'value']);
      if (kind === 'slider') {
        g.fillStyle = light ? '#ccc' : '#424242';
        g.fillRect(vx, y + 4 * s, vw * 0.7, rh - 8 * s);
        g.fillStyle = accent;
        g.fillRect(vx, y + 4 * s, vw * 0.7 * r(), rh - 8 * s);
        g.fillStyle = light ? '#333' : '#ebebeb';
        g.fillText(range(r, 0, 10).toFixed(2), vx + vw * 0.74, y + rh * 0.65);
      } else if (kind === 'check') {
        g.strokeStyle = light ? '#666' : '#aaa';
        g.strokeRect(vx, y + 5 * s, rh - 10 * s, rh - 10 * s);
        if (r() < 0.6) {
          g.fillStyle = accent;
          g.fillRect(vx + 2 * s, y + 7 * s, rh - 14 * s, rh - 14 * s);
        }
      } else if (kind === 'color') {
        g.fillStyle = `hsl(${Math.floor(r() * 360)},${Math.floor(range(r, 30, 90))}%,${Math.floor(range(r, 30, 70))}%)`;
        g.fillRect(vx, y + 4 * s, vw, rh - 8 * s);
      } else {
        g.fillStyle = light ? '#ddd' : '#333';
        g.fillRect(vx, y + 4 * s, vw, rh - 8 * s);
        g.fillStyle = light ? '#333' : '#ebebeb';
        g.fillText(word(r), vx + 4 * s, y + rh * 0.65);
      }
    }
  }
  g.restore();
}
