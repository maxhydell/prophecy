// Pure simulation logic for the Prophecy predictor. Plain JS so it can be unit-tested in node.

const suitOf = (c) => Math.floor(c / 13);
const rankOf = (c) => (c % 13) + 2;
const cardId = (suit, rankIdx) => suit * 13 + rankIdx;

// A card wins a trick only if it is trump while the current winner is not,
// or it matches the current winner's suit with a higher rank. Any other
// off-suit non-trump card can never take the trick, per the rulebook.
function beats(a, b, trump) {
    const sa = suitOf(a);
    const sb = suitOf(b);
    if (sa === trump && sb !== trump) return true;
    if (sa === sb && rankOf(a) > rankOf(b)) return true;
    return false;
}

const minRank = (cards) => cards.reduce((a, b) => (rankOf(b) < rankOf(a) ? b : a));
const maxRank = (cards) => cards.reduce((a, b) => (rankOf(b) > rankOf(a) ? b : a));

// mode 0: play to win the trick cheaply. mode 1: duck, shed the highest safe card.
// Following suit is mandatory when possible (legal is narrowed first), which is
// what gives the leader their edge: only the suit led or trump can take the trick.
function pickCard(hand, ledSuit, winCard, trump, mode) {
    let legal = hand;
    if (ledSuit !== -1) {
        const follow = hand.filter((c) => suitOf(c) === ledSuit);
        if (follow.length) legal = follow;
    }
    if (mode === 0) {
        if (ledSuit === -1) return maxRank(legal);
        const winners = legal.filter((c) => beats(c, winCard, trump));
        return winners.length ? minRank(winners) : minRank(legal);
    }
    if (ledSuit === -1) return minRank(legal);
    const losers = legal.filter((c) => !beats(c, winCard, trump));
    return losers.length ? maxRank(losers) : minRank(legal);
}

// Fast static estimate of how many tricks a hand is worth. Used to deal
// opponents hands that match a known call, and to set a sensible target
// for opponents whose call is unknown. Not a playout.
function estimateTricks(hand, trump) {
    const suitCounts = [0, 0, 0, 0];
    for (const c of hand) suitCounts[suitOf(c)]++;
    let score = 0;
    for (const c of hand) {
        const s = suitOf(c);
        const r = rankOf(c);
        if (s === trump) {
            score += r >= 14 ? 1.0 : r === 13 ? 0.85 : r === 12 ? 0.65 : r === 11 ? 0.55 : 0.4;
        } else if (r === 14) {
            score += suitCounts[s] >= 3 ? 1.0 : suitCounts[s] === 2 ? 0.9 : 0.7;
        } else if (r === 13) {
            score += suitCounts[s] >= 3 ? 0.6 : suitCounts[s] === 2 ? 0.45 : 0.25;
        } else if (r === 12) {
            score += suitCounts[s] >= 4 ? 0.25 : 0.1;
        }
    }
    return score;
}

function sampleIndices(n, k, rng) {
    const idx = [];
    while (idx.length < k) {
        const i = Math.floor(rng() * n);
        if (!idx.includes(i)) idx.push(i);
    }
    return idx;
}

// Deal cardsPer cards from deck (mutates it). When target is a number, sample
// candidate hands and pick uniformly from those whose strength estimate lands
// within DEAL_TOLERANCE of the target, so a known call shapes the dealt hand
// without collapsing it onto one specific strongest match (the old argmin
// behavior dealt a near-perfect-match hand - often the ace of trump - to almost
// every caller). Falls back to the closest match when no candidate qualifies.
// The target may be fractional: learned opponent tendencies shift it away from
// their announced call.
const DEAL_TOLERANCE = 0.45;
function dealConditioned(deck, cardsPer, target, trump, rng) {
    rng = rng || Math.random;
    if (target === null || target === undefined) {
        return deck.splice(0, cardsPer);
    }
    const qualifying = [];
    let best = null;
    let bestDiff = Infinity;
    for (let attempt = 0; attempt < 120 && qualifying.length < 40; attempt++) {
        const idx = sampleIndices(deck.length, cardsPer, rng);
        const hand = idx.map((i) => deck[i]);
        const diff = Math.abs(estimateTricks(hand, trump) - target);
        if (diff <= DEAL_TOLERANCE) qualifying.push(idx);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = idx;
        }
    }
    const pick = qualifying.length ? qualifying[Math.floor(rng() * qualifying.length)] : best;
    pick.sort((a, b) => b - a);
    const hand = pick.map((i) => deck[i]);
    for (const i of pick) deck.splice(i, 1);
    return hand;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Opponent slot i is the (i+1)-th player to our left physically, so the mapping
