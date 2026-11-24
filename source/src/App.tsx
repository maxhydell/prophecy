import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bullets, Caption, ChoiceRow, Closing, Facts, FileButton, FileCard, Group, Header, Heading, KeySentence, NumberedList, Paragraph, Photos, Text, useLocalState } from './ui';
import cardsArt from './photos/prophecy-cards.png';
import { cardId, evaluateCalls, evaluateLeads, rankOf, suitOf } from './sim';
import { recognizePhoto } from './recog';
import { loadReader, readCards } from './mlreader';
import type { LeadResult, Result } from './sim';
import type { Detection } from './recog';

const SUITS = [
    { symbol: '♣', name: 'Clubs' },
    { symbol: '♦', name: 'Diamonds' },
    { symbol: '♠', name: 'Spades' },
    { symbol: '♥', name: 'Hearts' },
];
const RANK_LABELS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const ROUNDS = [1, 2, 3, 4, 5, 6, 7].map((r) => ({ round: r, cards: 8 - r, trump: (r - 1) % 4 }));
const SIMS_PER_CALL = 2500;
const LEAD_WORLDS = 2000;
const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th'];
const oppLabel = (i: number) => (i === 0 ? 'Player on your left' : `${ORDINALS[i]} player to your left`);
const cardLabel = (c: number) => `${RANK_LABELS[rankOf(c) - 2]}${SUITS[suitOf(c)].symbol}`;
const isRedCard = (c: number) => suitOf(c) === 1 || suitOf(c) === 3;

type GameLedger = { rounds: Record<number, { called: number; got: number }> };

// This page is opened directly in the browser, so live camera video can be used on iPhone too.
const isIOSWebKit = false;

