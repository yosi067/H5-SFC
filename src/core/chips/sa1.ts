/**
 * Project 16-bit: SFC Emulator
 * SA-1 Enhancement Chip Implementation
 * 
 * The SA-1 is a secondary 65C816 CPU running at 10.74 MHz with:
 * - Dedicated arithmetic unit (multiplication/division)
 * - Memory mapping control
 * - DMA/HDMA capabilities
 * - Character conversion
 */

import {
  EnhancementChip,
  ChipType,
  ChipState,
  chipRegistry,
} from './chipManager';

// SA-1 Register Addresses
const SA1_REG = {
  // S-CPU to SA-1 communication
  CCNT: 0x2200,    // SA-1 CPU control
  SIE: 0x2201,     // S-CPU interrupt enable
  SIC: 0x2202,     // S-CPU interrupt clear
  CRV: 0x2203,     // SA-1 reset vector (low/high)
  CNV: 0x2205,     // SA-1 NMI vector (low/high)
  CIV: 0x2207,     // SA-1 IRQ vector (low/high)
  SCNT: 0x2209,    // S-CPU control
  CIE: 0x220A,     // SA-1 interrupt enable
  CIC: 0x220B,     // SA-1 interrupt clear
  SNV: 0x220C,     // S-CPU NMI vector
  SIV: 0x220E,     // S-CPU IRQ vector
  
  // Memory mapping
  TMC: 0x2210,     // Timer control
  CTR: 0x2211,     // CPU timer restart
  HCNT: 0x2212,    // H-Count
  VCNT: 0x2214,    // V-Count
  CXB: 0x2220,     // ROM bank C mapping
  DXB: 0x2221,     // ROM bank D mapping
  EXB: 0x2222,     // ROM bank E mapping
  FXB: 0x2223,     // ROM bank F mapping
  BMAPS: 0x2224,   // S-CPU BW-RAM mapping
  BMAP: 0x2225,    // SA-1 BW-RAM mapping
  SWBE: 0x2226,    // S-CPU BW-RAM write enable
  CWBE: 0x2227,    // SA-1 BW-RAM write enable
  BWPA: 0x2228,    // BW-RAM write-protected area
  SIWP: 0x2229,    // S-CPU I-RAM write protect
  CIWP: 0x222A,    // SA-1 I-RAM write protect
  
  // DMA
  DCNT: 0x2230,    // DMA control
  CDMA: 0x2231,    // Character conversion DMA params
  DSA: 0x2232,     // DMA source address (24-bit)
  DDA: 0x2235,     // DMA dest address (24-bit)
  DTC: 0x2238,     // DMA terminal count (16-bit)
  
  // Arithmetic
  BBF: 0x223F,     // BW-RAM bitmap format
  MA: 0x2250,      // Math A (16-bit) - multiplicand/dividend low
  MB: 0x2252,      // Math B (16-bit) - multiplier/divisor low
  MDA: 0x2254,     // Math dividend high (32-bit total dividend)
  MDB: 0x2258,     // Divisor for division mode
  VBD: 0x225A,     // Variable-length bit data
  VDA: 0x225B,     // Variable-length bit address (24-bit)
  
  // Read registers
  SFR: 0x2300,     // S-CPU flag read
  CFR: 0x2301,     // SA-1 flag read
  HCR: 0x2302,     // H-Count read
  VCR: 0x2304,     // V-Count read
  MR: 0x2306,      // Math result (40-bit)
  OF: 0x230B,      // Math overflow flag
  VDPL: 0x230C,    // Variable-length data read (low)
  VDPH: 0x230D,    // Variable-length data read (high)
  VC: 0x230E,      // Version code
};

export class SA1Chip implements EnhancementChip {
  readonly name = 'SA-1';
  readonly type = ChipType.SA1;
  readonly chipId = 'SA-1';
  readonly baseAddress = 0x2200;
  
  // ROM/SRAM references
  private rom: Uint8Array = new Uint8Array(0);
  private sram: Uint8Array = new Uint8Array(0);
  
