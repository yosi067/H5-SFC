/**
 * Project 16-bit: SFC Emulator
 * Enhancement Chip Plugin System
 * 
 * This module provides the plugin architecture for SNES enhancement chips
 * (SA-1, DSP-1, SuperFX, etc.) with automatic detection from ROM headers.
 */

// ============================================================================
// Chip Type Enumeration
// ============================================================================

export enum ChipType {
  NONE = 0x00,
  DSP1 = 0x01,
  DSP2 = 0x02,
  DSP3 = 0x03,
  DSP4 = 0x04,
  SUPERFX = 0x10,
  SUPERFX2 = 0x11,
  SA1 = 0x20,
  SDD1 = 0x30,
  OBC1 = 0x40,
  CX4 = 0x50,
  ST010 = 0x60,
  ST011 = 0x61,
  ST018 = 0x62,
  SPC7110 = 0x70,
  S_RTC = 0x80,
}

// ============================================================================
// Chip State Interface (for Save States)
// ============================================================================

export interface ChipState {
  type: ChipType;
  data: Uint8Array;
  registers: Record<string, number>;
}

// ============================================================================
// Enhancement Chip Interface
// ============================================================================

export interface EnhancementChip {
  /** Chip identifier */
  readonly name: string;
  readonly type: ChipType;
  
  /**
   * Initialize the chip with ROM and SRAM data
   */
  init(rom: Uint8Array, sram: Uint8Array): void;
  
  /**
   * Reset the chip to initial state
   */
  reset(): void;
  
  /**
   * Check if this chip handles the given memory address
   */
  handles(bank: number, address: number): boolean;
  
  /**
   * Read from chip memory/registers
   */
  read(bank: number, address: number): number;
  
  /**
   * Write to chip memory/registers
   */
  write(bank: number, address: number, value: number): void;
  
  /**
   * Execute chip cycles (for chips with their own CPU like SA-1)
   */
  step(masterCycles: number): void;
  
  /**
   * Save chip state for save states
   */
  saveState(): ChipState;
  
  /**
   * Load chip state from save state
   */
  loadState(state: ChipState): void;
}

// ============================================================================
// ROM Header Parsing
// ============================================================================

export interface ROMHeader {
  title: string;
  mapMode: string;  // 'LoROM', 'HiROM', 'ExHiROM'
  mapModeRaw: number;  // Raw map mode byte
  chipType: ChipType;
  enhancementChip: string | null;  // 'SA-1', 'DSP-1', etc. or null
  romSize: number;
  sramSize: number;
  region: number;
  version: number;
  checksumComplement: number;
  checksum: number;
  isLoROM: boolean;
  isHiROM: boolean;
  isFastROM: boolean;
}

/**
 * Detect ROM mapping and header location
 */
export function detectHeaderLocation(rom: Uint8Array): number {
  // Try HiROM location first ($FFB0)
  const hiromScore = scoreHeader(rom, 0xFFB0);
  // Try LoROM location ($7FB0)
  const loromScore = scoreHeader(rom, 0x7FB0);
  // Try ExHiROM location ($40FFB0)
  const exhiromScore = rom.length > 0x410000 ? scoreHeader(rom, 0x40FFB0) : 0;
  
  if (exhiromScore > hiromScore && exhiromScore > loromScore) {
    return 0x40FFB0;
  }
  return hiromScore >= loromScore ? 0xFFB0 : 0x7FB0;
}

function scoreHeader(rom: Uint8Array, offset: number): number {
  if (offset + 0x50 >= rom.length) return 0;
  
  let score = 0;
  const headerStart = offset;
  
  // Check for valid map mode byte at $FFD5
  const mapMode = rom[headerStart + 0x25];
  if ((mapMode & 0x0F) <= 0x03) score += 2;
  
  // Additional check: mode byte should not be 0 for valid header
  if (mapMode !== 0) score += 2;
  
  // Check for valid ROM size byte at $FFD7
  const romSize = rom[headerStart + 0x27];
  if (romSize >= 0x08 && romSize <= 0x0D) score += 1;
  
  // Check for valid SRAM size byte at $FFD8
  const sramSize = rom[headerStart + 0x28];
  if (sramSize <= 0x08) score += 1;
  
  // Check for valid region byte at $FFD9
  const region = rom[headerStart + 0x29];
  if (region <= 0x14) score += 1;
  
  // Checksum validation
  const checksum = (rom[headerStart + 0x2F] << 8) | rom[headerStart + 0x2E];
  const complement = (rom[headerStart + 0x2D] << 8) | rom[headerStart + 0x2C];
  if ((checksum ^ complement) === 0xFFFF) score += 4;
  
  // Title check (should be ASCII printable)
  for (let i = 0; i < 21; i++) {
    const c = rom[headerStart + i];
    if (c >= 0x20 && c <= 0x7E) score += 0.1;
  }
  
  return score;
}

