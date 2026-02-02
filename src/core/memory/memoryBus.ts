/**
 * Project 16-bit: SFC Emulator
 * Memory Bus Implementation
 * 
 * Handles SNES memory mapping with support for:
 * - LoROM and HiROM cartridge layouts
 * - Work RAM (WRAM) - 128KB
 * - Video RAM (VRAM) - 64KB
 * - OAM and CGRAM
 * - Enhancement chip integration
 */

import { MemorySpeed } from '../cpu/types';
import { ChipManager } from '../chips/chipManager';

// ============================================================================
// Memory Map Constants
// ============================================================================

const WRAM_SIZE = 0x20000;     // 128KB Work RAM
const VRAM_SIZE = 0x10000;     // 64KB Video RAM
const OAM_SIZE = 0x220;        // 544 bytes OAM
const CGRAM_SIZE = 0x200;      // 512 bytes Color RAM

// ============================================================================
// Memory Bus Interface
// ============================================================================

export interface MemoryBus {
  read(bank: number, address: number): number;
  write(bank: number, address: number, value: number): void;
  getAccessSpeed(bank: number, address: number): number;
}

// ============================================================================
// SNES Memory Bus Implementation
// ============================================================================

export class SNESMemoryBus implements MemoryBus {
  // Main RAM
  private wram: Uint8Array = new Uint8Array(WRAM_SIZE);
  
  // Video memory (managed by PPU, but accessible here)
  private vram: Uint8Array = new Uint8Array(VRAM_SIZE);
  private oam: Uint8Array = new Uint8Array(OAM_SIZE);
  private cgram: Uint8Array = new Uint8Array(CGRAM_SIZE);
  
  // Cartridge
  private rom: Uint8Array = new Uint8Array(0);
  private sram: Uint8Array = new Uint8Array(0);
  private isHiROM: boolean = false;
  private isFastROM: boolean = false;
  
  // Hardware registers
  private hwRegisters: Uint8Array = new Uint8Array(0x8000);
  
  // WRAM access registers
  private wramAddress: number = 0;
  
  // NMI/IRQ control (NMITIMEN $4200)
  private nmiEnabled: boolean = false;
  private hIRQEnabled: boolean = false;
  private vIRQEnabled: boolean = false;
  private autoJoypadRead: boolean = false;
  
  // Enhancement chip manager
  private chipManager: ChipManager | null = null;
  
  // PPU register callbacks
  private ppuRead: ((address: number) => number) | null = null;
  private ppuWrite: ((address: number, value: number) => void) | null = null;
  
  // PPU status callbacks for HVBJOY register
  private ppuGetVBlank: (() => boolean) | null = null;
  private ppuGetHBlank: (() => boolean) | null = null;
  
  // APU register callbacks
  private apuRead: ((address: number) => number) | null = null;
  private apuWrite: ((address: number, value: number) => void) | null = null;
  
  // Controller callbacks
  private controllerRead: ((port: number) => number) | null = null;
  
  // Open bus value (last value on data bus)
  private openBus: number = 0;
  
  // ============================================================================
  // Initialization
  // ============================================================================
  
  constructor() {
    this.reset();
  }
  
  reset(): void {
    this.wram.fill(0);
    this.vram.fill(0);
    this.oam.fill(0);
    this.cgram.fill(0);
    this.hwRegisters.fill(0);
    this.wramAddress = 0;
    this.openBus = 0;
  }
  
  /**
   * Load cartridge ROM
   */
  loadROM(rom: Uint8Array, isHiROM: boolean, isFastROM: boolean): void {
    this.rom = rom;
    this.isHiROM = isHiROM;
    this.isFastROM = isFastROM;
    
    // Initialize SRAM based on ROM header
    // Default to 8KB if not specified
    this.sram = new Uint8Array(0x2000);
  }
  
  /**
   * Set enhancement chip manager
   */
  setChipManager(manager: ChipManager): void {
    this.chipManager = manager;
  }
  
