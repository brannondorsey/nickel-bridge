import { DdsModule } from "./dds.js";
export type { DdsModule } from "./dds.js";
export declare const loadDds: () => Promise<DdsModule>;
export declare class Dds {
    #private;
    private module;
    constructor(module: DdsModule);
    CalcDDTablePBN(ddTableDealPbn: DdTableDealPbn): DdTableResults;
    DealerPar(ddTableResults: DdTableResults, dealer: number, vulnerable: number): ParResultsDealer;
    SolveBoardPBN(dealPbn: DealPbn, target: number, solutions: number, mode: number): FutureTricks;
    AnalysePlayPBN(dealPbn: DealPbn, playTracePbn: PlayTracePbn): SolvedPlay;
}
export declare class DdsError extends Error {
    constructor(code: number);
}
export interface DealPbn {
    trump: number;
    first: number;
    currentTrickSuit: number[];
    currentTrickRank: number[];
    remainCards: string;
}
export interface PlayTracePbn {
    cards: string;
}
export interface FutureTricks {
    nodes: number;
    cards: number;
    suit: number[];
    rank: number[];
    equals: number[];
    score: number[];
}
export interface SolvedPlay {
    tricks: number[];
}
export interface DdTableDealPbn {
    cards: string;
}
export interface DdTableResults {
    resTable: number[][];
}
export interface ParResultsDealer {
    score: number;
    contracts: string[];
}
export declare const Trump: {
    Spades: number;
    Hearts: number;
    Diamonds: number;
    Clubs: number;
    NoTrump: number;
};
export declare const Direction: {
    North: number;
    East: number;
    South: number;
    West: number;
};
export declare const Vulnerable: {
    None: number;
    Both: number;
    NorthSouth: number;
    EastWest: number;
};
