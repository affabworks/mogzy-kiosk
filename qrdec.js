/* QR decoder for camera frames (byte mode, error-correction level M, versions 1-10, like qr.js produces). No dependencies.
   window.mogzyQRDecode({data: RGBA bytes, width, height}) -> string | null */
(function () {
  const T = [null, [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]];
  const AL = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0), div = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (((y / 2) | 0) + ((x / 3) | 0)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0];

  /* ---- Reed-Solomon error correction (roots alpha^0 .. alpha^(ec-1)) ---- */
  function rsCorrect(cw, ec) {
    const n = cw.length, S = []; let bad = false;
    for (let i = 0; i < ec; i++) { let s = 0; for (let j = 0; j < n; j++) s = mul(s, EXP[i]) ^ cw[j]; S.push(s); if (s) bad = true; }
    if (!bad) return cw;
    let C = [1], B = [1], L = 0, m = 1, b = 1;
    for (let k = 0; k < ec; k++) {
      let d = S[k]; for (let i = 1; i <= L; i++) d ^= mul(C[i] || 0, S[k - i]);
      if (d === 0) { m++; continue; }
      const coef = div(d, b), sh = new Array(m).fill(0).concat(B.map((x) => mul(x, coef))), T0 = C.slice();
      while (C.length < sh.length) C.push(0); for (let i = 0; i < sh.length; i++) C[i] ^= sh[i];
      if (2 * L <= k) { L = k + 1 - L; B = T0; b = d; m = 1; } else m++;
    }
    if (L * 2 > ec) return null;
    const pos = []; for (let p = 0; p < n; p++) { const xinv = EXP[(255 - ((n - 1 - p) % 255)) % 255]; let v = 0, pw = 1; for (let i = 0; i <= L; i++) { v ^= mul(C[i] || 0, pw); pw = mul(pw, xinv); } if (v === 0) pos.push(p); }
    if (pos.length !== L) return null;
    const om = new Array(ec).fill(0); for (let i = 0; i < ec; i++) for (let j = 0; j <= i; j++) om[i] ^= mul(C[j] || 0, S[i - j]);
    const out = cw.slice();
    for (const p of pos) {
      const X = EXP[(n - 1 - p) % 255], xinv = EXP[(255 - ((n - 1 - p) % 255)) % 255]; let ov = 0, pw = 1; for (let i = 0; i < ec; i++) { ov ^= mul(om[i], pw); pw = mul(pw, xinv); }
      let dv = 0; for (let i = 1; i <= L; i += 2) { let q = 1; for (let t = 0; t < i - 1; t++) q = mul(q, xinv); dv ^= mul(C[i] || 0, q); }
      if (!dv) return null; out[p] ^= mul(X, div(ov, dv));
    }
    for (let i = 0; i < ec; i++) { let s = 0; for (let j = 0; j < n; j++) s = mul(s, EXP[i]) ^ out[j]; if (s) return null; }
    return out;
  }

  /* ---- image -> black/white ---- */
  function binarize(lum, W, H) {
    const I = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += lum[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; } }
    const s = Math.max(9, ((Math.min(W, H) / 8) | 0) | 1), h = s >> 1, bin = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) { const y0 = Math.max(0, y - h), y1 = Math.min(H, y + h + 1);
      for (let x = 0; x < W; x++) { const x0 = Math.max(0, x - h), x1 = Math.min(W, x + h + 1), cnt = (x1 - x0) * (y1 - y0);
        const sum = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
        bin[y * W + x] = lum[y * W + x] * cnt < sum * 0.88 ? 1 : 0; } }
    return bin;
  }

  /* ---- finder patterns (1:1:3:1:1) ---- */
  function ratioOK(r, tolerant) {
    const t = r[0] + r[1] + r[2] + r[3] + r[4]; if (t < 7) return 0; const ms = t / 7, e = ms * (tolerant ? 0.65 : 0.55);
    return Math.abs(r[0] - ms) < e && Math.abs(r[1] - ms) < e && Math.abs(r[2] - 3 * ms) < 3 * e && Math.abs(r[3] - ms) < e && Math.abs(r[4] - ms) < e ? ms : 0;
  }
  function crossLine(bin, W, H, x, y, dx, dy) {   // 1:1:3:1:1 through (x,y) along (dx,dy); returns {c: center offset along the line, ms} or null
    const at = (i) => { const xx = x + dx * i, yy = y + dy * i; return xx < 0 || yy < 0 || xx >= W || yy >= H ? -1 : bin[yy * W + xx]; };
    if (at(0) !== 1) return null; const r = [0, 0, 0, 0, 0]; let i = 0;
    while (at(i) === 1) { r[2]++; i++; } let hi = i; while (at(i) === 0) { r[3]++; i++; } while (at(i) === 1) { r[4]++; i++; } const hiEnd = i;
    i = -1; while (at(i) === 1) { r[2]++; i--; } let lo = i; while (at(i) === 0) { r[1]++; i--; } while (at(i) === 1) { r[0]++; i--; }
    if (at(hiEnd) === -1 && false) return null; const ms = ratioOK(r, true); if (!ms) return null;
    return { c: (lo + hi) / 2 + 0.5 - 0.5, ms };
  }
  function findFinders(bin, W, H) {
    const cand = [];
    for (let y = 0; y < H; y += 1) {
      let x = 0; const runs = [], starts = []; let cur = bin[y * W], st = 0;
      for (x = 1; x < W; x++) { if (bin[y * W + x] !== cur) { runs.push(x - st); starts.push(st); st = x; cur = bin[y * W + x]; } }
      runs.push(W - st); starts.push(st); const first = bin[y * W];
      for (let k = 0; k + 4 < runs.length; k++) {
        if ((first === 1) !== (k % 2 === 0)) continue;   // run k must be black
        const r = runs.slice(k, k + 5), ms = ratioOK(r, false); if (!ms) continue;
        const cx = Math.round(starts[k + 2] + runs[k + 2] / 2 - 0.5);
        const v = crossLine(bin, W, H, cx, y, 0, 1); if (!v) continue;
        const cy = Math.round(y + v.c), hh = crossLine(bin, W, H, cx, cy, 1, 0); if (!hh) continue;
        const fx = cx + hh.c, fy = cy, fms = (ms + v.ms + hh.ms) / 3;
        let hit = null; for (const c of cand) if (Math.hypot(c.x - fx, c.y - fy) < Math.max(c.ms, fms) * 2.5) { hit = c; break; }
        if (hit) { hit.x = (hit.x * hit.n + fx) / (hit.n + 1); hit.y = (hit.y * hit.n + fy) / (hit.n + 1); hit.ms = (hit.ms * hit.n + fms) / (hit.n + 1); hit.n++; } else cand.push({ x: fx, y: fy, ms: fms, n: 1 });
      }
    }
    return cand.filter((c) => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 9);
  }
  function pickTriple(c) {
    let best = null, bs = 1e9;
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) for (let k = j + 1; k < c.length; k++) {
      const P = [c[i], c[j], c[k]];
      for (let a = 0; a < 3; a++) { const A = P[a], B = P[(a + 1) % 3], C = P[(a + 2) % 3];
        const ab = Math.hypot(B.x - A.x, B.y - A.y), ac = Math.hypot(C.x - A.x, C.y - A.y), bc = Math.hypot(C.x - B.x, C.y - B.y);
        if (ab < 10 || ac < 10) continue; const lr = Math.max(ab, ac) / Math.min(ab, ac); if (lr > 1.35) continue;
        const dot = ((B.x - A.x) * (C.x - A.x) + (B.y - A.y) * (C.y - A.y)) / (ab * ac); if (Math.abs(dot) > 0.35) continue;
        const hyp = Math.abs(bc / ((ab + ac) / 2) - Math.SQRT2); if (hyp > 0.35) continue;
        const msr = Math.max(A.ms, B.ms, C.ms) / Math.min(A.ms, B.ms, C.ms); if (msr > 1.8) continue;
        const sc = Math.abs(dot) * 2 + (lr - 1) + hyp + (msr - 1) - (A.n + B.n + C.n) * 0.002;
        if (sc < bs) { bs = sc; best = [A, B, C]; } }
    }
    if (!best) return null; const [A, B, C] = best, cr = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
    return cr > 0 ? { tl: A, tr: B, bl: C } : { tl: A, tr: C, bl: B };
  }

  /* ---- geometry ---- */
  function homography(src, dst) {   // 4 points each; returns function (x,y)->[X,Y]
    const M = [], b = [];
    for (let i = 0; i < 4; i++) { const [x, y] = src[i], [X, Y] = dst[i];
      M.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X); M.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y); }
    for (let c = 0; c < 8; c++) { let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; if (Math.abs(M[p][c]) < 1e-12) return null;
      [M[c], M[p]] = [M[p], M[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = 0; r < 8; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < 8; k++) M[r][k] -= f * M[c][k]; b[r] -= f * b[c]; } }
    const h = b.map((v, i) => v / M[i][i]);
    return (x, y) => { const w = h[6] * x + h[7] * y + 1; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };
  }
  const bitAt = (bin, W, H, p) => { const x = Math.round(p[0] - 0.5), y = Math.round(p[1] - 0.5); return x < 0 || y < 0 || x >= W || y >= H ? 0 : bin[y * W + x]; };

  function funcMap(v) {
    const n = 17 + 4 * v, f = Array.from({ length: n }, () => new Uint8Array(n)), set = (x, y) => { if (x >= 0 && y >= 0 && x < n && y < n) f[y][x] = 1; };
    for (const [cx, cy] of [[0, 0], [n - 7, 0], [0, n - 7]]) for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) set(cx + dx, cy + dy);
    for (let i = 0; i < n; i++) { set(i, 6); set(6, i); }
    const al = AL[v]; al.forEach((ay, i) => al.forEach((ax, j) => { if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy); }));
    for (let i = 0; i < 9; i++) { set(8, i); set(i, 8); } for (let i = 0; i < 8; i++) { set(n - 1 - i, 8); set(8, n - 1 - i); }
    if (v >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { set(n - 11 + j, i); set(i, n - 11 + j); }
    return f;
  }
  const FMT = (() => { const a = []; for (let d = 0; d < 32; d++) { let r = d << 10; for (let i = 14; i >= 10; i--) if ((r >>> i) & 1) r ^= 0x537 << (i - 10); a.push(((d << 10) | r) ^ 0x5412); } return a; })();
  const pop = (x) => { let c = 0; while (x) { c += x & 1; x >>>= 1; } return c; };

  function readGrid(g, v) {   // g: n x n of 0/1 -> string | null
    const n = 17 + 4 * v, B = (x, y) => g[y][x];
    let fa = 0, fb = 0;
    for (let i = 0; i <= 5; i++) fa |= B(8, i) << i; fa |= B(8, 7) << 6; fa |= B(8, 8) << 7; fa |= B(7, 8) << 8; for (let i = 9; i < 15; i++) fa |= B(14 - i, 8) << i;
    for (let i = 0; i < 8; i++) fb |= B(n - 1 - i, 8) << i; for (let i = 8; i < 15; i++) fb |= B(8, n - 15 + i) << i;
    let bestD = 99, fd = -1; for (let d = 0; d < 32; d++) { const e = Math.min(pop(FMT[d] ^ fa), pop(FMT[d] ^ fb)); if (e < bestD) { bestD = e; fd = d; } }
    if (bestD > 3 || fd >> 3 !== 0) return null;   // only level M
    const mask = fd & 7, fn = funcMap(v), bits = []; let up = true;
    for (let x = n - 1; x > 0; x -= 2) { if (x === 6) x = 5; for (let k = 0; k < n; k++) { const y = up ? n - 1 - k : k; for (let c = 0; c < 2; c++) { const xx = x - c; if (!fn[y][xx]) bits.push(B(xx, y) ^ (MASKS[mask](xx, y) ? 1 : 0)); } } up = !up; }
    const [ec, b1, d1, b2, d2] = T[v], total = b1 * d1 + b2 * d2 + ec * (b1 + b2), cw = [];
    for (let i = 0; i < total; i++) { let x = 0; for (let j = 0; j < 8; j++) x = (x << 1) | bits[i * 8 + j]; cw.push(x); }
    const nb = b1 + b2, dl = (i) => (i < b1 ? d1 : d2), blocks = Array.from({ length: nb }, () => ({ d: [], e: [] })); let p = 0;
    for (let i = 0; i < Math.max(d1, d2); i++) for (let k = 0; k < nb; k++) if (i < dl(k)) blocks[k].d.push(cw[p++]);
    for (let i = 0; i < ec; i++) for (let k = 0; k < nb; k++) blocks[k].e.push(cw[p++]);
    const data = []; for (const b of blocks) { const r = rsCorrect(b.d.concat(b.e), ec); if (!r) return null; data.push(...r.slice(0, b.d.length)); }
    let bp = 0; const rd = (k) => { let x = 0; for (let i = 0; i < k; i++, bp++) x = (x << 1) | ((data[bp >> 3] >> (7 - (bp & 7))) & 1); return x; };
    if (rd(4) !== 4) return null; const len = rd(v < 10 ? 8 : 16); if (len * 8 + bp > data.length * 8) return null;
    const bytes = new Uint8Array(len); for (let i = 0; i < len; i++) bytes[i] = rd(8);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  }

  function buildMap(bin, W, H, f, v) {   // module coords -> image coords for a candidate version (alignment pattern refines perspective)
    const { tl, tr, bl } = f, n = 17 + 4 * v, ex = [(tr.x - tl.x) / (n - 7), (tr.y - tl.y) / (n - 7)], ey = [(bl.x - tl.x) / (n - 7), (bl.y - tl.y) / (n - 7)];
    const aff = (u, w) => [tl.x + (u - 3.5) * ex[0] + (w - 3.5) * ey[0], tl.y + (u - 3.5) * ex[1] + (w - 3.5) * ey[1]];
    let br = aff(n - 6.5, n - 6.5);
    if (v >= 2) {
      let bsx = br, bs = -1;
      for (let oy = -3.5; oy <= 3.5; oy += 0.5) for (let ox = -3.5; ox <= 3.5; ox += 0.5) {
        const c = [br[0] + ox * ex[0] + oy * ey[0], br[1] + ox * ex[1] + oy * ey[1]]; let sc = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const want = Math.max(Math.abs(dx), Math.abs(dy)) !== 1 ? 1 : 0;
          if (bitAt(bin, W, H, [c[0] + dx * ex[0] + dy * ey[0] + 0.5, c[1] + dx * ex[1] + dy * ey[1] + 0.5]) === want) sc++; }
        if (sc > bs) { bs = sc; bsx = c; } }
      if (bs >= 22) br = bsx;
    }
    return homography([[3.5, 3.5], [n - 3.5, 3.5], [n - 6.5, n - 6.5], [3.5, n - 3.5]], [[tl.x + 0.5, tl.y + 0.5], [tr.x + 0.5, tr.y + 0.5], [br[0] + 0.5, br[1] + 0.5], [bl.x + 0.5, bl.y + 0.5]]);
  }
  function tryDecode(bin, W, H, f) {
    const cand = [];
    for (let v = 1; v <= 10; v++) {
      const n = 17 + 4 * v, M = buildMap(bin, W, H, f, v); if (!M) continue;
      let ok = 0, tot = 0; for (let u = 8; u <= n - 9; u++) { const want = u % 2 === 0 ? 1 : 0; if (bitAt(bin, W, H, M(u + 0.5, 6.5)) === want) ok++; if (bitAt(bin, W, H, M(6.5, u + 0.5)) === want) ok++; tot += 2; }
      cand.push([v, tot ? ok / tot : 0, M]);
    }
    cand.sort((a, b) => b[1] - a[1]);
    for (const [v, sc, M] of cand.slice(0, 3)) {
      if (sc < 0.7) break;
      const n = 17 + 4 * v, g = Array.from({ length: n }, () => new Uint8Array(n));
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { let c = 0; for (const [ox, oy] of [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]]) c += bitAt(bin, W, H, M(x + 0.5 + ox, y + 0.5 + oy)); g[y][x] = c >= 3 ? 1 : 0; }
      const r = readGrid(g, v); if (r != null) return r;
    }
    return null;
  }

  function decode(img) {
    const W = img.width, H = img.height, px = img.data, lum = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) lum[i] = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8;
    for (const inv of [false, true]) {
      const bin = binarize(lum, W, H); if (inv) for (let i = 0; i < bin.length; i++) bin[i] ^= 1;
      const c = findFinders(bin, W, H); if (c.length < 3) continue;
      // try the best few triples (a stray pattern can win the first pick)
      const used = new Set(); for (let t = 0; t < 3; t++) { const f = pickTriple(c.filter((x) => !used.has(x))); if (!f) break; const r = tryDecode(bin, W, H, f); if (r != null) return r; used.add(f.tl); }
    }
    return null;
  }
  window.mogzyQRDecode = decode;
})();