  /**
   * Register PPU callbacks
   */
  setPPUCallbacks(
    read: (address: number) => number,
    write: (address: number, value: number) => void,
    getVBlank?: () => boolean,
    getHBlank?: () => boolean
  ): void {
    this.ppuRead = read;
    this.ppuWrite = write;
    this.ppuGetVBlank = getVBlank || null;
    this.ppuGetHBlank = getHBlank || null;
  }
  
  /**
   * Register APU callbacks
   */
  setAPUCallbacks(
    read: (address: number) => number,
    write: (address: number, value: number) => void
  ): void {
    this.apuRead = read;
    this.apuWrite = write;
  }
  
  /**
   * Register controller callback
   */
  setControllerCallback(read: (port: number) => number): void {
    this.controllerRead = read;
  }
  
  // ============================================================================
  // Memory Access
  // ============================================================================
  
  read(bank: number, address: number): number {
    let value = this.openBus;
    
    // Check enhancement chip first
    if (this.chipManager?.chipHandles(bank, address)) {
      value = this.chipManager.read(bank, address);
      this.openBus = value;
      return value;
    }
    
    // Bank $00-$3F, $80-$BF (System area)
    if ((bank <= 0x3F) || (bank >= 0x80 && bank <= 0xBF)) {
      value = this.readSystemArea(bank, address);
    }
    // Bank $40-$7D (Cartridge - varies by mapping)
    else if (bank >= 0x40 && bank <= 0x7D) {
      value = this.readCartridge(bank, address);
    }
    // Bank $7E-$7F (WRAM)
    else if (bank === 0x7E || bank === 0x7F) {
      const wramAddr = ((bank - 0x7E) << 16) | address;
      value = this.wram[wramAddr];
    }
    // Bank $C0-$FF (ROM)
    else if (bank >= 0xC0) {
      value = this.readROM(bank, address);
    }
    
    this.openBus = value;
    return value;
  }
  
  write(bank: number, address: number, value: number): void {
    this.openBus = value;
    
    // Check enhancement chip first
    if (this.chipManager?.chipHandles(bank, address)) {
      this.chipManager.write(bank, address, value);
      return;
    }
    
    // Bank $00-$3F, $80-$BF (System area)
    if ((bank <= 0x3F) || (bank >= 0x80 && bank <= 0xBF)) {
      this.writeSystemArea(bank, address, value);
    }
    // Bank $40-$7D (Cartridge SRAM area)
    else if (bank >= 0x40 && bank <= 0x7D) {
      this.writeCartridge(bank, address, value);
    }
    // Bank $7E-$7F (WRAM)
    else if (bank === 0x7E || bank === 0x7F) {
      const wramAddr = ((bank - 0x7E) << 16) | address;
      this.wram[wramAddr] = value;
    }
    // ROM is read-only (writes ignored)
  }
  
  // ============================================================================
  // System Area ($0000-$7FFF in banks $00-$3F, $80-$BF)
  // ============================================================================
  
  private readSystemArea(bank: number, address: number): number {
    // $0000-$1FFF: LowRAM (mirror of WRAM $7E0000-$7E1FFF)
    if (address < 0x2000) {
      return this.wram[address];
    }
    
    // $2140-$2143: APU I/O ports (before PPU registers check)
    if (address >= 0x2140 && address <= 0x2143) {
      return this.apuRead?.(address - 0x2140) ?? 0;
    }
    
    // $2100-$21FF: PPU registers
    if (address >= 0x2100 && address <= 0x21FF) {
      return this.readPPURegister(address);
    }
    
    // $2180-$2183: WRAM access registers
    if (address >= 0x2180 && address <= 0x2183) {
      return this.readWRAMRegister(address);
    }
    
    // $4000-$41FF: CPU I/O registers (old-style joypad)
    if (address >= 0x4000 && address <= 0x41FF) {
      return this.readJoypadRegister(address);
    }
    
    // $4200-$43FF: CPU registers (DMA, interrupts, etc.)
    if (address >= 0x4200 && address <= 0x43FF) {
      return this.readCPURegister(address);
    }
    
    // $4016-$4017: Controller ports
    if (address === 0x4016 || address === 0x4017) {
      return this.controllerRead?.(address - 0x4016) ?? 0;
    }
    
    // $6000-$7FFF: Cartridge expansion (SRAM for LoROM)
    if (address >= 0x6000 && address < 0x8000) {
      if (!this.isHiROM && this.sram.length > 0) {
        const sramAddr = address - 0x6000;
        return this.sram[sramAddr % this.sram.length];
      }
      return this.openBus;
    }
    
    // $8000-$FFFF: ROM
    if (address >= 0x8000) {
      return this.readROM(bank, address);
    }
    
    return this.openBus;
  }
  