/**
 * Parse ROM header and detect enhancement chips
 */
export function parseROMHeader(rom: Uint8Array): ROMHeader {
  const headerOffset = detectHeaderLocation(rom);
  const isHiROM = headerOffset >= 0xFF00;
  const isLoROM = headerOffset < 0x8000;
  
  // Title is at headerOffset + 0x10 (title block starts 16 bytes after scoring header)
  const titleOffset = headerOffset + 0x10;
  const titleBytes = rom.slice(titleOffset, titleOffset + 21);
  // Filter out null bytes and non-printable characters, then convert to string
  const filteredBytes = Array.from(titleBytes).filter(b => b >= 0x20 && b <= 0x7E);
  const title = String.fromCharCode(...filteredBytes).trim();
  
  const mapModeRaw = rom[headerOffset + 0x25];
  const romType = rom[headerOffset + 0x26];
  const romSize = 1024 << rom[headerOffset + 0x27];
  const sramSize = rom[headerOffset + 0x28] ? (1024 << rom[headerOffset + 0x28]) : 0;
  const region = rom[headerOffset + 0x29];
  const version = rom[headerOffset + 0x2B];
  const checksumComplement = (rom[headerOffset + 0x2D] << 8) | rom[headerOffset + 0x2C];
  const checksum = (rom[headerOffset + 0x2F] << 8) | rom[headerOffset + 0x2E];
  
  // Detect enhancement chip from ROM type byte
  const chipType = detectChipType(mapModeRaw, romType);
  
  // Convert chip type to string name
  const enhancementChip = chipTypeToName(chipType);
  
  // Determine map mode string
  const mapMode = isHiROM ? 'HiROM' : 'LoROM';
  
  return {
    title,
    mapMode,
    mapModeRaw,
    chipType,
    enhancementChip,
    romSize,
    sramSize,
    region,
    version,
    checksumComplement,
    checksum,
    isLoROM,
    isHiROM,
    isFastROM: (mapModeRaw & 0x10) !== 0,
  };
}

/**
 * Convert ChipType enum to string name
 */
function chipTypeToName(chipType: ChipType): string | null {
  switch (chipType) {
    case ChipType.SA1: return 'SA-1';
    case ChipType.DSP1: return 'DSP-1';
    case ChipType.DSP2: return 'DSP-2';
    case ChipType.DSP3: return 'DSP-3';
    case ChipType.DSP4: return 'DSP-4';
    case ChipType.SUPERFX: return 'SuperFX';
    case ChipType.SUPERFX2: return 'SuperFX2';
    case ChipType.OBC1: return 'OBC1';
    case ChipType.SDD1: return 'S-DD1';
    case ChipType.SPC7110: return 'SPC7110';
    case ChipType.CX4: return 'Cx4';
    case ChipType.NONE:
    default: return null;
  }
}

/**
 * Detect enhancement chip type from ROM header bytes
 */
function detectChipType(mapMode: number, romType: number): ChipType {
  // Special handling based on map mode
  const mode = mapMode & 0x0F;
  
  // SA-1 detection (map mode $23)
  if (mode === 0x03 && (mapMode & 0x20)) {
    return ChipType.SA1;
  }
  
  // SuperFX detection (map mode $13/$14)
  if (mode === 0x03 && (mapMode & 0x10)) {
    return ChipType.SUPERFX;
  }
  
  // Check full romType byte for special chips first
  switch (romType) {
    case 0x33:
    case 0x34:
    case 0x35: return ChipType.SA1;     // SA-1
    case 0x43: return ChipType.SDD1;    // S-DD1
    case 0x45: return ChipType.SPC7110; // SPC7110
  }
  
  // ROM type byte chip detection (lower nibble for DSP variants)
  const coprocessor = romType & 0x0F;
  
  switch (coprocessor) {
    case 0x03: return ChipType.DSP1;    // DSP-1
    case 0x04: return ChipType.DSP2;    // DSP-2  
    case 0x05: return ChipType.DSP3;    // DSP-3/DSP-4
    case 0x14: return ChipType.SUPERFX; // SuperFX
    case 0x15: return ChipType.SUPERFX2;// SuperFX2
    case 0x25: return ChipType.OBC1;    // OBC1
    case 0xF3: return ChipType.CX4;     // Cx4
    default: return ChipType.NONE;
  }
}

// ============================================================================
// Chip Registry & Factory
// ============================================================================

type ChipConstructor = new () => EnhancementChip;

export class ChipRegistry {
  private static instance: ChipRegistry | null = null;
  private chips: Map<ChipType, ChipConstructor> = new Map();
  private chipNames: Map<string, ChipType> = new Map();
  
  private constructor() {}
  
  /**
   * Get the singleton instance
   */
  static getInstance(): ChipRegistry {
    if (!ChipRegistry.instance) {
      ChipRegistry.instance = new ChipRegistry();
    }
    return ChipRegistry.instance;
  }
  
