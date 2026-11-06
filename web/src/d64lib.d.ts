// The part of d64lib.js (it sets globalThis.D64) SIDKid uses
declare global {
  class D64 {
    static FILE_TYPE_PRG: number;
    static createEmpty(diskName?: string, diskId?: string): D64;
    writeFile(fileName: string, fileData: Uint8Array, fileType?: number): boolean;
    getData(): Uint8Array;
  }
}
export {};