  private writeSystemArea(bank: number, address: number, value: number): void {
    // $0000-$1FFF: LowRAM
    if (address < 0x2000) {
      this.wram[address] = value;
      return;
    }
    
    // $2140-$2143: APU I/O ports (before PPU registers check)
    if (address >= 0x2140 && address <= 0x2143) {
      this.apuWrite?.(address - 0x2140, value);
      return;
    }
    
    // $2100-$21FF: PPU registers
    if (address >= 0x2100 && address <= 0x21FF) {
      this.writePPURegister(address, value);
      return;
    }
    
    // $2180-$2183: WRAM access registers
    if (address >= 0x2180 && address <= 0x2183) {
      this.writeWRAMRegister(address, value);
      return;
    }
    
    // $4200-$43FF: CPU registers
    if (address >= 0x4200 && address <= 0x43FF) {
      this.writeCPURegister(address, value);
      return;
    }
    
    // $6000-$7FFF: SRAM (LoROM)
    if (address >= 0x6000 && address < 0x8000) {
      if (!this.isHiROM && this.sram.length > 0) {
        const sramAddr = address - 0x6000;
        this.sram[sramAddr % this.sram.length] = value;
      }
      return;
    }
  }
  
  // ============================================================================
  // Cartridge Area
  // ============================================================================
  
  private readCartridge(bank: number, address: number): number {
    if (this.isHiROM) {
      // HiROM: Direct ROM mapping
      return this.readROM(bank, address);
    } else {
      // LoROM: Upper half is ROM
      if (address >= 0x8000) {
        return this.readROM(bank, address);
      }
      // Lower half varies
      return this.openBus;
    }
  }
  
  private writeCartridge(bank: number, address: number, value: number): void {
    // SRAM writes for HiROM at $6000-$7FFF
    if (this.isHiROM && address >= 0x6000 && address < 0x8000) {
      const sramAddr = ((bank - 0x40) << 13) | (address - 0x6000);
      if (sramAddr < this.sram.length) {
        this.sram[sramAddr] = value;
      }
    }
  }
  
  private readROM(bank: number, address: number): number {
    let offset: number;
    
    if (this.isHiROM) {
      // HiROM: Linear mapping from $C00000
      // Banks $40-$7D and $C0-$FF map to ROM
      if (bank >= 0xC0) {
        offset = ((bank - 0xC0) << 16) | address;
      } else if (bank >= 0x40) {
        offset = ((bank - 0x40) << 16) | address;
      } else {
        // Banks $00-$3F at $8000-$FFFF
        offset = (bank << 16) | address;
      }
    } else {
      // LoROM: Upper half of each bank
      // 32KB per bank from $8000-$FFFF
      if (bank >= 0x80) {
        offset = ((bank - 0x80) << 15) | (address - 0x8000);
      } else {
        offset = (bank << 15) | (address - 0x8000);
      }
    }
    
    return this.rom[offset % this.rom.length] ?? 0;
  }
  
  // ============================================================================
  // PPU Registers ($2100-$21FF)
  // ============================================================================
  
  private readPPURegister(address: number): number {
    if (this.ppuRead) {
      return this.ppuRead(address);
    }
    
    // Default implementations for some registers
    switch (address) {
      case 0x2134: // MPYL - Multiplication result (low)
      case 0x2135: // MPYM - Multiplication result (mid)
      case 0x2136: // MPYH - Multiplication result (high)
      case 0x2137: // SLHV - Software latch for H/V counter
      case 0x2138: // OAMDATAREAD
      case 0x2139: // VMDATALREAD
      case 0x213A: // VMDATAHREAD
      case 0x213B: // CGDATAREAD
      case 0x213C: // OPHCT
      case 0x213D: // OPVCT
      case 0x213E: // STAT77
      case 0x213F: // STAT78
        return this.hwRegisters[address - 0x2100];
      default:
        return this.openBus;
    }
  }
  