  // I-RAM (2KB internal RAM)
  private iram: Uint8Array = new Uint8Array(0x800);
  
  // BW-RAM (128KB, typically battery-backed)
  private bwram: Uint8Array = new Uint8Array(0x20000);
  
  // Registers
  private ccnt: number = 0;        // SA-1 CPU control
  private scnt: number = 0;        // S-CPU control
  private sie: number = 0;         // S-CPU interrupt enable
  private cie: number = 0;         // SA-1 interrupt enable
  private sic: number = 0;         // S-CPU interrupt clear
  private cic: number = 0;         // SA-1 interrupt clear
  
  // Vectors
  private crvl: number = 0;        // SA-1 reset vector low
  private crvh: number = 0;        // SA-1 reset vector high
  private cnvl: number = 0;        // SA-1 NMI vector low
  private cnvh: number = 0;        // SA-1 NMI vector high
  private civl: number = 0;        // SA-1 IRQ vector low
  private civh: number = 0;        // SA-1 IRQ vector high
  private snvl: number = 0;        // S-CPU NMI vector low
  private snvh: number = 0;        // S-CPU NMI vector high
  private sivl: number = 0;        // S-CPU IRQ vector low
  private sivh: number = 0;        // S-CPU IRQ vector high
  
  // Bank mapping
  private cxb: number = 0;         // ROM bank C
  private dxb: number = 1;         // ROM bank D
  private exb: number = 2;         // ROM bank E
  private fxb: number = 3;         // ROM bank F
  private bmaps: number = 0;       // S-CPU BW-RAM bank
  private bmap: number = 0;        // SA-1 BW-RAM bank
  
  // Write protection
  private swbe: number = 0;        // S-CPU BW-RAM write enable
  private cwbe: number = 0;        // SA-1 BW-RAM write enable
  private bwpa: number = 0x0F;     // BW-RAM protected area
  private siwp: number = 0;        // S-CPU I-RAM protect
  private ciwp: number = 0;        // SA-1 I-RAM protect
  
  // DMA
  private dcnt: number = 0;
  private cdma: number = 0;
  private dsa: number = 0;         // 24-bit source
  private dda: number = 0;         // 24-bit dest
  private dtc: number = 0;         // 16-bit count
  
  // Arithmetic unit
  private mcnt: number = 0;
  private ma: number = 0;          // 16-bit operand A (multiplicand)
  private mb: number = 0;          // 16-bit operand B (multiplier/divisor)
  private dividend: number = 0;    // 32-bit dividend for division
  private mr: bigint = 0n;         // 40-bit result
  private overflow: boolean = false;
  
  // Variable-length bit processing
  private vda: number = 0;         // 24-bit address
  private vbit: number = 0;        // Bit offset
  
  // Timer
  private hcnt: number = 0;
  private vcnt: number = 0;
  private tmc: number = 0;
  
  // SA-1 CPU internal state
  private sa1Running: boolean = false;
  private sa1Cycles: number = 0;
  
  // ============================================================================
  // Lifecycle
  // ============================================================================
  
  init(rom: Uint8Array, sram: Uint8Array): void {
    this.rom = rom;
    this.sram = sram;
    
    // Copy SRAM to BW-RAM if provided
    if (sram.length > 0) {
      const copyLen = Math.min(sram.length, this.bwram.length);
      this.bwram.set(sram.subarray(0, copyLen));
    }
    
    this.reset();
  }
  
  reset(): void {
    this.iram.fill(0);
    
    this.ccnt = 0x20;      // SA-1 starts stopped
    this.scnt = 0;
    this.sie = 0;
    this.cie = 0;
    
    this.cxb = 0;
    this.dxb = 1;
    this.exb = 2;
    this.fxb = 3;
    
    this.bmaps = 0;
    this.bmap = 0;
    this.swbe = 0;
    this.cwbe = 0;
    this.bwpa = 0x0F;
    
    this.dcnt = 0;
    this.mcnt = 0;
    this.ma = 0;
    this.mb = 0;
    this.mr = 0n;
    
    this.sa1Running = false;
    this.sa1Cycles = 0;
  }
  
