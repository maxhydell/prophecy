// On-device card reader: a YOLO11n card finder plus an EfficientNet-B0 identifier,
// both run in the browser with ONNX Runtime Web. Nothing is uploaded.
// Model source: huggingface.co/irfanhossainsust/playing-card-detector (AGPL-3.0).
import { cardId } from './sim';

declare const ort: any;

export interface MLDet { id: number; suit: number; rankIdx: number; score: number; red: boolean; unsure: boolean; x: number; box: [number, number, number, number]; name: string }

const SUIT_IX: Record<string, number> = { clubs: 0, diamonds: 1, spades: 2, hearts: 3 };
const RANK_IX: Record<string, number> = { two: 0, three: 1, four: 2, five: 3, six: 4, seven: 5, eight: 6, nine: 7, ten: 8, jack: 9, queen: 10, king: 11, ace: 12 };
export const CLEAR_SCORE = 0.8;

let loading: Promise<void> | null = null;
let det: any, emb: any, meta: any, E: Float32Array, L: Uint8Array;
export let loadError: string | null = null;

async function buf(u: string) { const r = await fetch(u); if (!r.ok) throw new Error(u + ' ' + r.status); return new Uint8Array(await r.arrayBuffer()); }

export function loadReader(): Promise<void> {
    if (loading) return loading;
    loading = (async () => {
        try {
            if (typeof ort === 'undefined') throw new Error('runtime missing');
            ort.env.wasm.numThreads = 1;
            ort.env.wasm.wasmPaths = new URL('./ort/', document.baseURI).href;
            const base = new URL('./models/', document.baseURI).href;
            const [d, e, m, eb, lb] = await Promise.all([buf(base + 'card_detector.onnx'), buf(base + 'embedder.onnx'), fetch(base + 'meta.json').then((r) => r.json()), buf(base + 'emb.f32'), buf(base + 'lab.u8')]);
            det = await ort.InferenceSession.create(d, { executionProviders: ['wasm'] });
            emb = await ort.InferenceSession.create(e, { executionProviders: ['wasm'] });
            meta = m; E = new Float32Array(eb.buffer, eb.byteOffset, eb.byteLength / 4); L = lb;
        } catch (err) { loadError = String(err); loading = null; throw err; }
    })();
    return loading;
}

type Box = { sc: number; x0: number; y0: number; x1: number; y1: number };
function iou(a: Box, b: Box) {
    const x1 = Math.max(a.x0, b.x0), y1 = Math.max(a.y0, b.y0), x2 = Math.min(a.x1, b.x1), y2 = Math.min(a.y1, b.y1);
    const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return i / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - i);
}

async function detect(src: CanvasImageSource, W: number, H: number): Promise<Box[]> {
    const s = Math.min(640 / W, 640 / H), nw = Math.round(W * s), nh = Math.round(H * s), px = Math.floor((640 - nw) / 2), py = Math.floor((640 - nh) / 2);
    const c = document.createElement('canvas'); c.width = c.height = 640;
    const g = c.getContext('2d', { willReadFrequently: true })!; g.fillStyle = 'rgb(114,114,114)'; g.fillRect(0, 0, 640, 640); g.drawImage(src, px, py, nw, nh);
    const d = g.getImageData(0, 0, 640, 640).data, x = new Float32Array(3 * 640 * 640), n = 640 * 640;
    for (let i = 0; i < n; i++) { x[i] = d[i * 4] / 255; x[n + i] = d[i * 4 + 1] / 255; x[2 * n + i] = d[i * 4 + 2] / 255; }
    const out = await det.run({ images: new ort.Tensor('float32', x, [1, 3, 640, 640]) });
    const o = out.output0.data as Float32Array; const bs: Box[] = [];
    for (let i = 0; i < 8400; i++) {
        const sc = o[4 * 8400 + i]; if (sc < 0.25) continue;
        const cx = o[i], cy = o[8400 + i], w = o[2 * 8400 + i], h = o[3 * 8400 + i];
        bs.push({ sc, x0: Math.max(0, (cx - w / 2 - px) / s), y0: Math.max(0, (cy - h / 2 - py) / s), x1: Math.min(W, (cx + w / 2 - px) / s), y1: Math.min(H, (cy + h / 2 - py) / s) });
    }
    bs.sort((a, b) => b.sc - a.sc); const keep: Box[] = [];
    for (const b of bs) if (keep.every((k) => iou(k, b) < 0.7)) keep.push(b);
    return keep;
}

async function identify(src: CanvasImageSource, b: Box, rot: boolean): Promise<[number, number]> {
    const c = document.createElement('canvas'); c.width = c.height = 224;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    if (rot) { g.translate(224, 224); g.rotate(Math.PI); }
    g.drawImage(src, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 0, 0, 224, 224);
    const d = g.getImageData(0, 0, 224, 224).data, x = new Float32Array(3 * 224 * 224), n = 224 * 224, m = [0.485, 0.456, 0.406], sd = [0.229, 0.224, 0.225];
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) x[k * n + i] = (d[i * 4 + k] / 255 - m[k]) / sd[k];
    const v = (await emb.run({ x: new ort.Tensor('float32', x, [1, 3, 224, 224]) })).e.data as Float32Array;
    let best = -2, bi = 0;
    for (let j = 0; j < meta.n; j++) { let s = 0; const o = j * 256; for (let k = 0; k < 256; k++) s += v[k] * E[o + k]; if (s > best) { best = s; bi = j; } }
    return [best, L[bi]];
}

// Reads every card the finder sees. Returns one entry per distinct card (best score wins),
// highest score first. Score is how close the card looks to reference images, not a probability.
export async function readCards(src: CanvasImageSource, W: number, H: number, maxBoxes = 8): Promise<MLDet[]> {
    await loadReader();
    const boxes = (await detect(src, W, H)).slice(0, maxBoxes);
    const best = new Map<number, MLDet>();
    for (const b of boxes) {
        const a = await identify(src, b, false), r = await identify(src, b, true);
        const [score, ci] = a[0] >= r[0] ? a : r;
        const cls = meta.classes[ci]; if (!cls || cls.id === 'joker') continue;
        const m = /^(\w+)_of_(\w+)$/.exec(cls.id); if (!m) continue;
        const suit = SUIT_IX[m[2]], rankIdx = RANK_IX[m[1]]; if (suit === undefined || rankIdx === undefined) continue;
        const id = cardId(suit, rankIdx), prev = best.get(id);
        if (!prev || score > prev.score) best.set(id, { id, suit, rankIdx, score, red: suit === 1 || suit === 3, unsure: score < CLEAR_SCORE, x: b.x0, box: [b.x0, b.y0, b.x1, b.y1], name: cls.name });
    }
    return Array.from(best.values()).sort((a, b) => b.score - a.score);
}