  private writePPURegister(address: number, value: number): void {
    this.hwRegisters[address - 0x2100] = value;
    
    if (this.ppuWrite) {
      this.ppuWrite(address, value);
    }
  }
  
  // ============================================================================
  // WRAM Access Registers ($2180-$2183)
  // ============================================================================
  
  private readWRAMRegister(address: number): number {
    switch (address) {
      case 0x2180:
        // WMDATA - Read from WRAM at current address
        const value = this.wram[this.wramAddress];
        this.wramAddress = (this.wramAddress + 1) & 0x1FFFF;
        return value;
      default:
        return this.openBus;
    }
  }
  
  private writeWRAMRegister(address: number, value: number): void {
    switch (address) {
      case 0x2180:
        // WMDATA - Write to WRAM at current address
        this.wram[this.wramAddress] = value;
        this.wramAddress = (this.wramAddress + 1) & 0x1FFFF;
        break;
      case 0x2181:
        // WMADDL - WRAM address low
        this.wramAddress = (this.wramAddress & 0x1FF00) | value;
        break;
      case 0x2182:
        // WMADDM - WRAM address mid
        this.wramAddress = (this.wramAddress & 0x100FF) | (value << 8);
        break;
      case 0x2183:
        // WMADDH - WRAM address high (bit 0 only)
        this.wramAddress = (this.wramAddress & 0x0FFFF) | ((value & 0x01) << 16);
        break;
    }
  }
  
  // ============================================================================
  // Joypad Registers ($4000-$4017)
  // ============================================================================
  
  private readJoypadRegister(address: number): number {
    switch (address) {
      case 0x4016:
      case 0x4017:
        return this.controllerRead?.(address - 0x4016) ?? 0;
      default:
        return this.openBus;
    }
  }
  
  // ============================================================================
  // CPU Registers ($4200-$43FF)
  // ============================================================================
  
  private readCPURegister(address: number): number {
    const reg = address - 0x4200;
    
    switch (address) {
      case 0x4210: { // RDNMI - NMI flag
        // Bit 7: NMI flag (set at VBlank start, cleared on read)
        // Bit 4: Open bus / CPU version
        const vblank = this.ppuGetVBlank ? this.ppuGetVBlank() : false;
        const value = (vblank ? 0x80 : 0x00) | 0x02; // CPU version = 2
        return value;
      }
      case 0x4211: { // TIMEUP - IRQ flag
        // Bit 7: IRQ flag (cleared on read)
        const value = this.hwRegisters[0x100 + reg] & 0x80;
        this.hwRegisters[0x100 + reg] &= 0x7F; // Clear flag on read
        return value;
      }
      case 0x4212: { // HVBJOY - PPU status
        // Bit 7: VBlank flag
        // Bit 6: HBlank flag  
        // Bit 0: Auto joypad read in progress (always 0 for now)
        const vblank = this.ppuGetVBlank ? this.ppuGetVBlank() : false;
        const hblank = this.ppuGetHBlank ? this.ppuGetHBlank() : false;
        return (vblank ? 0x80 : 0x00) | (hblank ? 0x40 : 0x00);
      }
      case 0x4213: // RDIO - I/O port
      case 0x4214: // RDDIVL
      case 0x4215: // RDDIVH
      case 0x4216: // RDMPYL
      case 0x4217: // RDMPYH
      case 0x4218: // JOY1L
      case 0x4219: // JOY1H
      case 0x421A: // JOY2L
      case 0x421B: // JOY2H
      case 0x421C: // JOY3L
      case 0x421D: // JOY3H
      case 0x421E: // JOY4L
      case 0x421F: // JOY4H
        return this.hwRegisters[0x100 + reg];
      default:
        return this.openBus;
    }
  }
  
