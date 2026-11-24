export interface CallStat { k: number; pct: number; exp: number; meanTricks: number }
export interface Result { stats: CallStat[]; rec: CallStat; mode: CallStat; predictedTricks: number; simsPerCall: number }
export interface LeadStat { card: number; pct: number; meanTricks: number }
export interface LeadResult { stats: LeadStat[]; rec: LeadStat; targetK: number; simsPerCard: number }
export function suitOf(c: number): number;
export function rankOf(c: number): number;
export function cardId(suit: number, rankIdx: number): number;
export function beats(a: number, b: number, trump: number): boolean;
export function pickCard(hand: number[], ledSuit: number, winCard: number, trump: number, mode: number): number;
export function estimateTricks(hand: number[], trump: number): number;
export function dealConditioned(deck: number[], cardsPer: number, target: number | null, trump: number, rng?: () => number): number[];
export function simulateCall(handCards: number[], players: number, seat: number, trump: number, oppCalls: (number | null)[], biases: number[], targetK: number, sims: number, forcedLead?: number): { hits: number; trickSum: number };
export function evaluateCalls(handCards: number[], players: number, seat: number, trump: number, oppCalls: (number | null)[], biases: number[], simsPerCall: number): Result;
export function evaluateLeads(handCards: number[], players: number, seat: number, trump: number, oppCalls: (number | null)[], biases: number[], targetK: number, simsPerCard: number): LeadResult;
export function seatForSlot(me: number, players: number, slot: number): number;