// to absolute seats stays correct as our position in the play order rotates.
const seatForSlot = (me, players, slot) => (me + 1 + slot) % players;

// Deterministic RNG: the seed derives from every input that shapes the
// simulation, so re-running an unchanged hand re-deals the same worlds and the
// recommendation is stable instead of resampling on every tap.
function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const simRng = (handCards, players, seat, trump, oppCalls, biases) =>
    mulberry32(hashSeed(JSON.stringify([handCards, players, seat, trump, oppCalls, biases])));

// Deal one simulated world: shuffle the unseen cards and give every opponent a
// hand, conditioned on their announced call when it is known. Shared by the
// call simulation and the lead comparison so both see the same deal logic.
function dealWorld(handCards, players, me, cardsPer, trump, opps, rng) {
    const mine = new Set(handCards);
    const deck = [];
    for (let c = 0; c < 52; c++) if (!mine.has(c)) deck.push(c);
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    const hands = new Array(players);
    hands[me] = handCards.slice();
    for (const o of opps.filter((o) => o.call !== null && o.call !== undefined)) {
        hands[o.p] = dealConditioned(deck, cardsPer, clamp(o.call + o.bias, 0, cardsPer), trump, rng);
    }
    for (const o of opps) {
        if (!hands[o.p]) hands[o.p] = deck.splice(0, cardsPer);
    }
    return hands;
}

// Play a full round out from dealt hands (each mutated as cards are played).
// Each player chases tricks while below their target and sheds once they reach
// it. forcedLead, when given, makes our player open the round with that exact
// card (only possible when we lead the first trick); every later decision is
// normal. Returns the tricks won per player.
function playTricks(hands, targets, trump, me, forcedLead) {
    const players = hands.length;
    const cardsPer = hands[me].length;
    const wins = new Array(players).fill(0);
    let leader = 0;
    for (let t = 0; t < cardsPer; t++) {
        let ledSuit = -1;
        let winCard = -1;
        let winPlayer = -1;
        for (let o = 0; o < players; o++) {
            const p = (leader + o) % players;
            const h = hands[p];
            const mode = wins[p] < targets[p] ? 0 : 1;
            let card;
            if (t === 0 && p === me && forcedLead !== null && forcedLead !== undefined && h.includes(forcedLead)) {
                card = forcedLead;
            } else {
                card = pickCard(h, ledSuit, winCard, trump, mode);
            }
            h.splice(h.indexOf(card), 1);
            if (ledSuit === -1) { ledSuit = suitOf(card); winCard = card; winPlayer = p; }
            else if (beats(card, winCard, trump)) { winCard = card; winPlayer = p; }
        }
        wins[winPlayer]++;
        leader = winPlayer;
    }
    return wins;
}

// Simulate rounds where our player targets exactly targetK tricks: they play to
// win while below target and duck once they reach it. Opponents do the same
// against their known call, or against a strength-matched target when their
// call is unknown. biases[slot] shifts the hand a known caller is dealt (their
// observed tendency to take more or fewer tricks than they call); their play
// target stays their announced call. Returns exact-hit count and our total tricks.
// forcedLead, when given, makes our player open the round with that exact card
// (only possible when we lead the first trick); every later decision is normal.
function simulateCall(handCards, players, seat, trump, oppCalls, biases, targetK, sims, forcedLead) {
    const cardsPer = handCards.length;
    const me = seat - 1;
    const opps = [];
    for (let slot = 0; slot < players - 1; slot++) {
        opps.push({ p: seatForSlot(me, players, slot), call: oppCalls[slot], bias: biases ? biases[slot] || 0 : 0 });
    }
    let hits = 0;
    let trickSum = 0;
    const rng = simRng(handCards, players, seat, trump, oppCalls, biases);
    for (let s = 0; s < sims; s++) {
        const hands = dealWorld(handCards, players, me, cardsPer, trump, opps, rng);
        const targets = hands.map((h, p) => {
            if (p === me) return targetK;
            const o = opps.find((x) => x.p === p);
            if (o.call !== null && o.call !== undefined) return o.call;
            return clamp(Math.round(estimateTricks(h, trump)), 0, cardsPer);
        });
        const wins = playTricks(hands, targets, trump, me, forcedLead);
        trickSum += wins[me];
        if (wins[me] === targetK) hits++;
    }
    return { hits, trickSum };
}