  private writeCPURegister(address: number, value: number): void {
    const reg = address - 0x4200;
    this.hwRegisters[0x100 + reg] = value;
    
    // Handle specific register writes
    switch (address) {
      case 0x4200: // NMITIMEN
        // NMI/IRQ enable
        this.nmiEnabled = (value & 0x80) !== 0;
        this.vIRQEnabled = (value & 0x20) !== 0;
        this.hIRQEnabled = (value & 0x10) !== 0;
        this.autoJoypadRead = (value & 0x01) !== 0;
        break;
      case 0x4202: // WRMPYA
        // Multiplicand A
        break;
      case 0x4203: // WRMPYB
        // Multiplicand B - triggers multiplication
        this.performMultiplication();
        break;
      case 0x4204: // WRDIVL
      case 0x4205: // WRDIVH
        // Dividend
        break;
      case 0x4206: // WRDIVB
        // Divisor - triggers division
        this.performDivision();
        break;
      case 0x4207: // HTIMEL
      case 0x4208: // HTIMEH
        // H-Count timer
        break;
      case 0x4209: // VTIMEL
      case 0x420A: // VTIMEH
        // V-Count timer
        break;
      case 0x420B: // MDMAEN
        // General DMA enable
        this.executeDMA(value);
        break;
      case 0x420C: // HDMAEN
        // HDMA enable
        break;
      case 0x420D: // MEMSEL
        // FastROM enable
        this.isFastROM = (value & 0x01) !== 0;
        break;
    }
  }
  
  // ============================================================================
  // Math Operations
  // ============================================================================
  
  private performMultiplication(): void {
    const a = this.hwRegisters[0x102]; // WRMPYA
    const b = this.hwRegisters[0x103]; // WRMPYB
    const result = a * b;
    
    this.hwRegisters[0x116] = result & 0xFF;        // RDMPYL
    this.hwRegisters[0x117] = (result >> 8) & 0xFF; // RDMPYH
  }
  
  private performDivision(): void {
    const dividend = this.hwRegisters[0x104] | (this.hwRegisters[0x105] << 8);
    const divisor = this.hwRegisters[0x106];
    
    if (divisor === 0) {
      this.hwRegisters[0x114] = 0xFF;
      this.hwRegisters[0x115] = 0xFF;
      this.hwRegisters[0x116] = dividend & 0xFF;
      this.hwRegisters[0x117] = (dividend >> 8) & 0xFF;
    } else {
      const quotient = Math.floor(dividend / divisor);
      const remainder = dividend % divisor;
      
      this.hwRegisters[0x114] = quotient & 0xFF;        // RDDIVL
      this.hwRegisters[0x115] = (quotient >> 8) & 0xFF; // RDDIVH
      this.hwRegisters[0x116] = remainder & 0xFF;       // RDMPYL
      this.hwRegisters[0x117] = (remainder >> 8) & 0xFF;// RDMPYH
    }
  }
  
  // ============================================================================
  // DMA
  // ============================================================================
  
