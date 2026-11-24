export interface Detection { rankIdx: number; suit: number; score: number; red: boolean; x: number; unsure: boolean }
export function recognizePhoto(img: HTMLImageElement, maxCards: number): Detection[];
