// On-device card recognition. No network, no server: finds printed corner
// indices (a rank glyph directly above a suit glyph, on bright card stock) and
// matches the binarized glyphs against rendered templates. Cards can be fanned
// or rotated: each candidate rank+suit pair is rotation-normalized from the
// pair's own geometry before matching, so whole-card segmentation is never
// needed. Center pips are rejected with a card-edge test: a real corner index
// sits at the edge of the card stock, a pip is surrounded by it. Templates
// cover solid and outline digits in sans and serif, since decks print corner
// ranks in many styles. Every detection is shown for confirmation; unsure
// reads are flagged with a question mark.

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT_GLYPHS = ['♣', '♦', '♠', '♥']; // matches SUITS order: clubs, diamonds, spades, hearts
const RED_SUITS = [1, 3];
const BLACK_SUITS = [0, 2];
const N = 36; // normalized template size

function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
}

// Crop points to their bbox, scale preserving aspect into N x N with margin.
function normalizePoints(pts) {
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (const [px, py] of pts) {
        if (px < x0) x0 = px;
        if (py < y0) y0 = py;
        if (px > x1) x1 = px;
        if (py > y1) y1 = py;
    }
    const bw = Math.max(1, x1 - x0 + 1);
    const bh = Math.max(1, y1 - y0 + 1);
    const scale = Math.min((N - 6) / bw, (N - 6) / bh);
    const ox = (N - bw * scale) / 2;
    const oy = (N - bh * scale) / 2;
    const bmp = new Uint8Array(N * N);
    for (const [px, py] of pts) {
        const nx = Math.min(N - 1, Math.max(0, Math.round(ox + (px - x0) * scale)));
        const ny = Math.min(N - 1, Math.max(0, Math.round(oy + (py - y0) * scale)));
        bmp[ny * N + nx] = 1;
    }
    return { bmp, fill: pts.length / (bw * bh) };
}

// Render a glyph template into an N x N binary bitmap. outline=true strokes the
// glyph instead of filling it, for decks whose corner ranks are hollow.
function glyphBitmap(text, px, font, weight, deg, outline) {
    const c = makeCanvas(px * 3, px * 2.4);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#fff';
    x.fillRect(0, 0, c.width, c.height);
    x.font = `${weight} ${px}px ${font}`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    if (deg) {
        x.translate(c.width / 2, c.height / 2);
        x.rotate((deg * Math.PI) / 180);
        x.translate(-c.width / 2, -c.height / 2);
    }
    if (outline) {
        x.strokeStyle = '#000';
        x.lineWidth = Math.max(1.6, px / 20);
        x.strokeText(text, c.width / 2, c.height / 2);
    } else {
        x.fillStyle = '#000';
        x.fillText(text, c.width / 2, c.height / 2);
    }
    const img = x.getImageData(0, 0, c.width, c.height);
    const pts = [];
    for (let py = 0; py < c.height; py++) {
        for (let pxx = 0; pxx < c.width; pxx++) {
            if (img.data[(py * c.width + pxx) * 4] < 128) pts.push([pxx, py]);
        }
    }
    if (!pts.length) return null;
    return normalizePoints(pts);
}

// Best IoU over small translations, with a fill-ratio penalty.
function scoreBitmaps(a, afill, tb) {
    let best = 0;
    for (let dy = -3; dy <= 3; dy += 1.5) {
        for (let dx = -3; dx <= 3; dx += 1.5) {
            let inter = 0, uni = 0;
            for (let y = 0; y < N; y++) {
                for (let x = 0; x < N; x++) {
                    const av = a[y * N + x];
                    const bx = x + dx, by = y + dy;
                    const bv = bx >= 0 && bx < N && by >= 0 && by < N ? tb.bmp[(by | 0) * N + (bx | 0)] : 0;
                    if (av && bv) inter++;
                    if (av || bv) uni++;
                }
            }
            const s = uni ? inter / uni : 0;
            if (s > best) best = s;
        }
    }
    const fillPenalty = Math.min(0.3, Math.abs(afill - tb.fill) * 0.7);
    return Math.max(0, best - fillPenalty);
}