  // ============================================================================
  // Memory Mapping
  // ============================================================================
  
  handles(bank: number, address: number): boolean {
    // SA-1 registers $2200-$23FF
    if (bank === 0x00 && address >= 0x2200 && address <= 0x23FF) {
      return true;
    }
    
    // Also handle bank $22 for direct register access
    if (bank === 0x22 && address >= 0x2200 && address <= 0x23FF) {
      return true;
    }
    
    // I-RAM $3000-$37FF (mirrored across banks)
    if ((bank <= 0x3F || (bank >= 0x80 && bank <= 0xBF)) && 
        address >= 0x3000 && address <= 0x37FF) {
      return true;
    }
    
    // BW-RAM $6000-$7FFF in banks $00-$3F, $80-$BF
    if ((bank <= 0x3F || (bank >= 0x80 && bank <= 0xBF)) &&
        address >= 0x6000 && address <= 0x7FFF) {
      return true;
    }
    
    // Banks $40-$4F: BW-RAM directly mapped
    if (bank >= 0x40 && bank <= 0x4F) {
      return true;
    }
    
    // ROM banks with custom mapping ($C0-$FF, plus LoROM areas)
    if (bank >= 0xC0 && bank <= 0xFF) {
      return true;
    }
    
    return false;
  }
  
  read(bank: number, address: number): number {
    // Registers (accessible from bank $00 or $22)
    if ((bank === 0x00 || bank === 0x22) && address >= 0x2200 && address <= 0x23FF) {
      return this.readRegister(address);
    }
    
    // I-RAM
    if (address >= 0x3000 && address <= 0x37FF) {
      return this.iram[address - 0x3000];
    }
    
    // BW-RAM (low area)
    if (address >= 0x6000 && address <= 0x7FFF) {
      const offset = (this.bmaps << 13) | (address - 0x6000);
      return this.bwram[offset & 0x1FFFF];
    }
    
    // BW-RAM (banks $40-$4F)
    if (bank >= 0x40 && bank <= 0x4F) {
      const offset = ((bank - 0x40) << 16) | address;
      return this.bwram[offset & 0x1FFFF];
    }
    
    // ROM (custom mapping)
    if (bank >= 0xC0 && bank <= 0xFF) {
      return this.readROM(bank, address);
    }
    
    return 0;
  }
  
  write(bank: number, address: number, value: number): void {
    // Registers (accessible from bank $00 or $22)
    if ((bank === 0x00 || bank === 0x22) && address >= 0x2200 && address <= 0x23FF) {
      this.writeRegister(address, value);
      return;
    }
    
    // I-RAM
    if (address >= 0x3000 && address <= 0x37FF) {
      // Check write protection
      const block = (address - 0x3000) >> 8;
      if (!(this.siwp & (1 << block))) {
        this.iram[address - 0x3000] = value;
      }
      return;
    }
    
    // BW-RAM (low area)
    if (address >= 0x6000 && address <= 0x7FFF) {
      if (this.swbe) {
        const offset = (this.bmaps << 13) | (address - 0x6000);
        if (!this.isProtectedBWRAM(offset)) {
          this.bwram[offset & 0x1FFFF] = value;
        }
      }
      return;
    }
    
    // BW-RAM (banks $40-$4F) - always writable without protection check for S-CPU access
    if (bank >= 0x40 && bank <= 0x4F) {
      const offset = ((bank - 0x40) << 16) | address;
      this.bwram[offset & 0x1FFFF] = value;
      return;
    }
  }
  
  private isProtectedBWRAM(offset: number): boolean {
    const protectedSize = (this.bwpa & 0x0F) << 11; // 2KB units
    return offset < protectedSize;
  }
  