  private executeDMA(channels: number): void {
    for (let ch = 0; ch < 8; ch++) {
      if (!(channels & (1 << ch))) continue;
      
      const base = 0x4300 + (ch * 0x10);
      const params = this.hwRegisters[base - 0x4200];
      const bAddr = this.hwRegisters[base - 0x4200 + 1];
      const aAddr = this.hwRegisters[base - 0x4200 + 2] | 
                   (this.hwRegisters[base - 0x4200 + 3] << 8);
      const aBank = this.hwRegisters[base - 0x4200 + 4];
      let size = this.hwRegisters[base - 0x4200 + 5] | 
                (this.hwRegisters[base - 0x4200 + 6] << 8);
      
      if (size === 0) size = 0x10000;
      
      const direction = (params & 0x80) !== 0; // 0 = A→B (to PPU), 1 = B→A (from PPU)
      const mode = params & 0x07;
      
      // Transfer patterns based on mode
      const patterns = [
        [0],           // Mode 0: 1 byte, 1 address
        [0, 1],        // Mode 1: 2 bytes, 2 addresses
        [0, 0],        // Mode 2: 2 bytes, 1 address
        [0, 0, 1, 1],  // Mode 3: 4 bytes, 2 addresses
        [0, 1, 2, 3],  // Mode 4: 4 bytes, 4 addresses
        [0, 1, 0, 1],  // Mode 5: 4 bytes, 2 addresses (alternating)
        [0, 0],        // Mode 6: 2 bytes, 1 address
        [0, 0, 1, 1],  // Mode 7: 4 bytes, 2 addresses
      ];
      
      const pattern = patterns[mode];
      let patternIndex = 0;
      let currentAAddr = aAddr;
      
      for (let i = 0; i < size; i++) {
        const offset = pattern[patternIndex];
        const bAddress = 0x2100 + bAddr + offset;
        
        if (direction) {
          // B-Bus → A-Bus (PPU to CPU)
          const value = this.read(0x00, bAddress);
          this.write(aBank, currentAAddr, value);
        } else {
          // A-Bus → B-Bus (CPU to PPU)
          const value = this.read(aBank, currentAAddr);
          this.write(0x00, bAddress, value);
        }
        
        // Increment A address (unless fixed)
        if (!(params & 0x08)) {
          if (params & 0x10) {
            currentAAddr = (currentAAddr - 1) & 0xFFFF;
          } else {
            currentAAddr = (currentAAddr + 1) & 0xFFFF;
          }
        }
        
        patternIndex = (patternIndex + 1) % pattern.length;
      }
    }
  }
  
  // ============================================================================
  // Memory Speed
  // ============================================================================
  
  getAccessSpeed(bank: number, address: number): number {
    // Fast ROM enabled and accessing ROM area
    if (this.isFastROM && bank >= 0x80) {
      return MemorySpeed.FAST;
    }
    
    // WRAM
    if (bank === 0x7E || bank === 0x7F) {
      return MemorySpeed.SLOW;
    }
    
    // Low RAM mirror
    if ((bank <= 0x3F || (bank >= 0x80 && bank <= 0xBF)) && address < 0x2000) {
      return MemorySpeed.SLOW;
    }
    
    // PPU/APU registers
    if ((bank <= 0x3F || (bank >= 0x80 && bank <= 0xBF)) && 
        address >= 0x2100 && address < 0x4000) {
      return MemorySpeed.FAST;
    }
    
    // Default slow ROM
    return MemorySpeed.SLOW;
  }
  
  // ============================================================================
  // Direct Memory Access
  // ============================================================================
  
  getWRAM(): Uint8Array {
    return this.wram;
  }
  
  getVRAM(): Uint8Array {
    return this.vram;
  }
  
  getOAM(): Uint8Array {
    return this.oam;
  }
  
  getCGRAM(): Uint8Array {
    return this.cgram;
  }
  
  getSRAM(): Uint8Array {
    return this.sram;
  }
  
  // ============================================================================
  // NMI/IRQ Status
  // ============================================================================
  
  isNMIEnabled(): boolean {
    return this.nmiEnabled;
  }
  
  isVIRQEnabled(): boolean {
    return this.vIRQEnabled;
  }
  
  isHIRQEnabled(): boolean {
    return this.hIRQEnabled;
  }

  // ============================================================================
  // Joypad Data
  // ============================================================================

  /**
   * Set joypad data for a controller port
   * @param port Controller port (0-3)
   * @param data 16-bit joypad data
   */
  setJoypadData(port: number, data: number): void {
    if (port < 0 || port > 3) return;
    
    // JOY1 = $4218-$4219, JOY2 = $421A-$421B, etc.
    const baseOffset = 0x18 + (port * 2);
    this.hwRegisters[0x100 + baseOffset] = data & 0xFF;       // Low byte
    this.hwRegisters[0x100 + baseOffset + 1] = (data >> 8) & 0xFF; // High byte
  }

  /**
   * Get joypad data for a controller port
   * @param port Controller port (0-3)
   * @returns 16-bit joypad data
   */
  getJoypadData(port: number): number {
    if (port < 0 || port > 3) return 0;
    
    const baseOffset = 0x18 + (port * 2);
    return this.hwRegisters[0x100 + baseOffset] | 
           (this.hwRegisters[0x100 + baseOffset + 1] << 8);
  }
}