let TEMPLATES = null;
function templates() {
    if (TEMPLATES) return TEMPLATES;
    const SANS = 'Arial, Helvetica, sans-serif';
    const SERIF = 'Georgia, Times New Roman, serif';
    const rankStyles = [
        { font: SANS, weight: '700', outline: false },
        { font: SANS, weight: '400', outline: false },
        { font: SERIF, weight: '700', outline: false },
        { font: SANS, weight: '700', outline: true },
        { font: SANS, weight: '400', outline: true },
        { font: SERIF, weight: '400', outline: true },
    ];
    const suitStyles = [
        { font: SANS, weight: '400', outline: false },
        { font: SERIF, weight: '400', outline: false },
        { font: SANS, weight: '700', outline: false },
    ];
    const ROTS = [-16, -8, 0, 8, 16]; // residual tilt after pair normalization
    const rankTemps = [];
    for (const r of RANKS) {
        const variants = [];
        for (const { font, weight, outline } of rankStyles) {
            for (const px of [44, 58]) {
                for (const deg of ROTS) {
                    const b = glyphBitmap(r, px, font, weight, deg, outline);
                    if (b) variants.push(b);
                }
            }
        }
        rankTemps.push(variants);
    }
    const suitTemps = [];
    for (const s of SUIT_GLYPHS) {
        const variants = [];
        for (const { font, weight, outline } of suitStyles) {
            for (const px of [44, 58]) {
                for (const deg of ROTS) {
                    const b = glyphBitmap(s, px, font, weight, deg, outline);
                    if (b) variants.push(b);
                }
            }
        }
        suitTemps.push(variants);
    }
    TEMPLATES = { rankTemps, suitTemps };
    return TEMPLATES;
}

function bestMatch(norm, tempsList) {
    let best = -1, bestScore = 0, second = 0;
    for (let i = 0; i < tempsList.length; i++) {
        let bestFor = 0;
        for (const t of tempsList[i]) {
            const s = scoreBitmaps(norm.bmp, norm.fill, t);
            if (s > bestFor) bestFor = s;
        }
        if (bestFor > bestScore) { second = bestScore; bestScore = bestFor; best = i; }
        else if (bestFor > second) second = bestFor;
    }
    return { index: best, score: bestScore, margin: bestScore - second };
}

// Dilate a binary mask by one pixel (heals linen-texture holes in ink).
function dilate(mask, w, h) {
    const out = new Uint8Array(mask);
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (mask[i]) continue;
            if (mask[i - 1] || mask[i + 1] || mask[i - w] || mask[i + w]) out[i] = 1;
        }
    }
    return out;
}

// Connected components of a binary mask; returns blobs with pixel lists.
function inkComponents(mask, w, h) {
    const labels = new Int32Array(w * h).fill(-1);
    const blobs = [];
    const stack = [];
    for (let i = 0; i < w * h; i++) {
        if (!mask[i] || labels[i] !== -1) continue;
        const id = blobs.length;
        const pts = [];
        let x0 = w, y0 = h, x1 = 0, y1 = 0;
        stack.length = 0;
        stack.push(i);
        labels[i] = id;
        while (stack.length) {
            const p = stack.pop();
            const px = p % w, py = (p / w) | 0;
            pts.push([px, py]);
            if (px < x0) x0 = px;
            if (px > x1) x1 = px;
            if (py < y0) y0 = py;
            if (py > y1) y1 = py;
            if (px > 0 && mask[p - 1] && labels[p - 1] === -1) { labels[p - 1] = id; stack.push(p - 1); }
            if (px < w - 1 && mask[p + 1] && labels[p + 1] === -1) { labels[p + 1] = id; stack.push(p + 1); }
            if (py > 0 && mask[p - w] && labels[p - w] === -1) { labels[p - w] = id; stack.push(p - w); }
            if (py < h - 1 && mask[p + w] && labels[p + w] === -1) { labels[p + w] = id; stack.push(p + w); }
        }
        blobs.push({ pts, x0, y0, x1, y1 });
    }
    return blobs;
}

// Fraction of card-stock pixels in a small window centered at (cx, cy).
function cardFrac(card, w, h, cx, cy, rad) {
    let tot = 0, on = 0;
    const x0 = Math.max(0, Math.round(cx - rad)), x1 = Math.min(w - 1, Math.round(cx + rad));
    const y0 = Math.max(0, Math.round(cy - rad)), y1 = Math.min(h - 1, Math.round(cy + rad));
    for (let y = y0; y <= y1; y += 2) {
        for (let x = x0; x <= x1; x += 2) {
            tot++;
            if (card[y * w + x]) on++;
        }
    }
    return tot ? on / tot : 0;
}