// Live camera scanner. Tries the front camera as live video first; where the
// browser cannot grant that, it falls back to opening the camera for one photo
// per card. Both paths use the same on-device reader as the photo scanner. A
// card is added on its own only after a clear (not unsure) read: twice in a
// row for live video, once per snapped photo, so a shaky guess never counts
// as a scan. Every read also shows as a chip the player can tap to add.
// Video frames and photos never leave the device.
function CameraScanner({
    cardsPer,
    handCount,
    onLock,
    onClose,
    onReview,
}: {
    cardsPer: number;
    handCount: number;
    onLock: (id: number) => 'added' | 'duplicate' | 'full';
    onClose: () => void;
    onReview: () => void;
}) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const timerRef = useRef<number | null>(null);
    const snapInputRef = useRef<HTMLInputElement>(null);
    const pendingRef = useRef<{ key: number | null; count: number }>({ key: null, count: 0 });
    const lastLockRef = useRef<number | null>(null);
    const onLockRef = useRef(onLock);
    onLockRef.current = onLock;
    const [mode, setMode] = useState<'starting' | 'live' | 'snap'>('starting');
    const [guess, setGuess] = useState<Detection | null>(null);
    const [snapGuess, setSnapGuess] = useState<Detection | null>(null);
    const [reading, setReading] = useState(false);
    const [flash, setFlash] = useState<number | null>(null);
    const [note, setNote] = useState('Starting the camera…');
    const [scanned, setScanned] = useState<number[]>([]);
    const autoOpenedRef = useRef(false);

    // Prefer live video from the front camera; fall back to one photo per card
    // when this browser cannot grant camera video. iPhone/iPad go straight to
    // photo-per-card: WebKit always refuses camera video in this frame.
    useEffect(() => {
        let cancelled = false;
        const toSnap = () => {
            if (cancelled) return;
            setMode('snap');
            setNote(isIOSWebKit
                ? 'The camera opens for one card at a time. Point it at a card; a clear read turns green and lands in your hand.'
                : 'Live video could not start in this browser (camera permission may be off), so the camera opens for one card at a time.');
        };
        if (isIOSWebKit) { toSnap(); return; }
        const md = navigator.mediaDevices;
        if (!md || typeof md.getUserMedia !== 'function') { toSnap(); return; }
        md.getUserMedia({ audio: false, video: { facingMode: 'user' } })
            .then((stream) => {
                if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
                streamRef.current = stream;
                setMode('live');
                setNote('Hold one card up to the camera so its corner rank and suit are clearly visible.');
            })
            .catch(() => toSnap());
        return () => {
            cancelled = true;
            if (timerRef.current !== null) window.clearTimeout(timerRef.current);
            if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
        };
    }, []);

    // The video element mounts when live mode begins, so the stream attaches
    // here once it exists, not in the getUserMedia callback.
    useEffect(() => {
        if (mode === 'live' && videoRef.current && streamRef.current) {
            videoRef.current.srcObject = streamRef.current;
            videoRef.current.play().catch(() => undefined);
        }
    }, [mode]);

    // On iPhone/iPad, open the camera on the very tap that opened the scanner
    // (a layout effect still counts as that tap), so there is no extra panel
    // step before the first card. Later cards need one tap each: iOS only
    // opens the camera from a real tap.
    useLayoutEffect(() => {
        if (isIOSWebKit && mode === 'snap' && !autoOpenedRef.current && handCount < cardsPer) {
            autoOpenedRef.current = true;
            if (snapInputRef.current) snapInputRef.current.click();
        }
    }, [mode]);

    const accept = (id: number, auto: boolean) => {
        const outcome = onLockRef.current(id);
        if (outcome === 'added') {
            setScanned((s) => [...s, id]);
            setFlash(id);
            if (mode === 'live') window.setTimeout(() => setFlash((f) => (f === id ? null : f)), 900);
            setNote(auto ? `${cardLabel(id)} read clearly and added to your hand.` : `${cardLabel(id)} added to your hand.`);
        } else if (outcome === 'duplicate') {
            setNote(`${cardLabel(id)} is already in your hand. Show a different card.`);
        } else {
            setNote(`Your hand already has ${cardsPer} cards. Remove one below to scan another.`);
        }
    };

    // Live mode: the on-device reader looks at a frame, then looks again. A card
    // is added on its own only after the same card is read clearly in two checks
    // in a row (a check takes roughly a second or two). Every read also shows
    // as a chip you can tap to add yourself.
    useEffect(() => {
        if (mode !== 'live') return;
        let stopped = false;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const pending = new Map<number, number>();
        const locked = new Set<number>();
        const loop = async () => {
            setNote('Loading the card reader. The first load can take a few seconds…');
            try { await loadReader(); } catch {
                if (!stopped) setNote('The card reader could not load on this device. Use the photo reader or tap your cards in below.');
                return;
            }
            if (stopped) return;
            setNote('Hold your cards up so each corner rank and suit is clearly visible. One card or several both work.');
            while (!stopped) {
                const v = videoRef.current;
                if (v && ctx && v.readyState >= 2 && v.videoWidth > 0) {
                    const sc = Math.min(1, 960 / v.videoWidth);
                    const w = Math.max(1, Math.round(v.videoWidth * sc));
                    const h = Math.max(1, Math.round(v.videoHeight * sc));
                    canvas.width = w;
                    canvas.height = h;
                    ctx.drawImage(v, 0, 0, w, h);
                    let dets: Detection[] = [];
                    try { dets = (await readCards(canvas, w, h)) as unknown as Detection[]; } catch { dets = []; }
                    if (stopped) break;
                    setGuess(dets.length ? dets[0] : null);
                    const clear = new Set<number>(dets.filter((d) => !d.unsure).map((d) => cardId(d.suit, d.rankIdx)));
                    pending.forEach((_, id) => { if (!clear.has(id)) pending.delete(id); });
                    locked.forEach((id) => { if (!clear.has(id)) locked.delete(id); });
                    clear.forEach((id) => {
                        if (locked.has(id)) return;
                        const c = (pending.get(id) || 0) + 1;
                        pending.set(id, c);
                        if (c >= 2) { pending.delete(id); locked.add(id); lastLockRef.current = id; accept(id, true); }
                    });
                }
                await new Promise((r) => setTimeout(r, 60));
            }
        };
        loop();
        return () => { stopped = true; };
    }, [mode]);

    // Snap mode: one photo per card, read at a size that keeps it quick. Some
    // front cameras deliver a mirrored photo, so an unreadable snap is tried
    // once more flipped before giving up.
    const readSnap = (img: HTMLImageElement): Detection[] => {
        const maxDim = 900;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const x = c.getContext('2d', { willReadFrequently: true });
        if (!x) return [];
        x.drawImage(img, 0, 0, w, h);
        let det: Detection[] = [];
        try {
            det = recognizePhoto(c as unknown as HTMLImageElement, 1);
        } catch {
            det = [];
        }
        if (det.length) return det;
        x.save();
        x.clearRect(0, 0, w, h);
        x.translate(w, 0);
        x.scale(-1, 1);
        x.drawImage(img, 0, 0, w, h);
        x.restore();
        try {
            det = recognizePhoto(c as unknown as HTMLImageElement, 1);
        } catch {
            det = [];
        }
        return det;
    };

    const onSnap = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!f) return;
        setReading(true);
        setSnapGuess(null);
        setFlash(null);
        setNote('Reading the card…');
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result !== 'string') { setReading(false); setNote('That photo could not be opened. Try again.'); return; }
            const src = reader.result;
            const img = new Image();
            img.onload = () => {
                // Recognition blocks the page briefly. Wait two frames so
                // "Reading the card" paints before it starts.
                requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
                    const det = readSnap(img);
                    setReading(false);
                    const best = det.length ? det[0] : null;
                    if (best && !best.unsure) {
                        setSnapGuess(null); // a confident read adds itself; no manual chip needed
                        accept(cardId(best.suit, best.rankIdx), true);
                    } else if (best) {
                        setSnapGuess(best);
                        setNote(`Read as ${RANK_LABELS[best.rankIdx]}${SUITS[best.suit].symbol}, but not clearly enough to add on its own. Retake it, or add it yourself below.`);
                    } else {
                        setNote('No card could be read. Hold one card steady with its corner rank and suit well lit and in focus, then try again.');
                    }
                }, 30)));
            };
            img.onerror = () => { setReading(false); setNote('That photo could not be opened. Try again.'); };
            img.src = src;
        };
        reader.readAsDataURL(f);
    };

    const complete = handCount >= cardsPer;

    return <div className="prophecy-scanpanel">
        <div className="prophecy-scanhead">
            <span className="prophecy-scantitle">Card scanner</span>
            <FileButton variant="ghost" compact onClick={onClose}>Close</FileButton>
        </div>
        <input ref={snapInputRef} type="file" accept="image/*" capture="user" className="prophecy-fileinput" onChange={onSnap} />
        {mode !== 'snap' && (
            <div className="prophecy-scanview">
                <video ref={videoRef} className="prophecy-scanvideo" playsInline muted autoPlay />
                {mode === 'starting' && <div className="prophecy-scanoverlay">Starting the camera…</div>}
                {flash !== null && <div className="prophecy-scanflash">✓ {cardLabel(flash)}</div>}
            </div>
        )}
        {mode === 'snap' && flash !== null && (
            <div className="prophecy-scandone">✓ {cardLabel(flash)} read clearly and added to your hand.</div>
        )}
        <p className="prophecy-scannote" role="status">{note}</p>
        {mode === 'live' && guess && !complete && (
            <div className="prophecy-detectrow">
                <button
                    type="button"
                    className="prophecy-detectchip"
                    data-red={guess.red || undefined}
                    data-unsure={guess.unsure || undefined}
                    onClick={() => { lastLockRef.current = cardId(guess.suit, guess.rankIdx); accept(cardId(guess.suit, guess.rankIdx), false); }}
                >
                    Add {RANK_LABELS[guess.rankIdx]}{SUITS[guess.suit].symbol}{guess.unsure ? ' ?' : ''} to my hand
                </button>
            </div>
        )}
        {mode === 'snap' && !complete && (
            <div className="prophecy-handphoto-actions">
                <FileButton variant="primary" disabled={reading} onClick={() => { setFlash(null); if (snapInputRef.current) snapInputRef.current.click(); }}>
                    {reading ? 'Reading the card…' : scanned.length ? 'Scan the next card' : 'Open the camera and scan a card'}
                </FileButton>
            </div>
        )}
        {mode === 'snap' && snapGuess && !complete && !reading && (
            <div className="prophecy-detectrow">
                <button
                    type="button"
                    className="prophecy-detectchip"
                    data-red={snapGuess.red || undefined}
                    data-unsure={snapGuess.unsure || undefined}
                    onClick={() => accept(cardId(snapGuess.suit, snapGuess.rankIdx), false)}
                >
                    Add {RANK_LABELS[snapGuess.rankIdx]}{SUITS[snapGuess.suit].symbol}{snapGuess.unsure ? ' ?' : ''} to my hand
                </button>
            </div>
        )}
        {scanned.length > 0 && (
            <div className="prophecy-scanchips" aria-label="Cards scanned in this session">
                {scanned.map((id, i) => (
                    <span key={i} className="prophecy-scanchip" data-red={isRedCard(id) || undefined}>✓ {cardLabel(id)}</span>
                ))}
            </div>
        )}
        {complete && (
            <>
                <div className="prophecy-scandone">All {cardsPer} cards are in your hand.</div>
                <div className="prophecy-handphoto-actions">
                    <FileButton variant="primary" compact onClick={onReview}>Done — review my hand</FileButton>
                </div>
            </>
        )}
        <Caption>{mode === 'live'
            ? 'Hold your cards steady with each corner rank and suit in view, one card or several. A card is added on its own only when it is read clearly in two checks in a row, and a check takes about a second or two. Even a clear read can be the wrong card, so check the scanned list against your hand and fix anything by tapping cards below. The video is read right here on this device and never uploaded.'
            : 'The camera opens for one card at a time. A card turns green and lands in your hand only when it is read clearly; otherwise retake it or add it yourself with the chip above. Photos are read right here on this device and never uploaded. The reader is experimental and can still misread a card, so check the scanned list against your hand and fix anything by tapping cards below.'}</Caption>
    </div>;
}