  private readROM(bank: number, address: number): number {
    // Map bank based on CXB/DXB/EXB/FXB registers
    let mappedBank: number;
    
    if (bank >= 0xC0 && bank <= 0xCF) {
      mappedBank = ((this.cxb & 0x07) << 4) | (bank & 0x0F);
    } else if (bank >= 0xD0 && bank <= 0xDF) {
      mappedBank = ((this.dxb & 0x07) << 4) | (bank & 0x0F);
    } else if (bank >= 0xE0 && bank <= 0xEF) {
      mappedBank = ((this.exb & 0x07) << 4) | (bank & 0x0F);
    } else {
      mappedBank = ((this.fxb & 0x07) << 4) | (bank & 0x0F);
    }
    
    const offset = (mappedBank << 16) | address;
    return this.rom[offset % this.rom.length];
  }
  
  // ============================================================================
  // Register Access
  // ============================================================================
  
  private readRegister(address: number): number {
    switch (address) {
      case SA1_REG.SFR:
        return this.getSCPUFlags();
      case SA1_REG.CFR:
        return this.getSA1Flags();
      case SA1_REG.HCR:
        return this.hcnt & 0xFF;
      case SA1_REG.HCR + 1:
        return (this.hcnt >> 8) & 0x01;
      case SA1_REG.VCR:
        return this.vcnt & 0xFF;
      case SA1_REG.VCR + 1:
        return (this.vcnt >> 8) & 0xFF;
      case SA1_REG.MR:
      case SA1_REG.MR + 1:
      case SA1_REG.MR + 2:
      case SA1_REG.MR + 3:
      case SA1_REG.MR + 4:
        return this.readMathResult(address - SA1_REG.MR);
      case SA1_REG.OF:
        return this.overflow ? 0x80 : 0x00;
      case SA1_REG.VDPL:
        return this.readVariableData(0);
      case SA1_REG.VDPH:
        return this.readVariableData(1);
      case SA1_REG.VC:
        return 0x23; // Version code
      default:
        return 0;
    }
  }
  