// Read one photo. Returns detections [{ rankIdx, suit, score, red, x, unsure }].
export function recognizePhoto(img, maxCards) {
    const T = templates();
    const maxDim = 1400;
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const c = makeCanvas(w, h);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, w, h);
    const data = x.getImageData(0, 0, w, h).data;

    const card = new Uint8Array(w * h); // bright, low saturation: card stock
    let ink = new Uint8Array(w * h);    // dark or strongly red: printed glyphs
    const redInk = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const lum = (r + g + b) / 3;
        if (lum > 105 && mx - mn < 75) card[i] = 1;
        const isRed = r > 75 && r > g * 1.3 && r > b * 1.3;
        if (lum < 118 || isRed) {
            ink[i] = 1;
            if (isRed) redInk[i] = 1;
        }
    }
    ink = dilate(ink, w, h); // heal texture pinholes so glyphs stay in one piece

    const blobs = inkComponents(ink, w, h);
    // Keep glyph-sized blobs sitting on card stock.
    const glyphs = [];
    for (const b of blobs) {
        const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
        if (bh < 8 || bh > 130 || bw < 3 || bw > 130) continue;
        if (b.pts.length < 15 || b.pts.length > 9000) continue;
        // Card stock around the glyph: sample an expanded bbox. Corner glyphs
        // sit at the card's edge, so only part of the surroundings is stock.
        const ex = Math.max(0, b.x0 - bh), ey = Math.max(0, b.y0 - bh);
        const ex1 = Math.min(w - 1, b.x1 + bh), ey1 = Math.min(h - 1, b.y1 + bh);
        let tot = 0, on = 0;
        for (let yy = ey; yy <= ey1; yy += 3) {
            for (let xx = ex; xx <= ex1; xx += 3) {
                tot++;
                if (card[yy * w + xx]) on++;
            }
        }
        if (tot === 0 || on / tot < 0.35) continue;
        let redHits = 0;
        for (const [px, py] of b.pts) if (redInk[py * w + px]) redHits++;
        glyphs.push({
            pts: b.pts, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1,
            cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, bw, bh,
            red: redHits / b.pts.length > 0.4,
        });
    }
    if (glyphs.length < 2) return [];

    // Candidate corner indices: a rank glyph with a suit glyph just below it in
    // the card's own (possibly rotated) frame. The pair's geometry gives the
    // rotation, so tilted or upside-down corners normalize to upright.
    const candidates = [];
    for (let ri = 0; ri < glyphs.length; ri++) {
        const r = glyphs[ri];
        for (let si = 0; si < glyphs.length; si++) {
            if (si === ri) continue;
            const s = glyphs[si];
            if (s.red !== r.red) continue;
            const dx = s.cx - r.cx, dy = s.cy - r.cy;
            const dist = Math.hypot(dx, dy);
            if (dist < 0.55 * r.bh || dist > 2.3 * r.bh) continue;
            if (s.bh < 0.4 * r.bh || s.bh > 1.45 * r.bh) continue;
            // Rotate the pair into an upright frame: rank above suit.
            const ang = Math.atan2(dx, dy); // 0 when the suit is straight below
            const ca = Math.cos(ang), sa = Math.sin(ang);
            const sxp = dx * ca - dy * sa; // sideways offset after normalization
            if (Math.abs(sxp) > 1.2 * r.bh) continue;
            candidates.push({ ri, si, ang, ca, sa, dist });
        }
    }

    const out = [];
    const edgePassing = [];
    const suitClaimed = new Map(); // suit glyph index -> best score so far
    for (const cand of candidates) {
        const r = glyphs[cand.ri];
        const s = glyphs[cand.si];

        // Card-edge test. A corner index sits at the card's edge: the card
        // ends just beyond the rank glyph and continues past the suit glyph
        // toward the card's middle. Center pips have stock in both directions.
        const dirx = Math.sin(cand.ang), diry = Math.cos(cand.ang); // image-space down along pair axis
        const upFrac = cardFrac(card, w, h, r.cx - dirx * 1.7 * r.bh, r.cy - diry * 1.7 * r.bh, r.bh * 0.55);
                const downFrac = cardFrac(card, w, h, s.cx + dirx * 1.4 * s.bh, s.cy + diry * 1.4 * s.bh, s.bh * 0.6);
        if (downFrac < 0.25) continue;
        if (r.bh < 20) continue; // too small to read; noise specks

        cand.rbh = r.bh;
        edgePassing.push(cand);
    }
    if (!edgePassing.length) return [];
    // Keep the two geometrically likeliest suit partners per rank glyph (a
    // corner suit sits about one glyph-height below its rank). Bounds the work.
    const byRank = new Map();
    for (const cand of edgePassing) {
        const k = cand.ri;
        if (!byRank.has(k)) byRank.set(k, []);
        byRank.get(k).push(cand);
    }
    edgePassing.length = 0;
    for (const list of byRank.values()) {
        list.sort((a, b) => Math.abs(a.dist / a.rbh - 1.25) - Math.abs(b.dist / b.rbh - 1.25));
        for (const c of list.slice(0, 2)) edgePassing.push(c);
    }
    for (const cand of edgePassing) {
        const r = glyphs[cand.ri];
        const s = glyphs[cand.si];

        // Rotate all nearby same-color glyphs into the pair's upright frame and
        // collect the rank group (handles two-glyph ranks like "10").
        const rankPts = [];
        for (const g of glyphs) {
            if (g.red !== r.red) continue;
            const gdx = g.cx - r.cx, gdy = g.cy - r.cy;
            const gxp = gdx * cand.ca - gdy * cand.sa;
            const gyp = gdx * cand.sa + gdy * cand.ca;
            if (Math.abs(gyp) > 0.5 * r.bh) continue;
            if (Math.abs(gxp) > 1.25 * r.bh) continue;
            for (const [px, py] of g.pts) {
                const pdx = px - r.cx, pdy = py - r.cy;
                rankPts.push([pdx * cand.ca - pdy * cand.sa, pdx * cand.sa + pdy * cand.ca]);
            }
        }
        const suitPts = [];
        for (const [px, py] of s.pts) {
            const pdx = px - s.cx, pdy = py - s.cy;
            suitPts.push([pdx * cand.ca - pdy * cand.sa, pdx * cand.sa + pdy * cand.ca]);
        }
        if (!rankPts.length || !suitPts.length) continue;

        // The suit glyph is the more distinctive shape; cheap reject first.
        const suitNorm = normalizePoints(suitPts);
        const suitCandidates = s.red ? RED_SUITS : BLACK_SUITS;
        let suitIdx = -1, suitScore = 0;
        const perSuit = {};
        for (const si2 of suitCandidates) {
            perSuit[si2] = 0;
            for (const t of T.suitTemps[si2]) {
                const sc = scoreBitmaps(suitNorm.bmp, suitNorm.fill, t);
                if (sc > perSuit[si2]) perSuit[si2] = sc;
                if (sc > suitScore) { suitScore = sc; suitIdx = si2; }
            }
        }
        // Clubs and spades are close in outline. When their template scores are
        // near-tied, decide by shape: a club's top lobe is followed by a sudden
        // widening (a neck between lobes); a spade widens gradually to a point.
        if (!s.red && Math.abs(perSuit[0] - perSuit[2]) < 0.08) {
            const rowW = (y) => { let c = 0; for (let xx = 0; xx < N; xx++) c += suitNorm.bmp[y * N + xx]; return c; };
            const jump = rowW(15) - rowW(12);
            suitIdx = jump >= 7 ? 0 : 2;
        }
        if (suitScore < 0.3) continue;

        const rankNorm = normalizePoints(rankPts);
        const rank = bestMatch(rankNorm, T.rankTemps);
        if (rank.index < 0 || rank.score < 0.3) continue;

        // A center pip is itself a suit symbol: if the "rank" blob matches a
        // suit template better than any rank, the pair is two pips, not an index.
        let pipScore = 0;
        for (const si3 of suitCandidates) {
            for (const t of T.suitTemps[si3]) {
                const sc = scoreBitmaps(rankNorm.bmp, rankNorm.fill, t);
                if (sc > pipScore) pipScore = sc;
            }
        }
        if (pipScore > 0.45 && pipScore > rank.score) continue;

        const score = Math.min(rank.score, suitScore);
        if (score < 0.42) continue;
        const claimed = suitClaimed.get(cand.si) || 0;
        if (score <= claimed) continue;
        suitClaimed.set(cand.si, score);
        const ambiguous = rank.margin < 0.05;
        out.push({
            rankIdx: rank.index, suit: suitIdx, score, red: s.red, x: r.cx, y: r.cy,
            unsure: score < 0.5 || ambiguous, rbh: r.bh,
        });
    }

    // Center pips are much bigger than corner indices in the same photo. Judge
    // size against the confident reads, not the smallest speck of noise.
    const sure = out.filter((d) => !d.unsure).map((d) => d.rbh).sort((a, b) => a - b);
    if (sure.length) {
        const ref = sure[Math.floor(sure.length / 2)];
        for (let i = out.length - 1; i >= 0; i--) if (out[i].rbh > 1.35 * ref) out.splice(i, 1);
    }
    // Dedupe by card identity, keep the strongest read of each card.
    out.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const dedup = [];
    for (const d of out) {
        const key = d.suit * 13 + d.rankIdx;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(d);
        if (dedup.length >= maxCards) break;
    }
    dedup.sort((a, b) => a.x - b.x);
    return dedup;
}