function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    return <div className="prophecy-disclosure">
        <button type="button" className="prophecy-disclosure-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <span>{label}</span>
            <span className="prophecy-chevron" data-open={open || undefined}>›</span>
        </button>
        {open && <div className="prophecy-disclosure-body">{children}</div>}
    </div>;
}

export function App() {
    const [setup, setSetup, saved] = useLocalState('prophecy-setup.v1', { players: 4, seat: 1 });
    const players = Math.min(7, Math.max(3, setup.players || 4));
    const seat = Math.min(players, Math.max(1, setup.seat || 1));
    const [game, setGame, gameSaved] = useLocalState<GameLedger>('prophecy-game.v1', { rounds: {} });
    const [round, setRound] = useState(1);
    const [hand, setHand] = useState<number[]>([]);
    const [oppCalls, setOppCalls] = useState<(number | null)[]>([null, null, null, null, null, null]);
    const [result, setResult] = useState<Result | null>(null);
    const [leads, setLeads] = useState<LeadResult | null>(null);
    const [running, setRunning] = useState(false);
    const [photos, setPhotos] = useState<{ src: string; det: Detection[]; sel: boolean[]; reading: boolean }[]>([]);
    const [actualCall, setActualCall] = useState<number | null>(null);
    const [actualGot, setActualGot] = useState<number | null>(null);
    const [scanOpen, setScanOpen] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);

    // Adds one scanned card to the hand; the scanner uses the outcome to say
    // what happened instead of assuming every read landed.
    const addScannedCard = (id: number): 'added' | 'duplicate' | 'full' => {
        if (hand.includes(id)) return 'duplicate';
        if (hand.length >= cardsPer) return 'full';
        resetResult();
        setHand((h) => (h.includes(id) || h.length >= cardsPer ? h : [...h, id]));
        return 'added';
    };

    const roundRef = useRef<HTMLDivElement>(null);
    const playersRef = useRef<HTMLDivElement>(null);
    const positionRef = useRef<HTMLDivElement>(null);
    const handRef = useRef<HTMLDivElement>(null);
    const callsRef = useRef<HTMLDivElement>(null);
    const oppRowRefs = useRef<(HTMLDivElement | null)[]>([]);
    const simRef = useRef<HTMLDivElement>(null);
    const resultRef = useRef<HTMLDivElement>(null);

    const scrollTo = (ref: React.RefObject<HTMLDivElement | null>) => {
        const el = ref.current;
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const info = ROUNDS[round - 1];
    const cardsPer = info.cards;
    const ready = hand.length === cardsPer && !running && result === null;

    // Score ledger for the current game, kept on this device. One entry per
    // round, so correcting a round replaces its points instead of adding again.
    const roundsPlayed = game.rounds || {};
    const gameTotal = Object.values(roundsPlayed).reduce((a, e) => a + (e.got === e.called ? 10 + e.called : 0), 0);

    const resetResult = () => { setResult(null); setLeads(null); };

    const toggleCard = (c: number) => {
        resetResult();
        const completing = !hand.includes(c) && hand.length + 1 === cardsPer;
        setHand((h) => {
            if (h.includes(c)) return h.filter((x) => x !== c);
            if (h.length >= cardsPer) return h;
            return [...h, c];
        });
        if (completing) scrollTo(callsRef);
    };

    const onPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files ? Array.from(e.target.files) : [];
        files.forEach((f) => {
            const reader = new FileReader();
            reader.onload = () => {
                if (typeof reader.result !== 'string') return;
                const src = reader.result;
                setPhotos((prev) => [...prev, { src, det: [], sel: [], reading: true }]);
                const img = new Image();
                img.onload = () => {
                    // Recognition blocks the page for several seconds. Wait two
                    // frames first so "Reading the cards" is painted before it starts.
                    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(async () => {
                        let det: Detection[] = [];
                        try {
                            det = (await readCards(img, img.naturalWidth || img.width, img.naturalHeight || img.height, 12)) as unknown as Detection[];
                        } catch {
                            det = [];
                        }
                        if (!det.length) {
                            try { det = recognizePhoto(img, cardsPer); } catch { det = []; }
                        }
                        // Confident reads start selected; reads marked ? start unselected.
                        const sel = det.map((d) => !d.unsure);
                        setPhotos((prev) => prev.map((p) => (p.src === src ? { src, det, sel, reading: false } : p)));
                    }, 30)));
                };
                img.src = src;
            };
            reader.readAsDataURL(f);
        });
        e.target.value = '';
    };

    const run = () => {
        setRunning(true);
        setTimeout(() => {
            const next = evaluateCalls(hand, players, seat, info.trump, oppCalls, null, SIMS_PER_CALL);
            setResult(next);
            // Position 1 calls first and leads the first trick, so also score
            // every card in hand as the opening lead against the recommended call.
            setLeads(seat === 1 ? evaluateLeads(hand, players, seat, info.trump, oppCalls, null, next.rec.k, LEAD_WORLDS) : null);
            setRunning(false);
        }, 40);
    };

    useEffect(() => {
        if (!result) return;
        const entry = (game.rounds || {})[round];
        setActualCall(entry ? entry.called : result.rec.k);
        setActualGot(entry ? entry.got : null);
        // Land exactly on the prediction; once more after the layout settles.
        scrollTo(resultRef);
        const t = setTimeout(() => scrollTo(resultRef), 450);
        return () => clearTimeout(t);
    }, [result]);

    const saveOutcome = (called: number | null, got: number | null) => {
        setActualCall(called);
        setActualGot(got);
        if (called === null || got === null || !gameSaved.ready) return;
        setGame({ rounds: { ...(game.rounds || {}), [round]: { called, got } } });
    };

    const nextRound = round === 7 ? 1 : round + 1;
    const nextInfo = ROUNDS[nextRound - 1];
    const nextSeat = seat === 1 ? players : seat - 1;

    const goNextRound = () => {
        if (round === 7 && gameSaved.ready) setGame({ rounds: {} }); // a new game resets the score
        setRound(nextRound);
        if (saved.ready) setSetup({ players, seat: nextSeat });
        setHand([]);
        setPhotos([]);
        setScanOpen(false);
        setOppCalls([null, null, null, null, null, null]);
        setActualCall(null);
        setActualGot(null);
        setResult(null);
        setTimeout(() => scrollTo(handRef), 60);
        setTimeout(() => scrollTo(handRef), 500);
    };

    const maxPct = result ? Math.max(...result.stats.map((s) => s.pct)) : 1;
    const leadStats = leads ? leads.stats.slice().sort((a, b) => b.pct - a.pct) : [];
    const maxLeadPct = leads ? Math.max(...leads.stats.map((s) => s.pct)) : 1;

    return <FileCard>
        <Header
            title="Prophecy trick predictor"
            fact="Exact call scores 10 + tricks"
            intro="Enter the round, your hand and the table setup. Simulated rounds score every legal call under your exact-hit scoring and recommend the whole-number call with the best expected points. When you call first, it also suggests the card to lead. Scan cards with the camera, read them from photos, or tap them in."
        />
        <Group label="Setup" heading="1. The round">
            <div ref={roundRef} className="prophecy-scrolltarget">
                <ChoiceRow
                    label="Round"
                    options={ROUNDS.map((r) => ({ value: String(r.round), label: String(r.round) }))}
                    value={String(round)}
                    onChange={(v) => { setRound(Number(v)); setHand([]); setPhotos([]); setScanOpen(false); resetResult(); scrollTo(playersRef); }}
                />
            </div>
            <Facts items={[
                { label: 'Cards each', value: String(cardsPer) },
                { label: 'Trump', value: `${SUITS[info.trump].symbol} ${SUITS[info.trump].name}` },
            ]} />
            <div ref={playersRef} className="prophecy-scrolltarget">
                <ChoiceRow
                    label="Players at the table"
                    options={[3, 4, 5, 6, 7].map((n) => ({ value: String(n), label: String(n) }))}
                    value={String(players)}
                    onChange={(v) => {
                        if (saved.ready) {
                            setSetup({ players: Number(v), seat: Math.min(seat, Number(v)) });
                            resetResult();
                            scrollTo(positionRef);
                        }
                    }}
                />
            </div>
            <div ref={positionRef} className="prophecy-scrolltarget">
                <ChoiceRow
                    label="Your position in the play order"
                    options={Array.from({ length: players }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
                    value={String(seat)}
                    onChange={(v) => { if (saved.ready) { setSetup({ players, seat: Number(v) }); resetResult(); scrollTo(handRef); } }}
                />
            </div>
            <Caption>Position 1 leads the first trick. Leading sets the suit everyone must follow, so only the led suit or trump can take that trick. {saved.message}</Caption>
        </Group>

        <Group label={`${hand.length} of ${cardsPer} picked`} heading="2. Your hand">
            <div ref={handRef} className="prophecy-scrolltarget prophecy-handanchor" />
            <Text>
                <Paragraph>Scan your cards one at a time with the camera, add photos of your hand and the experimental reader picks out cards for you to confirm, or tap the cards yourself. Cards in the trump suit ({SUITS[info.trump].symbol}) are outlined.</Paragraph>
            </Text>
            <input ref={fileInput} type="file" accept="image/*" capture="environment" multiple className="prophecy-fileinput" onChange={onPhoto} />
            <div className="prophecy-handbuttons">
                <FileButton variant="secondary" onClick={() => setScanOpen(true)}>Scan cards with the camera</FileButton>
                <FileButton variant="secondary" onClick={() => fileInput.current && fileInput.current.click()}>
                    {photos.length ? 'Add another photo' : 'Add photos of your cards'}
                </FileButton>
            </div>
            {scanOpen && (
                <CameraScanner
                    cardsPer={cardsPer}
                    handCount={hand.length}
                    onLock={addScannedCard}
                    onClose={() => setScanOpen(false)}
                    onReview={() => { setScanOpen(false); scrollTo(callsRef); }}
                />
            )}
            {photos.length > 0 && (
                <div className="prophecy-photostrip">
                    {photos.map((p, i) => (
                        <div key={i} className="prophecy-handphoto">
                            <img src={p.src} alt={`Photo ${i + 1} of your hand`} />
                            {p.reading && <Caption>Reading the cards in this photo. This can take several seconds and the page may pause while it works.</Caption>}
                            {!p.reading && p.det.length > 0 && (
                                <>
                                <div className="prophecy-detectrow">
                                    {p.det.map((d, j) => (
                                        <button type="button" key={j} aria-pressed={!!p.sel[j]}
                                            aria-label={`${RANK_LABELS[d.rankIdx]} of ${SUITS[d.suit].name}${d.unsure ? ', unsure read' : ''}, ${p.sel[j] ? 'selected' : 'not selected'}`}
                                            className="prophecy-detectchip" data-red={d.red || undefined} data-unsure={d.unsure || undefined} data-off={!p.sel[j] || undefined}
                                            onClick={() => setPhotos((prev) => prev.map((q, k) => (k === i ? { ...q, sel: q.sel.map((v, m) => (m === j ? !v : v)) } : q)))}>
                                            {p.sel[j] ? '\u2713 ' : ''}{RANK_LABELS[d.rankIdx]}{SUITS[d.suit].symbol}{d.unsure ? ' ?' : ''}
                                        </button>
                                    ))}
                                </div>
                                <Caption>Tap a card to include or leave it out. Cards marked ? start left out. Check every card against your hand, not only the ones marked ?.</Caption>
                                <div className="prophecy-handphoto-actions">
                                    <FileButton variant="secondary" compact disabled={!p.sel.some(Boolean)} onClick={() => {
                                        resetResult();
                                        setHand((h) => {
                                            const next = [...h];
                                            p.det.forEach((d, j) => {
                                                if (!p.sel[j]) return;
                                                const id = cardId(d.suit, d.rankIdx);
                                                if (!next.includes(id) && next.length < cardsPer) next.push(id);
                                            });
                                            return next;
                                        });
                                    }}>{p.sel.some(Boolean) ? `Add ${p.sel.filter(Boolean).length} selected card${p.sel.filter(Boolean).length === 1 ? '' : 's'} to my hand` : 'Select a card to add'}</FileButton>
                                </div>
                                </>
                            )}
                            {!p.reading && p.det.length === 0 && (
                                <Caption>No cards could be read in this photo. Hold the cards upright with each corner rank and suit visible and in focus, then try again, or tap the cards in below.</Caption>
                            )}
                            <div className="prophecy-handphoto-actions">
                                <FileButton variant="ghost" compact onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}>Remove</FileButton>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            <Caption>Add as many photos as you need; photos and camera video stay on this device and are read right here, never uploaded. The reader is experimental and can miss or misread cards: detected cards show under each photo, with a ? when the read is unsure, and the camera scan adds a card on its own only when the same card is read clearly twice in a row. Check them against your cards, add the ones that look right, and fix anything by tapping below.</Caption>
            {SUITS.map((suit, si) => (
                <div key={suit.name} className="prophecy-suitblock">
                    <div className="prophecy-suitlabel">
                        {suit.symbol} {suit.name}
                        {si === info.trump ? <span className="prophecy-trumptag">trump</span> : null}
                    </div>
                    <div className="prophecy-cardgrid">
                        {RANK_LABELS.map((label, ri) => {
                            const id = cardId(si, ri);
                            const selected = hand.includes(id);
                            const disabled = !selected && hand.length >= cardsPer;
                            return (
                                <button
                                    key={label}
                                    type="button"
                                    className="prophecy-card"
                                    data-selected={selected || undefined}
                                    data-trump={si === info.trump || undefined}
                                    disabled={disabled}
                                    onClick={() => toggleCard(id)}
                                    aria-pressed={selected}
                                >
                                    <span className="prophecy-rank">{label}</span>
                                    <span className="prophecy-pip">{suit.symbol}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            ))}
        </Group>

        <Group label="Optional" heading="3. Other players' calls">
            <div ref={callsRef} className="prophecy-scrolltarget" />
            <Text>
                <Paragraph>Enter the calls announced before yours, and leave Unknown for players who have not called yet. The simulator deals each known caller a hand weighted toward their call, and an opponent calling 0 also plays to lose. Unknown callers get fully random hands.</Paragraph>
            </Text>
            <Caption>Calls entered: {oppCalls.slice(0, players - 1).filter((c) => c !== null).length} of {players - 1} opponents.</Caption>
            {Array.from({ length: players - 1 }, (_, i) => (
                <div key={`${players}-${i}-${cardsPer}`} ref={(el) => { oppRowRefs.current[i] = el; }} className="prophecy-scrolltarget">
                    <ChoiceRow
                        label={`${oppLabel(i)} called`}
                        options={[{ value: '-1', label: 'Unknown' }, ...Array.from({ length: cardsPer + 1 }, (__, k) => ({ value: String(k), label: String(k) }))]}
                        value={oppCalls[i] === null ? '-1' : String(oppCalls[i])}
                        onChange={(v) => {
                            resetResult();
                            setOppCalls((prev) => {
                                const next = prev.slice();
                                next[i] = v === '-1' ? null : Number(v);
                                return next;
                            });
                            if (i + 1 < players - 1) scrollTo({ current: oppRowRefs.current[i + 1] });
                            else scrollTo(simRef);
                        }}
                    />
                </div>
            ))}
        </Group>

        <Group label="Simulation">
            <div ref={simRef} className="prophecy-scrolltarget" />
            <FileButton variant="primary" disabled={!ready} onClick={run}>
                {running ? 'Simulating…' : 'Recommend my call'}
            </FileButton>
            {hand.length !== cardsPer && <Caption>Pick exactly {cardsPer} cards to run it ({hand.length} picked).</Caption>}
            {result && (
                <div className="prophecy-results" ref={resultRef}>
                    <KeySentence>Call {result.rec.k}.</KeySentence>
                    {leads && (
                        <KeySentence>Lead <span data-red={isRedCard(leads.rec.card) || undefined} className="prophecy-leadcard">{cardLabel(leads.rec.card)}</span>.</KeySentence>
                    )}
                    <Facts items={[
                        { label: 'Predicted tricks', value: result.predictedTricks.toFixed(1) },
                        { label: 'Recommended call', value: `${result.rec.k} (whole number)` },
                        { label: 'Confidence (modeled chance to hit)', value: `${result.rec.pct.toFixed(1)}%` },
                        { label: 'A hit pays', value: `${10 + result.rec.k} points` },
                        { label: 'Expected points', value: result.rec.exp.toFixed(1) },
                        { label: 'Most likely result', value: `${result.mode.k} tricks (${result.mode.pct.toFixed(0)}%)` },
                    ]} />
                    {result.mode.k !== result.rec.k && (
                        <Caption>
                            Predicted tricks is the decimal average. Your call must be a whole number, and {result.mode.k} tricks is the single most likely result, but calling {result.rec.k} scores more on average because a hit pays 10 + the call.
                        </Caption>
                    )}
                    {leads && (
                        <>
                        <div className="prophecy-dist">
                            {leadStats.map((s) => (
                                <div key={s.card} className="prophecy-distrow">
                                    <span className="prophecy-distlabel" data-red={isRedCard(s.card) || undefined}>{cardLabel(s.card)}</span>
                                    <span className="prophecy-disttrack">
                                        <span
                                            className="prophecy-distbar"
                                            data-rec={s.card === leads.rec.card || undefined}
                                            style={{ width: `${Math.max(s.pct > 0 ? 2 : 0, (s.pct / maxLeadPct) * 100)}%` }}
                                        />
                                    </span>
                                    <span className="prophecy-distval">{s.pct.toFixed(1)}%</span>
                                </div>
                            ))}
                        </div>
                        <Caption>You call first this round, so you lead the first trick. Each card in your hand was played as the opening lead through the same {leads.simsPerCard.toLocaleString()} simulated rounds, with you playing to hit your recommended call of {leads.targetK} exactly. The suggested lead hit the call most often; percentages are modeled estimates, not guarantees.</Caption>
                        </>
                    )}
                    <div className="prophecy-dist">
                        {result.stats.map((s) => (
                            <div key={s.k} className="prophecy-distrow">
                                <span className="prophecy-distlabel">Call {s.k}</span>
                                <span className="prophecy-disttrack">
                                    <span
                                        className="prophecy-distbar"
                                        data-rec={s.k === result.rec.k || undefined}
                                        style={{ width: `${Math.max(s.pct > 0 ? 2 : 0, (s.pct / maxPct) * 100)}%` }}
                                    />
                                </span>
                                <span className="prophecy-distval">{s.pct.toFixed(1)}% · {s.exp.toFixed(1)} pts</span>
                            </div>
                        ))}
                    </div>
                    <Caption>{((cardsPer + 1) * result.simsPerCall).toLocaleString()} simulated rounds, {result.simsPerCall.toLocaleString()} per call, each played as if you were trying to hit that call exactly. Bars are scaled to the most confident call; percentages are the real modeled chances.</Caption>
                </div>
            )}
        </Group>

        {result && (
            <Group label="Score" heading="4. How many did you get?">
                <Caption>Your score uses the call you actually announced at the table, which can differ from the recommendation. It starts at the recommended call; change it if you called something else.</Caption>
                <ChoiceRow
                    label="Your call"
                    options={Array.from({ length: cardsPer + 1 }, (_, k) => ({ value: String(k), label: String(k) }))}
                    value={actualCall === null ? '' : String(actualCall)}
                    onChange={(v) => saveOutcome(Number(v), actualGot)}
                />
                <ChoiceRow
                    label="Tricks you took"
                    options={Array.from({ length: cardsPer + 1 }, (_, k) => ({ value: String(k), label: String(k) }))}
                    value={actualGot === null ? '' : String(actualGot)}
                    onChange={(v) => saveOutcome(actualCall, Number(v))}
                />
                {actualCall !== null && actualGot !== null && (
                    actualGot === actualCall
                        ? <div className="prophecy-outcomebox" data-hit>Hit it exactly — +{10 + actualCall} points.</div>
                        : <div className="prophecy-outcomebox" data-miss>Missed — 0 points this round. You called {actualCall} and took {actualGot}.</div>
                )}
                <Facts items={[
                    { label: 'Game total', value: `${gameTotal} points` },
                    { label: 'Rounds scored', value: `${Object.keys(roundsPlayed).length} of 7` },
                ]} />
                <Caption>The total saves on this device and adds up every round of this game. Fixing a round above updates its points instead of counting it twice. Starting a new game after Round 7 resets it. {gameSaved.message}</Caption>
            </Group>
        )}

        {result && round < 7 && (
            <Group label="Keep going" heading="5. Next round">
                <Caption>Round {nextRound} · {nextInfo.cards} card{nextInfo.cards === 1 ? '' : 's'} each · trump {SUITS[nextInfo.trump].symbol} {SUITS[nextInfo.trump].name} · you move from {ORDINALS[seat - 1]} to {ORDINALS[nextSeat - 1]} in the play order · players stay at {players}.</Caption>
                <FileButton variant="primary" onClick={goNextRound}>Start round {nextRound}</FileButton>
            </Group>
        )}

        {result && round === 7 && (
            <Group label="Game over" heading="5. New game">
                <Caption>The game ends after Round 7. {Object.keys(roundsPlayed).length ? `Your total this game: ${gameTotal} points. ` : ''}A new game starts at Round 1 with {nextInfo.cards} cards each, your position in the play order moves from {ORDINALS[seat - 1]} to {ORDINALS[nextSeat - 1]}, and the score resets.</Caption>
                <FileButton variant="primary" onClick={goNextRound}>Start a new game</FileButton>
            </Group>
        )}

        <Photos label="Prophecy" items={[{ src: cardsArt, alt: 'Illustration of a fan of playing cards with suit symbols and a question mark card' }]} />
        <Caption>Illustration.</Caption>

        <Disclosure label="How the simulator works and what it assumes">
            <Text>
                <Paragraph>Each possible call is simulated separately, with you playing to hit exactly that call: you chase tricks while below it and shed them once you reach it. Opponents do the same against their entered call, or against a target matched to their dealt hand when their call is unknown.</Paragraph>
                <Paragraph>Tricks are played in order from the leader, everyone must follow the suit led when they can, and only the led suit or a trump can win a trick. Leading first is a real edge in the simulation because the leader picks the suit, but no fixed bonus is added: the cards and legal play decide each trick.</Paragraph>
                <Paragraph>The camera scan and the photo reader run entirely on this device: video frames and photos never leave it. The camera scan adds a card by itself only when the same card is read clearly in two consecutive looks; it can still misread a card, so every scanned card stays checkable and correctable with the card grid above.</Paragraph>
                <Paragraph>When you are in position 1, the page also suggests an opening lead: every card in your hand is tried as the first card of the round across the same simulated deals, with you playing to hit the recommended call exactly, and the card that hits the call most often is suggested. It serves the call, not trick-count alone, so on a low call it can be a throwaway card rather than your highest.</Paragraph>
                <Paragraph>Opponents you know nothing about get random deals from the cards you cannot see. An opponent with an entered call is dealt a hand weighted toward that call, on the assumption that players call sensibly and honestly, which is not guaranteed; an opponent calling 0 plays to lose from the start.</Paragraph>
                <Paragraph>Players use one fixed sensible style, not perfect play, and opponent skill, table talk and bluffing are not modeled. The confidence percentage is the share of simulated rounds where you hit the call exactly; it is a modeled estimate, not calibrated real-world certainty or a guarantee.</Paragraph>
            </Text>
        </Disclosure>

        <Disclosure label="The complete rulebook, 7-round version">
        <Group label="Reference">
            <Text>
                <Heading sub="The goal">1. Objective</Heading>
                <Paragraph>Prophecy is a trick-taking card game where players predict how many tricks they will win each round.</Paragraph>
                <Paragraph>The objective is to finish all seven rounds with the highest total score.</Paragraph>
                <Paragraph>Players must predict exactly how many tricks they will win. Correct predictions earn points, while incorrect predictions earn zero.</Paragraph>
            </Text>
            <Text>
                <Heading sub="What you need">2. Players and equipment</Heading>
                <Bullets items={[
                    '3–7 players recommended.',
                    'One standard 52-card deck.',
                    'No jokers.',
                    'Paper or a phone to keep score.',
                ]} />
            </Text>
            <Text>
                <Heading sub="Seven rounds, cards going down">3. Round progression</Heading>
                <Bullets items={ROUNDS.map((r) => `Round ${r.round}: ${r.cards} card${r.cards === 1 ? '' : 's'} per player`)} />
                <Paragraph>The game stops after Round 7. There is no second half where the cards increase again.</Paragraph>
            </Text>
            <Text>
                <Heading sub="Clubs, diamonds, spades, hearts, repeat">4. Trump suit order</Heading>
                <Bullets items={ROUNDS.map((r) => `Round ${r.round}: ${SUITS[r.trump].name.toUpperCase()} (${SUITS[r.trump].symbol}) – ${r.cards} card${r.cards === 1 ? '' : 's'}`)} />
                <Paragraph>Trump rotation: CLUBS → DIAMONDS → SPADES → HEARTS → CLUBS → DIAMONDS → SPADES</Paragraph>
                <Paragraph>Trump is the suit that beats every other suit. If clubs are trump, 2♣ beats A♥, 5♣ beats K♦, and A♣ beats every non-trump card. If multiple trump cards are played, the highest trump card wins.</Paragraph>
            </Text>
            <Text>
                <Heading sub="Ace high, two low">5. Card rankings</Heading>
                <Paragraph>Cards rank from highest to lowest: Ace, King, Queen, Jack, 10, 9, 8, 7, 6, 5, 4, 3, 2.</Paragraph>
                <Paragraph>Aces are always the highest cards and 2s are always the lowest cards within their suit.</Paragraph>
            </Text>
            <Text>
                <Heading sub="Same number for everyone">6. Dealing</Heading>
                <NumberedList items={[
                    'Shuffle the deck.',
                    'Deal the required number of cards to every player.',
                    'Make sure everyone receives the same number of cards.',
                    'Use the trump suit assigned to that round.',
                    'Begin calling.',
                ]} />
                <Paragraph>Example: in Round 1, every player receives seven cards.</Paragraph>
            </Text>
            <Text>
                <Heading sub="Before any card is played">7. Calling your tricks</Heading>
                <Paragraph>Before any cards are played, each player must predict how many tricks they believe they will win. With five cards, a player can call 0, 1, 2, 3, 4 or 5 tricks. Every player must announce a prediction before the first trick begins. Players are allowed to call zero if they believe they will not win any tricks.</Paragraph>
                <NumberedList items={[
                    'The first player calls.',
                    'The remaining players call in order.',
                    'Everyone must have called before playing begins.',
                ]} />
            </Text>
            <Text>
                <Heading sub="Follow suit if you can">8. Playing the cards</Heading>
                <Paragraph>A trick consists of every player playing one card.</Paragraph>
                <NumberedList items={[
                    'The first player leads by playing any card.',
                    'Everyone else must follow the suit that was led if they have it.',
                    'If a player does not have that suit, they can play any card, including trump.',
                    'The highest card in the suit led wins unless trump is played.',
                    'If trump is played, the highest trump card wins.',
                    'The winner collects the trick.',
                    'The winner leads the next trick.',
                ]} />
                <Paragraph>Important: you cannot play a different suit if you have a card matching the suit that was led.</Paragraph>
                <Paragraph>Example: trump is clubs. Player 1 plays A♥, Player 2 plays K♥, Player 3 plays 2♣, Player 4 plays Q♥. Player 3 wins because clubs are trump, even though the Ace of hearts was played.</Paragraph>
            </Text>
            <Text>
                <Heading sub="10 points plus your call, or nothing">9. Scoring system</Heading>
                <Paragraph>Correct prediction: 10 points + the number of tricks called. Incorrect prediction: 0 points.</Paragraph>
                <Bullets items={[
                    'Called 0, won 0 = 10 points',
                    'Called 1, won 1 = 11 points',
                    'Called 2, won 2 = 12 points',
                    'Called 3, won 3 = 13 points',
                    'Called 4, won 4 = 14 points',
                    'Called 5, won 5 = 15 points',
                ]} />
                <Paragraph>Incorrect predictions: called 2, won 1 = 0 points. Called 2, won 3 = 0 points. Called 0, won 1 = 0 points. Called 4, won 2 = 0 points. There are no partial points for being close.</Paragraph>
            </Text>
            <Text>
                <Heading sub="Highest total after Round 7">10. Winning the game</Heading>
                <NumberedList items={[
                    'Finish the final trick.',
                    "Calculate everyone's points for Round 7.",
                    'Add all seven rounds together.',
                    "Compare everyone's total scores.",
                ]} />
                <Paragraph>The player with the highest cumulative score wins Prophecy.</Paragraph>
            </Text>
            <Text>
                <Heading sub="From the rulebook">11. Strategy tips</Heading>
                <Bullets items={[
                    'Count your high cards. Aces and kings can help predict how many tricks you will win.',
                    'Watch the trump suit. Having several trump cards can make a big difference.',
                    'Remember played cards. Knowing which high cards are gone helps you make better decisions.',
                    'Be careful calling zero. Even one accidental trick means zero points.',
                    "Don't overestimate your hand. A strong-looking hand doesn't guarantee that you will win every trick.",
                    'Pay attention to other players. Their calls can help you understand how they expect the round to go.',
                ]} />
            </Text>
            <Text>
                <Heading sub="At a glance">12. Quick reference</Heading>
                <Bullets items={[
                    'Starting cards: 7 · Ending cards: 1 · Total rounds: 7',
                    'Trump order: ♣ ♦ ♠ ♥ ♣ ♦ ♠',
                    'Highest card: Ace · Lowest card: 2',
                    'Calling: predict tricks before playing',
                    'Following suit: required if possible',
                    'Trump beats other suits',
                    'Correct prediction: 10 + number called · Incorrect prediction: 0 points',
                    'Winner: highest total score',
                ]} />
            </Text>
            <Text>
                <Heading sub="Hit your exact prediction">13. Final rule</Heading>
                <Paragraph>Call your tricks, play your cards, and hit your exact prediction. Correct calls earn 10 points plus the amount called. Wrong calls earn zero points.</Paragraph>
            </Text>
        </Group>
        </Disclosure>

        <Closing>Rulebook as you supplied it on 21 Nov. Recommendations are simulation estimates, not guarantees.</Closing>
    </FileCard>;
}