  private writeRegister(address: number, value: number): void {
    switch (address) {
      case SA1_REG.CCNT:
        this.ccnt = value;
        this.sa1Running = !(value & 0x20);
        if (value & 0x80) {
          // SA-1 reset
          this.resetSA1();
        }
        break;
      case SA1_REG.SIE:
        this.sie = value;
        break;
      case SA1_REG.SIC:
        this.sic = value;
        break;
      case SA1_REG.CRV:
        this.crvl = value;
        break;
      case SA1_REG.CRV + 1:
        this.crvh = value;
        break;
      case SA1_REG.CNV:
        this.cnvl = value;
        break;
      case SA1_REG.CNV + 1:
        this.cnvh = value;
        break;
      case SA1_REG.CIV:
        this.civl = value;
        break;
      case SA1_REG.CIV + 1:
        this.civh = value;
        break;
      case SA1_REG.SCNT:
        this.scnt = value;
        break;
      case SA1_REG.CIE:
        this.cie = value;
        break;
      case SA1_REG.CIC:
        this.cic = value;
        break;
      case SA1_REG.SNV:
        this.snvl = value;
        break;
      case SA1_REG.SNV + 1:
        this.snvh = value;
        break;
      case SA1_REG.SIV:
        this.sivl = value;
        break;
      case SA1_REG.SIV + 1:
        this.sivh = value;
        break;
      
      // Memory mapping
      case SA1_REG.CXB:
        this.cxb = value & 0x87;
        break;
      case SA1_REG.DXB:
        this.dxb = value & 0x87;
        break;
      case SA1_REG.EXB:
        this.exb = value & 0x87;
        break;
      case SA1_REG.FXB:
        this.fxb = value & 0x87;
        break;
      case SA1_REG.BMAPS:
        this.bmaps = value & 0x1F;
        break;
      case SA1_REG.BMAP:
        this.bmap = value & 0x7F;
        break;
      case SA1_REG.SWBE:
        this.swbe = value & 0x80;
        break;
      case SA1_REG.CWBE:
        this.cwbe = value & 0x80;
        break;
      case SA1_REG.BWPA:
        this.bwpa = value & 0x0F;
        break;
      case SA1_REG.SIWP:
        this.siwp = value;
        break;
      case SA1_REG.CIWP:
        this.ciwp = value;
        break;
      
      // DMA
      case SA1_REG.DCNT:
        this.dcnt = value;
        if (value & 0x80) {
          this.executeDMA();
        }
        break;
      case SA1_REG.CDMA:
        this.cdma = value;
        break;
      case SA1_REG.DSA:
        this.dsa = (this.dsa & 0xFFFF00) | value;
        break;
      case SA1_REG.DSA + 1:
        this.dsa = (this.dsa & 0xFF00FF) | (value << 8);
        break;
      case SA1_REG.DSA + 2:
        this.dsa = (this.dsa & 0x00FFFF) | (value << 16);
        break;
      case SA1_REG.DDA:
        this.dda = (this.dda & 0xFFFF00) | value;
        break;
      case SA1_REG.DDA + 1:
        this.dda = (this.dda & 0xFF00FF) | (value << 8);
        break;
      case SA1_REG.DDA + 2:
        this.dda = (this.dda & 0x00FFFF) | (value << 16);
        break;
      case SA1_REG.DTC:
        this.dtc = (this.dtc & 0xFF00) | value;
        break;
      case SA1_REG.DTC + 1:
        this.dtc = (this.dtc & 0x00FF) | (value << 8);
        break;
      
      // Arithmetic registers (0x2250-0x2259)
      case SA1_REG.MA:  // 0x2250 - Multiplicand/Dividend low byte
        this.ma = (this.ma & 0xFF00) | value;
        break;
      case SA1_REG.MA + 1:  // 0x2251 - Multiplicand/Dividend high byte
        this.ma = (this.ma & 0x00FF) | (value << 8);
        break;
      case SA1_REG.MB:  // 0x2252 - Multiplier/Divisor low byte
        this.mb = (this.mb & 0xFF00) | value;
        break;
      case SA1_REG.MB + 1:  // 0x2253 - Multiplier/Divisor high byte - triggers multiplication
        this.mb = (this.mb & 0x00FF) | (value << 8);
        this.performMultiplication();
        break;
      case SA1_REG.MDA:  // 0x2254 - Dividend byte 0 (low)
        this.dividend = (this.dividend & 0xFFFFFF00) | value;
        break;
      case SA1_REG.MDA + 1:  // 0x2255 - Dividend byte 1
        this.dividend = (this.dividend & 0xFFFF00FF) | (value << 8);
        break;
      case SA1_REG.MDA + 2:  // 0x2256 - Dividend byte 2
        this.dividend = (this.dividend & 0xFF00FFFF) | (value << 16);
        break;
      case SA1_REG.MDA + 3:  // 0x2257 - Dividend byte 3 (high)
        this.dividend = (this.dividend & 0x00FFFFFF) | (value << 24);
        break;
      case SA1_REG.MDB:  // 0x2258 - Divisor low for division
        this.mb = (this.mb & 0xFF00) | value;
        break;
      case SA1_REG.MDB + 1:  // 0x2259 - Divisor high - triggers division
        this.mb = (this.mb & 0x00FF) | (value << 8);
        this.performDivision();
        break;
      
      // Variable-length data
      case SA1_REG.VBD:  // 0x225A
        break;
      case SA1_REG.VDA:  // 0x225B
        this.vda = (this.vda & 0xFFFF00) | value;
        break;
      case SA1_REG.VDA + 1:
        this.vda = (this.vda & 0xFF00FF) | (value << 8);
        break;
      case SA1_REG.VDA + 2:
        this.vda = (this.vda & 0x00FFFF) | (value << 16);
        this.vbit = 0;
        break;
    }
  }
  
  // ============================================================================
  // Arithmetic Unit
  // ============================================================================
  
  private performMultiplication(): void {
    // Unsigned 16x16 multiplication
    this.mr = BigInt(this.ma) * BigInt(this.mb);
    this.overflow = false;
  }
  