  /**
   * Register a chip implementation
   */
  register(type: ChipType, constructor: ChipConstructor): void {
    this.chips.set(type, constructor);
    const chip = new constructor();
    this.chipNames.set(chip.name, type);
  }
  
  /**
   * Create a chip instance by type
   */
  create(type: ChipType): EnhancementChip | null {
    const Constructor = this.chips.get(type);
    if (!Constructor) {
      console.warn(`No implementation for chip type: ${ChipType[type]}`);
      return null;
    }
    return new Constructor();
  }
  
  /**
   * Create a chip by name (for testing)
   */
  createChip(name: string): EnhancementChip | null {
    const type = this.chipNames.get(name);
    if (type === undefined) {
      return null;
    }
    return this.create(type);
  }
  
  /**
   * Check if a chip type is supported
   */
  isSupported(type: ChipType): boolean {
    return this.chips.has(type);
  }
  
  /**
   * Check if a chip name is registered
   */
  hasChip(name: string): boolean {
    return this.chipNames.has(name);
  }
  
  /**
   * Get list of supported chips
   */
  getSupportedChips(): ChipType[] {
    return Array.from(this.chips.keys());
  }
}

// Global chip registry (backward compatibility)
export const chipRegistry = ChipRegistry.getInstance();

// ============================================================================
// Chip Manager
// ============================================================================

export class ChipManager {
  private activeChip: EnhancementChip | null = null;
  private rom: Uint8Array = new Uint8Array(0);
  private sram: Uint8Array = new Uint8Array(0);
  private header: ROMHeader | null = null;
  
  /**
   * Load ROM and auto-detect enhancement chip
   */
  loadROM(rom: Uint8Array, sram?: Uint8Array): void {
    this.rom = rom;
    this.sram = sram || new Uint8Array(0);
    this.header = parseROMHeader(rom);
    
    console.log(`ROM: "${this.header.title}"`);
    console.log(`Mapping: ${this.header.isHiROM ? 'HiROM' : 'LoROM'}${this.header.isFastROM ? ' FastROM' : ''}`);
    console.log(`ROM Size: ${this.header.romSize / 1024}KB`);
    console.log(`SRAM Size: ${this.header.sramSize / 1024}KB`);
    
    // Auto-detect and initialize chip
    if (this.header.chipType !== ChipType.NONE) {
      console.log(`Enhancement Chip: ${ChipType[this.header.chipType]}`);
      this.activeChip = chipRegistry.create(this.header.chipType);
      
      if (this.activeChip) {
        this.activeChip.init(this.rom, this.sram);
        console.log(`${this.activeChip.name} initialized`);
      } else {
        console.warn(`Chip ${ChipType[this.header.chipType]} not implemented`);
      }
    }
  }
  
  /**
   * Get current ROM header info
   */
  getHeader(): ROMHeader | null {
    return this.header;
  }
  
  /**
   * Get the active enhancement chip
   */
  getActiveChip(): EnhancementChip | null {
    return this.activeChip;
  }

  /**
   * Check if a specific chip is active by name
   */
  hasChip(name: string): boolean {
    if (!this.activeChip) return false;
    // Check by chipId property if available, otherwise by type or name
    const chipId = (this.activeChip as any).chipId;
    return chipId === name || this.activeChip.name === name || ChipType[this.activeChip.type] === name;
  }
  
  /**
   * Check if chip handles this address
   */
  chipHandles(bank: number, address: number): boolean {
    return this.activeChip?.handles(bank, address) ?? false;
  }
  
  /**
   * Read through chip
   */
  read(bank: number, address: number): number {
    return this.activeChip?.read(bank, address) ?? 0;
  }
  
  /**
   * Write through chip
   */
  write(bank: number, address: number, value: number): void {
    this.activeChip?.write(bank, address, value);
  }
  
  /**
   * Step chip execution
   */
  step(cycles: number): void {
    this.activeChip?.step(cycles);
  }
  
  /**
   * Reset chip
   */
  reset(): void {
    this.activeChip?.reset();
  }
  
  /**
   * Save chip state
   */
  saveState(): Record<string, ChipState> {
    const states: Record<string, ChipState> = {};
    if (this.activeChip) {
      // Use chip name as key (e.g., 'SA-1', 'DSP-1')
      const chipName = chipTypeToName(this.activeChip.type) || 'unknown';
      states[chipName] = this.activeChip.saveState();
    }
    return states;
  }
  
  /**
   * Load chip state
   */
  loadState(states: Record<string, ChipState>): void {
    if (this.activeChip) {
      const chipName = chipTypeToName(this.activeChip.type) || 'unknown';
      const state = states[chipName];
      if (state && state.type === this.activeChip.type) {
        this.activeChip.loadState(state);
      }
    }
  }
}
