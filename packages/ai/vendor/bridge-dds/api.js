var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _Dds_instances, _Dds_pointerToDdTableResults, _Dds_ddTableResultsToPointer, _Dds_dealPbnToPointer, _Dds_playPbnToPointer, _Dds_ddTableDealPbnToPointer, _Dds_pointerToParResultsDealer, _Dds_pointerToSolvedPlay, _Dds_pointerToFutureTricks;
import DdsLoader from "./dds.js";
export const loadDds = () => DdsLoader();
export class Dds {
    constructor(module) {
        _Dds_instances.add(this);
        this.module = module;
        this.module.ccall("SetMaxThreads", null, ["number"], [0]);
    }
    CalcDDTablePBN(ddTableDealPbn) {
        const ddTableDealPbnPtr = this.module._malloc(ddTableDealPbnSize);
        const ddTableResultsPtr = this.module._malloc(ddTableResultsSize);
        try {
            __classPrivateFieldGet(this, _Dds_instances, "m", _Dds_ddTableDealPbnToPointer).call(this, ddTableDealPbn, ddTableDealPbnPtr);
            const result = this.module.ccall("CalcDDtablePBN", "number", ["number", "number"], [ddTableDealPbnPtr, ddTableResultsPtr]);
            if (result != 1) {
                throw new DdsError(result);
            }
            return __classPrivateFieldGet(this, _Dds_instances, "m", _Dds_pointerToDdTableResults).call(this, ddTableResultsPtr);
        }
        finally {
            this.module._free(ddTableDealPbnPtr);
            this.module._free(ddTableResultsPtr);
        }
    }
    DealerPar(ddTableResults, dealer, vulnerable) {
        const ddTableResultsPtr = this.module._malloc(ddTableResultsSize);
        const parResultsDealerPtr = this.module._malloc(parResultsDealerSize);
        try {
            __classPrivateFieldGet(this, _Dds_instances, "m", _Dds_ddTableResultsToPointer).call(this, ddTableResults, ddTableResultsPtr);
            const result = this.module.ccall("DealerPar", "number", ["number", "number", "number", "number"], [ddTableResultsPtr, parResultsDealerPtr, dealer, vulnerable]);
            if (result != 1) {
                throw new DdsError(result);
            }
            return __classPrivateFieldGet(this, _Dds_instances, "m", _Dds_pointerToParResultsDealer).call(this, parResultsDealerPtr);
        }
        finally {
            this.module._free(ddTableResultsPtr);
            this.module._free(parResultsDealerPtr);
        }
    }
    SolveBoardPBN(dealPbn, target, solutions, mode) {
        const dealPbnPtr = this.module._malloc(dealPbnSize);
        const futureTricksPtr = this.module._malloc(futureTricksSize);
        try {
            __classPrivateFieldGet(this, _Dds_instances, "m", _Dds_dealPbnToPointer).call(this, dealPbn, dealPbnPtr);
            const result = this.module.ccall("SolveBoardPBN", "number", ["number", "number", "number", "number", "number", "number"], [dealPbnPtr, target, solutions, mode, futureTricksPtr, 0]);
            if (result != 1) {
                throw new DdsError(result);
            }
            return __classPrivateFieldGet(this, _Dds_instances, "m", _Dds_pointerToFutureTricks).call(this, futureTricksPtr);
        }
        finally {
            this.module._free(dealPbnPtr);
            this.module._free(futureTricksPtr);
        }
    }
    AnalysePlayPBN(dealPbn, playTracePbn) {
        const dealPbnPtr = this.module._malloc(dealPbnSize);
        const playPbnPtr = this.module._malloc(playTracePbnSize);
        const solvedPlayPtr = this.module._malloc(solvedPlaySize);
        try {
            __classPrivateFieldGet(this, _Dds_instances, "m", _Dds_dealPbnToPointer).call(this, dealPbn, dealPbnPtr);
            __classPrivateFieldGet(this, _Dds_instances, "m", _Dds_playPbnToPointer).call(this, playTracePbn, playPbnPtr);
            const result = this.module.ccall("AnalysePlayPBN", "number", ["number", "number", "number", "number"], [dealPbnPtr, playPbnPtr, solvedPlayPtr, 0]);
            if (result != 1) {
                throw new DdsError(result);
            }
            return __classPrivateFieldGet(this, _Dds_instances, "m", _Dds_pointerToSolvedPlay).call(this, solvedPlayPtr);
        }
        finally {
            this.module._free(dealPbnPtr);
            this.module._free(playPbnPtr);
            this.module._free(solvedPlayPtr);
        }
    }
}
_Dds_instances = new WeakSet(), _Dds_pointerToDdTableResults = function _Dds_pointerToDdTableResults(ddTableResultsPtr) {
    const ddTableResults = {
        resTable: [...Array(ddsNumStrains).keys()].map((strain) => [...Array(ddsNumSeats).keys()].map((hand) => this.module.getValue(ddTableResultsPtr +
            ddTableResultsResTableOffset +
            sizeOfIntArray(strain * ddsNumSeats + hand), "i32"))),
    };
    return ddTableResults;
}, _Dds_ddTableResultsToPointer = function _Dds_ddTableResultsToPointer(ddTableResults, ddTableResultsPtr) {
    [...Array(ddsNumStrains).keys()].forEach((strain) => [...Array(ddsNumSeats).keys()].forEach((hand) => {
        this.module.setValue(ddTableResultsPtr +
            ddTableResultsResTableOffset +
            sizeOfIntArray(strain * ddsNumSeats + hand), ddTableResults.resTable[strain][hand], "i32");
    }));
}, _Dds_dealPbnToPointer = function _Dds_dealPbnToPointer(dealPbn, dealPbnPtr) {
    this.module.setValue(dealPbnPtr + dealPbnTrumpOffset, dealPbn.trump, "i32");
    this.module.setValue(dealPbnPtr + dealPbnFirstOffset, dealPbn.first, "i32");
    for (let i = 0; i < 3; i++) {
        this.module.setValue(dealPbnPtr + dealPbnCurrentTrickSuitOffset + sizeOfInt * i, dealPbn.currentTrickSuit[i] || 0, "i32");
        this.module.setValue(dealPbnPtr + dealPbnCurrentTrickRankOffset + sizeOfInt * i, dealPbn.currentTrickRank[i] || 0, "i32");
    }
    this.module.stringToUTF8(dealPbn.remainCards, dealPbnPtr + dealPbnRemainCardsOffset, 80);
}, _Dds_playPbnToPointer = function _Dds_playPbnToPointer(playTracePbn, playPbnPtr) {
    this.module.setValue(playPbnPtr + playTracePbnNumberOffset, playTracePbn.cards.length / 2, "i32");
    this.module.stringToUTF8(playTracePbn.cards, playPbnPtr + playTracePbnCardsOffset, 106);
}, _Dds_ddTableDealPbnToPointer = function _Dds_ddTableDealPbnToPointer(ddTableDealPbn, ddTableDealPbnPtr) {
    this.module.stringToUTF8(ddTableDealPbn.cards, ddTableDealPbnPtr + ddTableDealPbnCardsOffset, 80);
}, _Dds_pointerToParResultsDealer = function _Dds_pointerToParResultsDealer(parResultsDealerPtr) {
    const number = this.module.getValue(parResultsDealerPtr + parResultsDealerNumberOffset, "i32");
    const parResultsDealer = {
        score: this.module.getValue(parResultsDealerPtr + parResultsDealerScoreOffset, "i32"),
        contracts: [],
    };
    for (let i = 0; i < number; i++) {
        parResultsDealer.contracts.push(this.module.UTF8ToString(parResultsDealerPtr + parResultsDealerContractsOffset + i * 10, 10));
    }
    return parResultsDealer;
}, _Dds_pointerToSolvedPlay = function _Dds_pointerToSolvedPlay(solvedPlayPtr) {
    const number = this.module.getValue(solvedPlayPtr + solvedPlayNumberOffset, "i32");
    const solvedPlay = { tricks: [] };
    for (let i = 0; i < number; i++) {
        solvedPlay.tricks.push(this.module.getValue(solvedPlayPtr + solvedPlayTricksOffset + sizeOfInt * i, "i32"));
    }
    return solvedPlay;
}, _Dds_pointerToFutureTricks = function _Dds_pointerToFutureTricks(futureTricksPtr) {
    const futureTricks = {
        nodes: this.module.getValue(futureTricksPtr + futureTricksNodesOffset, "i32"),
        cards: this.module.getValue(futureTricksPtr + futureTricksCardsOffset, "i32"),
        suit: [],
        rank: [],
        equals: [],
        score: [],
    };
    for (let i = 0; i < futureTricks.cards; i++) {
        futureTricks.suit.push(this.module.getValue(futureTricksPtr + futureTricksSuitOffset + sizeOfInt * i, "i32"));
        futureTricks.rank.push(this.module.getValue(futureTricksPtr + futureTricksRankOffset + sizeOfInt * i, "i32"));
        futureTricks.equals.push(this.module.getValue(futureTricksPtr + futureTricksEqualsOffset + sizeOfInt * i, "i32"));
        futureTricks.score.push(this.module.getValue(futureTricksPtr + futureTricksScoreOffset + sizeOfInt * i, "i32"));
    }
    return futureTricks;
};
export class DdsError extends Error {
    constructor(code) {
        super("DDS API error: " + code);
    }
}
export const Trump = {
    Spades: 0,
    Hearts: 1,
    Diamonds: 2,
    Clubs: 3,
    NoTrump: 4,
};
export const Direction = {
    North: 0,
    East: 1,
    South: 2,
    West: 3,
};
export const Vulnerable = {
    None: 0,
    Both: 1,
    NorthSouth: 2,
    EastWest: 3,
};
const sizeOfInt = 4;
const sizeOfIntArray = (len) => len * sizeOfInt;
/*
struct dealPBN
{
  int trump;
  int first;
  int currentTrickSuit[3];
  int currentTrickRank[3];
  char remainCards[80];
};
*/
const dealPbnTrumpOffset = 0;
const dealPbnFirstOffset = dealPbnTrumpOffset + sizeOfInt;
const dealPbnCurrentTrickSuitOffset = dealPbnFirstOffset + sizeOfInt;
const dealPbnCurrentTrickRankOffset = dealPbnCurrentTrickSuitOffset + sizeOfIntArray(3);
const dealPbnRemainCardsOffset = dealPbnCurrentTrickRankOffset + sizeOfIntArray(3);
const dealPbnSize = dealPbnRemainCardsOffset + 80;
/*
struct futureTricks
{
  int nodes;
  int cards;
  int suit[13];
  int rank[13];
  int equals[13];
  int score[13];
};
*/
const futureTricksNodesOffset = 0;
const futureTricksCardsOffset = futureTricksNodesOffset + sizeOfInt;
const futureTricksSuitOffset = futureTricksCardsOffset + sizeOfInt;
const futureTricksRankOffset = futureTricksSuitOffset + sizeOfIntArray(13);
const futureTricksEqualsOffset = futureTricksRankOffset + sizeOfIntArray(13);
const futureTricksScoreOffset = futureTricksEqualsOffset + sizeOfIntArray(13);
const futureTricksSize = futureTricksScoreOffset + sizeOfIntArray(13);
/*
struct playTracePBN
{
  int number;
  char cards[106];
};
*/
const playTracePbnNumberOffset = 0;
const playTracePbnCardsOffset = playTracePbnNumberOffset + sizeOfInt;
const playTracePbnSize = playTracePbnCardsOffset + 106;
/*
struct solvedPlay
{
  int number;
  int tricks[53];
};
*/
const solvedPlayNumberOffset = 0;
const solvedPlayTricksOffset = solvedPlayNumberOffset + sizeOfInt;
const solvedPlaySize = solvedPlayTricksOffset + sizeOfIntArray(53);
/*
struct ddTableDealPBN
{
  char cards[80];
};
*/
const ddTableDealPbnCardsOffset = 0;
const ddTableDealPbnSize = ddTableDealPbnCardsOffset + 80;
/*
struct ddTableResults
{
  int resTable[DDS_STRAINS][DDS_HANDS];
};
*/
const ddTableResultsResTableOffset = 0;
const ddTableResultsSize = ddTableResultsResTableOffset + sizeOfIntArray(5 * 4);
const ddsNumStrains = 5;
const ddsNumSeats = 4;
/*
struct parResultsDealer
{
  int number;
  int score;
  char contracts[10][10];
};
*/
const parResultsDealerNumberOffset = 0;
const parResultsDealerScoreOffset = parResultsDealerNumberOffset + sizeOfInt;
const parResultsDealerContractsOffset = parResultsDealerScoreOffset + sizeOfInt;
const parResultsDealerSize = parResultsDealerContractsOffset + 10 * 10;