// Score every legal call under exact-hit scoring: each call k is simulated with
// our player trying to hit exactly k, so the confidence for a call reflects
// actually playing for it.
function evaluateCalls(handCards, players, seat, trump, oppCalls, biases, simsPerCall) {
    const stats = [];
    for (let k = 0; k <= handCards.length; k++) {
        const { hits, trickSum } = simulateCall(handCards, players, seat, trump, oppCalls, biases, k, simsPerCall);
        stats.push({
            k,
            pct: (hits / simsPerCall) * 100,
            exp: ((10 + k) * hits) / simsPerCall,
            meanTricks: trickSum / simsPerCall,
        });
    }
    let rec = stats[0];
    for (const p of stats) {
        if (p.exp > rec.exp + 1e-9 || (Math.abs(p.exp - rec.exp) <= 1e-9 && p.pct > rec.pct)) rec = p;
    }
    const mode = stats.reduce((a, p) => (p.pct > a.pct ? p : a));
    return { stats, rec, mode, predictedTricks: rec.meanTricks, simsPerCall };
}

// Score every card in hand as the opening lead of the round, with our player
// still trying to hit exactly targetK. Only meaningful when we lead the first
// trick (position 1). Every candidate lead is played through the same dealt
// worlds, so the comparison reflects the cards, not dealing luck. The
// recommended lead is the card whose simulated rounds hit the target call most
// often; ties break toward the average trick count closest to the target.
function evaluateLeads(handCards, players, seat, trump, oppCalls, biases, targetK, worlds) {
    const cardsPer = handCards.length;
    const me = seat - 1;
    const opps = [];
    for (let slot = 0; slot < players - 1; slot++) {
        opps.push({ p: seatForSlot(me, players, slot), call: oppCalls[slot], bias: biases ? biases[slot] || 0 : 0 });
    }
    const hits = new Array(cardsPer).fill(0);
    const trickSums = new Array(cardsPer).fill(0);
    const rng = simRng(handCards, players, seat, trump, oppCalls, biases);
    for (let s = 0; s < worlds; s++) {
        const hands = dealWorld(handCards, players, me, cardsPer, trump, opps, rng);
        const targets = hands.map((h, p) => {
            if (p === me) return targetK;
            const o = opps.find((x) => x.p === p);
            if (o.call !== null && o.call !== undefined) return o.call;
            return clamp(Math.round(estimateTricks(h, trump)), 0, cardsPer);
        });
        for (let ci = 0; ci < cardsPer; ci++) {
            const copy = hands.map((h) => h.slice());
            const wins = playTricks(copy, targets, trump, me, handCards[ci]);
            trickSums[ci] += wins[me];
            if (wins[me] === targetK) hits[ci]++;
        }
    }
    const stats = handCards.map((card, ci) => ({
        card,
        pct: (hits[ci] / worlds) * 100,
        meanTricks: trickSums[ci] / worlds,
    }));
    let rec = stats[0];
    for (const s of stats) {
        if (s.pct > rec.pct + 1e-9
            || (Math.abs(s.pct - rec.pct) <= 1e-9 && Math.abs(s.meanTricks - targetK) < Math.abs(rec.meanTricks - targetK) - 1e-9)) {
            rec = s;
        }
    }
    return { stats, rec, targetK, simsPerCard: worlds };
}

export { suitOf, rankOf, cardId, beats, pickCard, estimateTricks, dealConditioned, simulateCall, evaluateCalls, evaluateLeads, seatForSlot };