  private performDivision(): void {
    if (this.mb !== 0) {
      // 32-bit dividend / 16-bit divisor
      const quotient = Math.floor(this.dividend / this.mb) & 0xFFFF;
      const remainder = this.dividend % this.mb;
      // Result: quotient in low 16 bits, remainder in high 16 bits
      this.mr = BigInt((remainder << 16) | quotient);
      this.overflow = false;
    } else {
      this.mr = 0n;
      this.overflow = true;
    }
  }
  
  private performMath(): void {
    if (this.mcnt & 0x01) {
      this.performDivision();
    } else {
      this.performMultiplication();
    }
  }
  
  private readMathResult(offset: number): number {
    return Number((this.mr >> BigInt(offset * 8)) & 0xFFn);
  }
  
  // ============================================================================
  // Variable-Length Data
  // ============================================================================
  
  private readVariableData(high: boolean): number {
    const address = this.vda + (this.vbit >> 3);
    const shift = this.vbit & 7;
    
    // Read 3 bytes from ROM
    const b0 = this.rom[address % this.rom.length];
    const b1 = this.rom[(address + 1) % this.rom.length];
    const b2 = this.rom[(address + 2) % this.rom.length];
    
    const data = (b2 << 16) | (b1 << 8) | b0;
    const shifted = data >> shift;
    
    // Auto-increment bit position
    const bitLen = ((this.cdma >> 4) & 0x0F) || 16;
    this.vbit += bitLen;
    
    return high ? (shifted >> 8) & 0xFF : shifted & 0xFF;
  }
  
  // ============================================================================
  // DMA
  // ============================================================================
  
  private executeDMA(): void {
    // Simple normal DMA implementation
    const srcBank = (this.dsa >> 16) & 0xFF;
    const srcAddr = this.dsa & 0xFFFF;
    const dstBank = (this.dda >> 16) & 0xFF;
    const dstAddr = this.dda & 0xFFFF;
    
    for (let i = 0; i < this.dtc; i++) {
      const src = ((srcBank << 16) | ((srcAddr + i) & 0xFFFF));
      const dst = ((dstBank << 16) | ((dstAddr + i) & 0xFFFF));
      
      // Read from source
      let data: number;
      if (srcBank >= 0xC0) {
        data = this.readROM(srcBank, (srcAddr + i) & 0xFFFF);
      } else if (srcBank >= 0x40 && srcBank <= 0x4F) {
        const offset = ((srcBank - 0x40) << 16) | ((srcAddr + i) & 0xFFFF);
        data = this.bwram[offset & 0x1FFFF];
      } else {
        data = this.iram[(srcAddr + i) & 0x7FF];
      }
      
      // Write to destination
      if (dstBank >= 0x40 && dstBank <= 0x4F) {
        const offset = ((dstBank - 0x40) << 16) | ((dstAddr + i) & 0xFFFF);
        this.bwram[offset & 0x1FFFF] = data;
      } else {
        this.iram[(dstAddr + i) & 0x7FF] = data;
      }
    }
    
    // Clear DMA enable
    this.dcnt &= 0x7F;
  }
  
  // ============================================================================
  // CPU Flags
  // ============================================================================
  
  private getSCPUFlags(): number {
    let flags = 0;
    // Bit 7: IRQ from SA-1
    // Bit 6: DMA IRQ
    // Bit 5: NMI from SA-1
    // Bit 0-3: Message from SA-1
    flags |= (this.scnt & 0x0F);
    return flags;
  }
  
  private getSA1Flags(): number {
    let flags = 0;
    // Bit 7: IRQ from S-CPU
    // Bit 6: Timer IRQ
    // Bit 5: DMA IRQ
    // Bit 4: NMI from S-CPU
    // Bit 0-3: Message from S-CPU
    flags |= (this.ccnt & 0x0F);
    return flags;
  }
  
