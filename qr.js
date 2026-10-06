/* Minimal QR code encoder (byte mode, error-correction level M, versions 1-10). No dependencies. */
(function () {
  const T = [null, [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]];
  const AL = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  function rsGen(n) { let g = [1]; for (let i = 0; i < n; i++) { const h = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { h[j] ^= g[j]; h[j + 1] ^= mul(g[j], EXP[i]); } g = h; } return g; }
  function rsRem(data, gen) { const n = gen.length - 1, r = new Array(n).fill(0); for (const d of data) { const f = d ^ r.shift(); r.push(0); if (f) for (let j = 0; j < n; j++) r[j] ^= mul(gen[j + 1], f); } return r; }
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (((y / 2) | 0) + ((x / 3) | 0)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0];
  function penalty(m, n) {
    let s = 0, dark = 0;
    for (let a = 0; a < n; a++) for (const row of [true, false]) {
      let run = 1, last = null, hist = [];
      for (let b = 0; b < n; b++) { const c = row ? m[a][b] : m[b][a]; if (c) dark++; hist.push(c ? 1 : 0);
        if (c === last) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else { run = 1; last = c; } }
      const h = hist.join(""); for (const p of ["10111010000", "00001011101"]) { let i = -1; while ((i = h.indexOf(p, i + 1)) >= 0) s += 40; }
    }
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) s += 3; }
    const tot = n * n; s += (Math.ceil(Math.abs(dark * 20 - tot * 10) / tot) - 1) * 10; return s;
  }
  function matrix(text) {
    const bytes = new TextEncoder().encode(text); let v = 1;
    for (; v <= 10; v++) { const t = T[v], cap = t[1] * t[2] + t[3] * t[4]; if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= cap * 8) break; }
    if (v > 10) throw new Error("QR: text too long");
    const [ec, b1, d1, b2, d2] = T[v], cap = b1 * d1 + b2 * d2, n = 17 + 4 * v;
    const bits = [], put = (val, k) => { for (let i = k - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach((b) => put(b, 8)); put(0, Math.min(4, cap * 8 - bits.length)); while (bits.length % 8) bits.push(0);
    const cw = []; for (let i = 0; i < bits.length; i += 8) { let x = 0; for (let j = 0; j < 8; j++) x = (x << 1) | bits[i + j]; cw.push(x); }
    for (let p = 0xec; cw.length < cap; p ^= 0xec ^ 0x11) cw.push(p);
    const gen = rsGen(ec), blocks = []; let off = 0;
    for (let i = 0; i < b1 + b2; i++) { const L = i < b1 ? d1 : d2, d = cw.slice(off, off + L); off += L; blocks.push({ d, e: rsRem(d, gen) }); }
    const fin = []; for (let i = 0; i < Math.max(d1, d2); i++) blocks.forEach((b) => { if (i < b.d.length) fin.push(b.d[i]); });
    for (let i = 0; i < ec; i++) blocks.forEach((b) => fin.push(b.e[i]));
    const db = []; fin.forEach((c) => { for (let i = 7; i >= 0; i--) db.push((c >>> i) & 1); }); for (let i = 0; i < (v >= 2 && v <= 6 ? 7 : 0); i++) db.push(0);
    const m = Array.from({ length: n }, () => new Array(n).fill(false)), fn = Array.from({ length: n }, () => new Array(n).fill(false));
    const setF = (x, y, d) => { if (x >= 0 && y >= 0 && x < n && y < n) { m[y][x] = !!d; fn[y][x] = true; } };
    const finder = (cx, cy) => { for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) setF(cx + dx, cy + dy, dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4))); };
    finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
    for (let i = 8; i < n - 8; i++) { setF(i, 6, i % 2 === 0); setF(6, i, i % 2 === 0); }
    const al = AL[v]; al.forEach((ay, i) => al.forEach((ax, j) => { if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
    const fmt = (mask, mm) => { const data = mask, bitsF = (() => { let r = data << 10; for (let i = 14; i >= 10; i--) if ((r >>> i) & 1) r ^= 0x537 << (i - 10); return ((data << 10) | r) ^ 0x5412; })(), g = (i) => (bitsF >>> i) & 1;
      for (let i = 0; i <= 5; i++) mm(8, i, g(i)); mm(8, 7, g(6)); mm(8, 8, g(7)); mm(7, 8, g(8)); for (let i = 9; i < 15; i++) mm(14 - i, 8, g(i));
      for (let i = 0; i < 8; i++) mm(n - 1 - i, 8, g(i)); for (let i = 8; i < 15; i++) mm(8, n - 15 + i, g(i)); mm(8, n - 8, 1); };
    fmt(0, setF);
    if (v >= 7) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25); const bv = (v << 12) | r; for (let i = 0; i < 18; i++) { const bit = (bv >>> i) & 1, a = n - 11 + (i % 3), b = (i / 3) | 0; setF(a, b, bit); setF(b, a, bit); } }
    let bi = 0, up = true;
    for (let x = n - 1; x > 0; x -= 2) { if (x === 6) x = 5; for (let k = 0; k < n; k++) { const y = up ? n - 1 - k : k; for (let c = 0; c < 2; c++) { const xx = x - c; if (!fn[y][xx]) m[y][xx] = bi < db.length ? db[bi++] === 1 : false; } } up = !up; }
    let best = null, bs = 1e9;
    for (let k = 0; k < 8; k++) { const mm = m.map((r) => r.slice()); for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fn[y][x] && MASKS[k](x, y)) mm[y][x] = !mm[y][x];
      fmt(k, (x, y, d) => { mm[y][x] = !!d; }); const p = penalty(mm, n); if (p < bs) { bs = p; best = mm; } }
    return best;
  }
  function svg(text, quiet) {
    const m = matrix(text), n = m.length, q = quiet == null ? 4 : quiet; let d = "";
    for (let y = 0; y < n; y++) { let x = 0; while (x < n) { if (m[y][x]) { let e = x; while (e < n && m[y][e]) e++; d += `M${x + q} ${y + q}h${e - x}v1h-${e - x}z`; x = e; } else x++; } }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges" role="img"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }
  window.mogzyQR = { matrix, svg };
})();