  private resetSA1(): void {
    // Reset SA-1 CPU state
    this.sa1Running = false;
    // The SA-1 would fetch its reset vector from CRV
  }
  
  // ============================================================================
  // Execution
  // ============================================================================
  
  step(masterCycles: number): void {
    if (!this.sa1Running) return;
    
    // SA-1 runs at ~10.74 MHz (3x main CPU speed)
    this.sa1Cycles += masterCycles * 3;
    
    // TODO: Implement full SA-1 65C816 CPU
    // For now, just consume cycles
    this.sa1Cycles = 0;
  }
  
  // ============================================================================
  // State Management
  // ============================================================================
  
  saveState(): ChipState {
    const data = new Uint8Array(this.iram.length + this.bwram.length);
    data.set(this.iram, 0);
    data.set(this.bwram, this.iram.length);
    
    return {
      type: ChipType.SA1,
      data,
      registers: {
        ccnt: this.ccnt,
        scnt: this.scnt,
        sie: this.sie,
        cie: this.cie,
        cxb: this.cxb,
        dxb: this.dxb,
        exb: this.exb,
        fxb: this.fxb,
        bmaps: this.bmaps,
        bmap: this.bmap,
        ma: this.ma,
        mb: this.mb,
        mr: Number(this.mr),
      },
    };
  }
  
  loadState(state: ChipState): void {
    if (state.type !== ChipType.SA1) return;
    
    this.iram.set(state.data.subarray(0, this.iram.length));
    this.bwram.set(state.data.subarray(this.iram.length, this.iram.length + this.bwram.length));
    
    this.ccnt = state.registers.ccnt ?? 0;
    this.scnt = state.registers.scnt ?? 0;
    this.sie = state.registers.sie ?? 0;
    this.cie = state.registers.cie ?? 0;
    this.cxb = state.registers.cxb ?? 0;
    this.dxb = state.registers.dxb ?? 1;
    this.exb = state.registers.exb ?? 2;
    this.fxb = state.registers.fxb ?? 3;
    this.bmaps = state.registers.bmaps ?? 0;
    this.bmap = state.registers.bmap ?? 0;
    this.ma = state.registers.ma ?? 0;
    this.mb = state.registers.mb ?? 0;
    this.mr = BigInt(state.registers.mr ?? 0);
  }
  
  /**
   * Alias for handles() for test compatibility
   */
  handlesAddress(bank: number, address: number): boolean {
    return this.handles(bank, address);
  }

  /**
   * Map a bank/address to the actual ROM bank based on CXB/DXB/EXB/FXB registers
   */
  mapAddress(bank: number, address: number): { bank: number; address: number } {
    let mappedBank = bank;
    
    // Map banks $C0-$CF using CXB
    if (bank >= 0xC0 && bank <= 0xCF) {
      mappedBank = (this.cxb & 0x07) | ((bank & 0x0F) << 0);
      mappedBank = this.cxb & 0x07;
    }
    // Map banks $D0-$DF using DXB
    else if (bank >= 0xD0 && bank <= 0xDF) {
      mappedBank = this.dxb & 0x07;
    }
    // Map banks $E0-$EF using EXB
    else if (bank >= 0xE0 && bank <= 0xEF) {
      mappedBank = this.exb & 0x07;
    }
    // Map banks $F0-$FF using FXB
    else if (bank >= 0xF0 && bank <= 0xFF) {
      mappedBank = this.fxb & 0x07;
    }
    
    return { bank: mappedBank, address };
  }

  /**
   * Check if SA-1 is requesting IRQ to S-CPU
   */
  checkIRQ(): boolean {
    // IRQ is asserted when CCNT.7 (message/IRQ request flag) is set
    return !!(this.ccnt & 0x80);
  }

  /**
   * Check if S-CPU is requesting IRQ to SA-1
   */
  checkSA1IRQ(): boolean {
    return !!(this.cie & 0x80) && !!(this.scnt & 0x80);
  }
}

// Register SA-1 chip
chipRegistry.register(ChipType.SA1, SA1Chip);
