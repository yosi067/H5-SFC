/**
 * Project 16-bit: SFC Emulator
 * 65C816 CPU Core Implementation
 */

import {
  CPURegisters,
  CPUState,
  StatusFlag,
  InterruptType,
  INTERRUPT_VECTORS,
  CPU_TIMING,
  MemorySpeed,
} from './types';
import { MemoryBus } from '../memory/memoryBus';

export class CPU65C816 {
  // Registers
  private reg: CPURegisters;
  
  // Cycle counter
  private cycles: number = 0;
  private totalCycles: bigint = 0n;
  
  // State
  private halted: boolean = false;
  private waitingForInterrupt: boolean = false;
  private pendingNMI: boolean = false;
  private pendingIRQ: boolean = false;
  
  // Execution trace (for debugging)
  private traceEnabled: boolean = false;
  private traceLog: string[] = [];
  private traceCount: number = 0;
  private maxTraceCount: number = 200;
  
  // Memory interface
  private memory: MemoryBus;
  
  constructor(memory: MemoryBus) {
    this.memory = memory;
    this.reg = this.createInitialRegisters();
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  private createInitialRegisters(): CPURegisters {
    return {
      A: 0x0000,
      X: 0x0000,
      Y: 0x0000,
      SP: 0x01FF,  // Stack at $01FF in emulation mode
      D: 0x0000,
      DB: 0x00,
      PB: 0x00,
      PC: 0x0000,
      P: StatusFlag.I | StatusFlag.M | StatusFlag.X,  // IRQ disabled, 8-bit mode
      E: true,     // Start in emulation mode
    };
  }

  /**
   * Reset the CPU to initial state
   */
  reset(): void {
    this.reg = this.createInitialRegisters();
    this.cycles = 0;
    this.halted = false;
    this.waitingForInterrupt = false;
    this.pendingNMI = false;
    this.pendingIRQ = false;
    
    // Fetch reset vector
    const resetVector = INTERRUPT_VECTORS.EMULATION.RESET;
    const low = this.memory.read(0x00, resetVector);
    const high = this.memory.read(0x00, resetVector + 1);
    this.reg.PC = (high << 8) | low;
    this.reg.PB = 0x00;
  }

  // ============================================================================
  // Flag Operations
  // ============================================================================

  private getFlag(flag: StatusFlag): boolean {
    return (this.reg.P & flag) !== 0;
  }

  private setFlag(flag: StatusFlag, value: boolean): void {
    if (value) {
      this.reg.P |= flag;
    } else {
      this.reg.P &= ~flag;
    }
  }

  private updateNZ8(value: number): void {
    this.setFlag(StatusFlag.Z, (value & 0xFF) === 0);
    this.setFlag(StatusFlag.N, (value & 0x80) !== 0);
  }

  private updateNZ16(value: number): void {
    this.setFlag(StatusFlag.Z, (value & 0xFFFF) === 0);
    this.setFlag(StatusFlag.N, (value & 0x8000) !== 0);
  }

  /** Check if accumulator is in 8-bit mode */
  private get isM8(): boolean {
    return this.reg.E || this.getFlag(StatusFlag.M);
  }

  /** Check if index registers are in 8-bit mode */
  private get isX8(): boolean {
    return this.reg.E || this.getFlag(StatusFlag.X);
  }

  // ============================================================================
  // Memory Access
  // ============================================================================

  private read(bank: number, address: number): number {
    this.cycles += this.memory.getAccessSpeed(bank, address);
    return this.memory.read(bank, address);
  }

  private write(bank: number, address: number, value: number): void {
    this.cycles += this.memory.getAccessSpeed(bank, address);
    this.memory.write(bank, address, value);
  }

  private readPC(): number {
    const value = this.read(this.reg.PB, this.reg.PC);
    this.reg.PC = (this.reg.PC + 1) & 0xFFFF;
    return value;
  }

  private readPC16(): number {
    const low = this.readPC();
    const high = this.readPC();
    return (high << 8) | low;
  }

  private pushByte(value: number): void {
    // Write to current SP then decrement
    this.write(0x00, this.reg.SP, value & 0xFF);
    if (this.reg.E) {
      // In emulation mode, SP wraps within page 1
      this.reg.SP = 0x0100 | ((this.reg.SP - 1) & 0xFF);
    } else {
      this.reg.SP = (this.reg.SP - 1) & 0xFFFF;
    }
  }

  private pushWord(value: number): void {
    this.pushByte(value >> 8);
    this.pushByte(value & 0xFF);
  }

  private pullByte(): number {
    // Increment SP then read
    if (this.reg.E) {
      this.reg.SP = 0x0100 | ((this.reg.SP + 1) & 0xFF);
    } else {
      this.reg.SP = (this.reg.SP + 1) & 0xFFFF;
    }
    return this.read(0x00, this.reg.SP);
  }

  private pullWord(): number {
    const low = this.pullByte();
    const high = this.pullByte();
    return (high << 8) | low;
  }

  // ============================================================================
  // Interrupt Handling
  // ============================================================================

  triggerNMI(): void {
    this.pendingNMI = true;
    this.waitingForInterrupt = false;
  }

  triggerIRQ(): void {
    if (!this.getFlag(StatusFlag.I)) {
      this.pendingIRQ = true;
      this.waitingForInterrupt = false;
    }
  }

  private handleInterrupt(type: InterruptType): void {
    // Push return address
    if (!this.reg.E) {
      this.pushByte(this.reg.PB);
    }
    this.pushWord(this.reg.PC);
    this.pushByte(this.reg.P);
    
    // Set interrupt disable flag
    this.setFlag(StatusFlag.I, true);
    // Clear decimal mode
    this.setFlag(StatusFlag.D, false);
    
    // Get vector based on mode and interrupt type
    let vector: number;
    if (this.reg.E) {
      switch (type) {
        case InterruptType.NMI:
          vector = INTERRUPT_VECTORS.EMULATION.NMI;
          break;
        case InterruptType.IRQ:
        case InterruptType.BRK:
          vector = INTERRUPT_VECTORS.EMULATION.IRQ;
          break;
        case InterruptType.COP:
          vector = INTERRUPT_VECTORS.EMULATION.COP;
          break;
        default:
          vector = INTERRUPT_VECTORS.EMULATION.IRQ;
      }
    } else {
      switch (type) {
        case InterruptType.NMI:
          vector = INTERRUPT_VECTORS.NATIVE.NMI;
          break;
        case InterruptType.IRQ:
          vector = INTERRUPT_VECTORS.NATIVE.IRQ;
          break;
        case InterruptType.BRK:
          vector = INTERRUPT_VECTORS.NATIVE.BRK;
          break;
        case InterruptType.COP:
          vector = INTERRUPT_VECTORS.NATIVE.COP;
          break;
        default:
          vector = INTERRUPT_VECTORS.NATIVE.IRQ;
      }
    }
    
    // Jump to handler
    this.reg.PB = 0x00;
    const low = this.memory.read(0x00, vector);
    const high = this.memory.read(0x00, vector + 1);
    this.reg.PC = (high << 8) | low;
    
    this.cycles += 7;
  }

  // ============================================================================
  // Main Execution
  // ============================================================================

  /**
   * Execute instructions until the specified cycle count is reached
   */
  step(targetCycles: number): number {
    this.cycles = 0;
    
    while (this.cycles < targetCycles) {
      // Check for interrupts
      if (this.pendingNMI) {
        this.pendingNMI = false;
        this.handleInterrupt(InterruptType.NMI);
        continue;
      }
      
      if (this.pendingIRQ && !this.getFlag(StatusFlag.I)) {
        this.pendingIRQ = false;
        this.handleInterrupt(InterruptType.IRQ);
        continue;
      }
      
      if (this.waitingForInterrupt) {
        // WAI instruction - idle until interrupt
        this.cycles += 2;
        continue;
      }
      
      if (this.halted) {
        // STP instruction - CPU stopped
        this.cycles += 1;
        continue;
      }
      
      // Fetch and execute instruction
      const opcode = this.readPC();
      
      // Trace execution if enabled
      if (this.traceEnabled && this.traceCount < this.maxTraceCount) {
        const pc = (this.reg.PC - 1) & 0xFFFF;  // PC was already incremented by readPC
        const op1 = this.memory.read(this.reg.PB, pc + 1);
        const op2 = this.memory.read(this.reg.PB, pc + 2);
        this.traceLog.push(
          `${this.reg.PB.toString(16).padStart(2,'0')}:${pc.toString(16).padStart(4,'0')} ` +
          `${opcode.toString(16).padStart(2,'0')} ${op1.toString(16).padStart(2,'0')} ${op2.toString(16).padStart(2,'0')} ` +
          `A=${this.reg.A.toString(16).padStart(4,'0')} X=${this.reg.X.toString(16).padStart(4,'0')} ` +
          `Y=${this.reg.Y.toString(16).padStart(4,'0')} SP=${this.reg.SP.toString(16).padStart(4,'0')} P=${this.reg.P.toString(16).padStart(2,'0')}`
        );
        this.traceCount++;
      }
      
      this.executeOpcode(opcode);
    }
    
    this.totalCycles += BigInt(this.cycles);
    return this.cycles;
  }

  /**
   * Execute a single opcode
   */
  private executeOpcode(opcode: number): void {
    switch (opcode) {
      // ========== Load/Store Operations ==========
      case 0xA9: this.LDA_immediate(); break;
      case 0xA5: this.LDA_direct(); break;
      case 0xAD: this.LDA_absolute(); break;
      case 0xAF: this.LDA_absoluteLong(); break;
      case 0xBF: this.LDA_absoluteLongX(); break;
      case 0xB5: this.LDA_directX(); break;
      case 0xBD: this.LDA_absoluteX(); break;
      case 0xB9: this.LDA_absoluteY(); break;
      case 0xA1: this.LDA_directIndirectX(); break;
      case 0xB1: this.LDA_directIndirectY(); break;
      case 0xB2: this.LDA_directIndirect(); break;
      case 0xA7: this.LDA_directIndirectLong(); break;
      case 0xB7: this.LDA_directIndirectLongY(); break;
      case 0xA3: this.LDA_stackRelative(); break;
      case 0xB3: this.LDA_stackRelativeIndirectY(); break;
      case 0xA2: this.LDX_immediate(); break;
      case 0xA6: this.LDX_direct(); break;
      case 0xAE: this.LDX_absolute(); break;
      case 0xB6: this.LDX_directY(); break;
      case 0xBE: this.LDX_absoluteY(); break;
      case 0xA0: this.LDY_immediate(); break;
      case 0xA4: this.LDY_direct(); break;
      case 0xAC: this.LDY_absolute(); break;
      case 0xB4: this.LDY_directX(); break;
      case 0xBC: this.LDY_absoluteX(); break;
      
      case 0x81: this.STA_directIndexedIndirect(); break;
      case 0x83: this.STA_stackRelative(); break;
      case 0x85: this.STA_direct(); break;
      case 0x87: this.STA_directIndirectLong(); break;
      case 0x8D: this.STA_absolute(); break;
      case 0x8F: this.STA_absoluteLong(); break;
      case 0x91: this.STA_directIndirectY(); break;
      case 0x92: this.STA_directIndirect(); break;
      case 0x93: this.STA_stackRelativeIndirectY(); break;
      case 0x95: this.STA_directX(); break;
      case 0x97: this.STA_directIndirectLongY(); break;
      case 0x99: this.STA_absoluteY(); break;
      case 0x9D: this.STA_absoluteX(); break;
      case 0x9F: this.STA_absoluteLongX(); break;
      case 0x86: this.STX_direct(); break;
      case 0x8E: this.STX_absolute(); break;
      case 0x84: this.STY_direct(); break;
      case 0x8C: this.STY_absolute(); break;
      case 0x64: this.STZ_direct(); break;
      case 0x9C: this.STZ_absolute(); break;
      case 0x74: this.STZ_direct_x(); break;
      case 0x9E: this.STZ_absolute_x(); break;
      
      // ========== Arithmetic Operations ==========
      case 0x69: this.ADC_immediate(); break;
      case 0x65: this.ADC_direct(); break;
      case 0x6D: this.ADC_absolute(); break;
      case 0x6F: this.ADC_absoluteLong(); break;
      case 0x7F: this.ADC_absoluteLongX(); break;
      case 0x75: this.ADC_directX(); break;
      case 0x7D: this.ADC_absoluteX(); break;
      case 0x79: this.ADC_absoluteY(); break;
      case 0x61: this.ADC_directIndirectX(); break;
      case 0x71: this.ADC_directIndirectY(); break;
      case 0x72: this.ADC_directIndirect(); break;
      case 0x67: this.ADC_directIndirectLong(); break;
      case 0x77: this.ADC_directIndirectLongY(); break;
      case 0x63: this.ADC_stackRelative(); break;
      case 0x73: this.ADC_stackRelativeIndirectY(); break;
      case 0xE9: this.SBC_immediate(); break;
      case 0xE5: this.SBC_direct(); break;
      case 0xED: this.SBC_absolute(); break;
      case 0xEF: this.SBC_absoluteLong(); break;
      case 0xFF: this.SBC_absoluteLongX(); break;
      case 0xF5: this.SBC_directX(); break;
      case 0xFD: this.SBC_absoluteX(); break;
      case 0xF9: this.SBC_absoluteY(); break;
      case 0xE1: this.SBC_directIndirectX(); break;
      case 0xF1: this.SBC_directIndirectY(); break;
      case 0xF2: this.SBC_directIndirect(); break;
      case 0xE7: this.SBC_directIndirectLong(); break;
      case 0xF7: this.SBC_directIndirectLongY(); break;
      case 0xE3: this.SBC_stackRelative(); break;
      case 0xF3: this.SBC_stackRelativeIndirectY(); break;
      
      case 0x1A: this.INC_A(); break;
      case 0xE6: this.INC_direct(); break;
      case 0xEE: this.INC_absolute(); break;
      case 0xE8: this.INX(); break;
      case 0xC8: this.INY(); break;
      
      case 0x3A: this.DEC_A(); break;
      case 0xC6: this.DEC_direct(); break;
      case 0xCE: this.DEC_absolute(); break;
      case 0xCA: this.DEX(); break;
      case 0x88: this.DEY(); break;
      
      // ========== Logical Operations ==========
      case 0x29: this.AND_immediate(); break;
      case 0x25: this.AND_direct(); break;
      case 0x2D: this.AND_absolute(); break;
      case 0x2F: this.AND_absoluteLong(); break;
      case 0x3F: this.AND_absoluteLongX(); break;
      case 0x35: this.AND_directX(); break;
      case 0x3D: this.AND_absoluteX(); break;
      case 0x39: this.AND_absoluteY(); break;
      case 0x21: this.AND_directIndirectX(); break;
      case 0x31: this.AND_directIndirectY(); break;
      case 0x32: this.AND_directIndirect(); break;
      case 0x27: this.AND_directIndirectLong(); break;
      case 0x37: this.AND_directIndirectLongY(); break;
      case 0x23: this.AND_stackRelative(); break;
      case 0x33: this.AND_stackRelativeIndirectY(); break;
      case 0x09: this.ORA_immediate(); break;
      case 0x05: this.ORA_direct(); break;
      case 0x0D: this.ORA_absolute(); break;
      case 0x0F: this.ORA_absoluteLong(); break;
      case 0x1F: this.ORA_absoluteLongX(); break;
      case 0x15: this.ORA_directX(); break;
      case 0x1D: this.ORA_absoluteX(); break;
      case 0x19: this.ORA_absoluteY(); break;
      case 0x01: this.ORA_directIndirectX(); break;
      case 0x11: this.ORA_directIndirectY(); break;
      case 0x12: this.ORA_directIndirect(); break;
      case 0x07: this.ORA_directIndirectLong(); break;
      case 0x17: this.ORA_directIndirectLongY(); break;
      case 0x03: this.ORA_stackRelative(); break;
      case 0x13: this.ORA_stackRelativeIndirectY(); break;
      case 0x49: this.EOR_immediate(); break;
      case 0x45: this.EOR_direct(); break;
      case 0x4D: this.EOR_absolute(); break;
      case 0x4F: this.EOR_absoluteLong(); break;
      case 0x5F: this.EOR_absoluteLongX(); break;
      case 0x55: this.EOR_directX(); break;
      case 0x5D: this.EOR_absoluteX(); break;
      case 0x59: this.EOR_absoluteY(); break;
      case 0x41: this.EOR_directIndirectX(); break;
      case 0x51: this.EOR_directIndirectY(); break;
      case 0x52: this.EOR_directIndirect(); break;
      case 0x47: this.EOR_directIndirectLong(); break;
      case 0x57: this.EOR_directIndirectLongY(); break;
      case 0x43: this.EOR_stackRelative(); break;
      case 0x53: this.EOR_stackRelativeIndirectY(); break;
      
      // ========== Compare Operations ==========
      case 0xC9: this.CMP_immediate(); break;
      case 0xC5: this.CMP_direct(); break;
      case 0xCD: this.CMP_absolute(); break;
      case 0xCF: this.CMP_absoluteLong(); break;
      case 0xDF: this.CMP_absoluteLongX(); break;
      case 0xD5: this.CMP_directX(); break;
      case 0xDD: this.CMP_absoluteX(); break;
      case 0xD9: this.CMP_absoluteY(); break;
      case 0xC1: this.CMP_directIndirectX(); break;
      case 0xD1: this.CMP_directIndirectY(); break;
      case 0xD2: this.CMP_directIndirect(); break;
      case 0xC7: this.CMP_directIndirectLong(); break;
      case 0xD7: this.CMP_directIndirectLongY(); break;
      case 0xC3: this.CMP_stackRelative(); break;
      case 0xD3: this.CMP_stackRelativeIndirectY(); break;
      case 0xE0: this.CPX_immediate(); break;
      case 0xE4: this.CPX_direct(); break;
      case 0xEC: this.CPX_absolute(); break;
      case 0xC0: this.CPY_immediate(); break;
      case 0xC4: this.CPY_direct(); break;
      case 0xCC: this.CPY_absolute(); break;
      
      // ========== Branch Operations ==========
      case 0x10: this.BPL(); break;
      case 0x30: this.BMI(); break;
      case 0x50: this.BVC(); break;
      case 0x70: this.BVS(); break;
      case 0x90: this.BCC(); break;
      case 0xB0: this.BCS(); break;
      case 0xD0: this.BNE(); break;
      case 0xF0: this.BEQ(); break;
      case 0x80: this.BRA(); break;
      case 0x82: this.BRL(); break;
      
      // ========== Jump/Call Operations ==========
      case 0x4C: this.JMP_absolute(); break;
      case 0x5C: this.JMP_absoluteLong(); break;
      case 0x6C: this.JMP_indirect(); break;
      case 0x7C: this.JMP_indexedIndirect(); break;
      case 0x20: this.JSR_absolute(); break;
      case 0xFC: this.JSR_absoluteX(); break;
      case 0x22: this.JSL_absoluteLong(); break;
      case 0x60: this.RTS(); break;
      case 0x6B: this.RTL(); break;
      case 0x40: this.RTI(); break;
      
      // ========== Stack Operations ==========
      case 0x48: this.PHA(); break;
      case 0x68: this.PLA(); break;
      case 0xDA: this.PHX(); break;
      case 0xFA: this.PLX(); break;
      case 0x5A: this.PHY(); break;
      case 0x7A: this.PLY(); break;
      case 0x08: this.PHP(); break;
      case 0x28: this.PLP(); break;
      case 0x8B: this.PHB(); break;
      case 0xAB: this.PLB(); break;
      case 0x0B: this.PHD(); break;
      case 0x2B: this.PLD(); break;
      case 0x4B: this.PHK(); break;
      case 0xD4: this.PEI(); break;
      case 0xF4: this.PEA(); break;
      case 0x62: this.PER(); break;
      
      // ========== Transfer Operations ==========
      case 0xAA: this.TAX(); break;
      case 0xA8: this.TAY(); break;
      case 0x8A: this.TXA(); break;
      case 0x98: this.TYA(); break;
      case 0xBA: this.TSX(); break;
      case 0x9A: this.TXS(); break;
      case 0x9B: this.TXY(); break;
      case 0xBB: this.TYX(); break;
      case 0x5B: this.TCD(); break;
      case 0x7B: this.TDC(); break;
      case 0x1B: this.TCS(); break;
      case 0x3B: this.TSC(); break;
      
      // ========== Flag Operations ==========
      case 0x18: this.CLC(); break;
      case 0x38: this.SEC(); break;
      case 0x58: this.CLI(); break;
      case 0x78: this.SEI(); break;
      case 0xD8: this.CLD(); break;
      case 0xF8: this.SED(); break;
      case 0xB8: this.CLV(); break;
      case 0xC2: this.REP(); break;
      case 0xE2: this.SEP(); break;
      case 0xFB: this.XCE(); break;
      
      // ========== Shift/Rotate Operations ==========
      case 0x0A: this.ASL_A(); break;
      case 0x06: this.ASL_direct(); break;
      case 0x0E: this.ASL_absolute(); break;
      case 0x16: this.ASL_directX(); break;
      case 0x1E: this.ASL_absoluteX(); break;
      case 0x4A: this.LSR_A(); break;
      case 0x46: this.LSR_direct(); break;
      case 0x4E: this.LSR_absolute(); break;
      case 0x56: this.LSR_directX(); break;
      case 0x5E: this.LSR_absoluteX(); break;
      case 0x2A: this.ROL_A(); break;
      case 0x26: this.ROL_direct(); break;
      case 0x2E: this.ROL_absolute(); break;
      case 0x36: this.ROL_directX(); break;
      case 0x3E: this.ROL_absoluteX(); break;
      case 0x6A: this.ROR_A(); break;
      case 0x66: this.ROR_direct(); break;
      case 0x6E: this.ROR_absolute(); break;
      case 0x76: this.ROR_directX(); break;
      case 0x7E: this.ROR_absoluteX(); break;
      
      // ========== Bit Operations ==========
      case 0x24: this.BIT_direct(); break;
      case 0x2C: this.BIT_absolute(); break;
      case 0x89: this.BIT_immediate(); break;
      case 0x34: this.BIT_directX(); break;
      case 0x3C: this.BIT_absoluteX(); break;
      case 0x04: this.TSB_direct(); break;
      case 0x0C: this.TSB_absolute(); break;
      case 0x14: this.TRB_direct(); break;
      case 0x1C: this.TRB_absolute(); break;
      
      // ========== Miscellaneous ==========
      case 0xEA: this.NOP(); break;
      case 0xCB: this.WAI(); break;
      case 0xDB: this.STP(); break;
      case 0x42: this.WDM(); break;
      case 0x00: this.BRK(); break;
      case 0x02: this.COP(); break;
      case 0x44: this.MVP(); break;
      case 0x54: this.MVN(); break;
      case 0xEB: this.XBA(); break;
      
      default:
        console.warn(`Unimplemented opcode: $${opcode.toString(16).padStart(2, '0')}`);
        this.cycles += 2;
    }
  }

  // ============================================================================
  // Instruction Implementations (Selected Examples)
  // ============================================================================

  // --- Load Instructions ---
  
  private LDA_immediate(): void {
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.readPC();
      this.updateNZ8(this.reg.A);
      this.cycles += 2;
    } else {
      this.reg.A = this.readPC16();
      this.updateNZ16(this.reg.A);
      this.cycles += 3;
    }
  }

  private LDA_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.read(0x00, addr);
      this.updateNZ8(this.reg.A);
      this.cycles += 3;
    } else {
      const low = this.read(0x00, addr);
      const high = this.read(0x00, (addr + 1) & 0xFFFF);
      this.reg.A = (high << 8) | low;
      this.updateNZ16(this.reg.A);
      this.cycles += 4;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private LDA_absolute(): void {
    const addr = this.readPC16();
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.read(this.reg.DB, addr);
      this.updateNZ8(this.reg.A);
      this.cycles += 4;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      this.reg.A = (high << 8) | low;
      this.updateNZ16(this.reg.A);
      this.cycles += 5;
    }
  }

  private LDA_absoluteLong(): void {
    const addr = this.readPC16();
    const bank = this.readPC();
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.read(bank, addr);
      this.updateNZ8(this.reg.A);
      this.cycles += 5;
    } else {
      const low = this.read(bank, addr);
      const high = this.read(bank, (addr + 1) & 0xFFFF);
      this.reg.A = (high << 8) | low;
      this.updateNZ16(this.reg.A);
      this.cycles += 6;
    }
  }

  private LDA_absoluteLongX(): void {
    const baseAddr = this.readPC16();
    const bank = this.readPC();
    const addr = (baseAddr + this.reg.X) & 0xFFFF;
    const newBank = (bank + ((baseAddr + this.reg.X) >> 16)) & 0xFF;
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.read(newBank, addr);
      this.updateNZ8(this.reg.A);
      this.cycles += 5;
    } else {
      const low = this.read(newBank, addr);
      const high = this.read(newBank, (addr + 1) & 0xFFFF);
      this.reg.A = (high << 8) | low;
      this.updateNZ16(this.reg.A);
      this.cycles += 6;
    }
  }

  private LDA_directX(): void {
    const addr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.read(0x00, addr);
      this.updateNZ8(this.reg.A);
      this.cycles += 4;
    } else {
      const low = this.read(0x00, addr);
      const high = this.read(0x00, (addr + 1) & 0xFFFF);
      this.reg.A = (high << 8) | low;
      this.updateNZ16(this.reg.A);
      this.cycles += 5;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private LDA_absoluteX(): void {
    const baseAddr = this.readPC16();
    const addr = (baseAddr + this.reg.X) & 0xFFFF;
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.read(this.reg.DB, addr);
      this.updateNZ8(this.reg.A);
      this.cycles += 4;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      this.reg.A = (high << 8) | low;
      this.updateNZ16(this.reg.A);
      this.cycles += 5;
    }
    // Page crossing penalty
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private LDA_absoluteY(): void {
    const baseAddr = this.readPC16();
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.read(this.reg.DB, addr);
      this.updateNZ8(this.reg.A);
      this.cycles += 4;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      this.reg.A = (high << 8) | low;
      this.updateNZ16(this.reg.A);
      this.cycles += 5;
    }
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private LDA_directIndirectX(): void {
    const ptr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    const addr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.read(this.reg.DB, addr);
      this.updateNZ8(this.reg.A);
      this.cycles += 6;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      this.reg.A = (high << 8) | low;
      this.updateNZ16(this.reg.A);
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private LDA_directIndirectY(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const baseAddr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.read(this.reg.DB, addr);
      this.updateNZ8(this.reg.A);
      this.cycles += 5;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      this.reg.A = (high << 8) | low;
      this.updateNZ16(this.reg.A);
      this.cycles += 6;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private LDA_directIndirect(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.read(this.reg.DB, addr);
      this.updateNZ8(this.reg.A);
      this.cycles += 5;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      this.reg.A = (high << 8) | low;
      this.updateNZ16(this.reg.A);
      this.cycles += 6;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private LDA_directIndirectLong(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addrLow = this.read(0x00, ptr);
    const addrHigh = this.read(0x00, (ptr + 1) & 0xFFFF);
    const bank = this.read(0x00, (ptr + 2) & 0xFFFF);
    const addr = addrLow | (addrHigh << 8);
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.read(bank, addr);
      this.updateNZ8(this.reg.A);
      this.cycles += 6;
    } else {
      const low = this.read(bank, addr);
      const high = this.read(bank, (addr + 1) & 0xFFFF);
      this.reg.A = (high << 8) | low;
      this.updateNZ16(this.reg.A);
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private LDA_directIndirectLongY(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addrLow = this.read(0x00, ptr);
    const addrHigh = this.read(0x00, (ptr + 1) & 0xFFFF);
    const bank = this.read(0x00, (ptr + 2) & 0xFFFF);
    const baseAddr = addrLow | (addrHigh << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const newBank = (bank + ((baseAddr + this.reg.Y) >> 16)) & 0xFF;
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.read(newBank, addr);
      this.updateNZ8(this.reg.A);
      this.cycles += 6;
    } else {
      const low = this.read(newBank, addr);
      const high = this.read(newBank, (addr + 1) & 0xFFFF);
      this.reg.A = (high << 8) | low;
      this.updateNZ16(this.reg.A);
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private LDA_stackRelative(): void {
    const offset = this.readPC();
    const addr = (this.reg.SP + offset) & 0xFFFF;
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.read(0x00, addr);
      this.updateNZ8(this.reg.A);
      this.cycles += 4;
    } else {
      const low = this.read(0x00, addr);
      const high = this.read(0x00, (addr + 1) & 0xFFFF);
      this.reg.A = (high << 8) | low;
      this.updateNZ16(this.reg.A);
      this.cycles += 5;
    }
  }

  private LDA_stackRelativeIndirectY(): void {
    const offset = this.readPC();
    const ptr = (this.reg.SP + offset) & 0xFFFF;
    const baseAddr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.read(this.reg.DB, addr);
      this.updateNZ8(this.reg.A);
      this.cycles += 7;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      this.reg.A = (high << 8) | low;
      this.updateNZ16(this.reg.A);
      this.cycles += 8;
    }
  }

  private LDX_immediate(): void {
    if (this.isX8) {
      this.reg.X = this.readPC();
      this.updateNZ8(this.reg.X);
      this.cycles += 2;
    } else {
      this.reg.X = this.readPC16();
      this.updateNZ16(this.reg.X);
      this.cycles += 3;
    }
  }

  private LDX_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    if (this.isX8) {
      this.reg.X = this.read(0x00, addr);
      this.updateNZ8(this.reg.X);
      this.cycles += 3;
    } else {
      const low = this.read(0x00, addr);
      const high = this.read(0x00, (addr + 1) & 0xFFFF);
      this.reg.X = (high << 8) | low;
      this.updateNZ16(this.reg.X);
      this.cycles += 4;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private LDX_absolute(): void {
    const addr = this.readPC16();
    if (this.isX8) {
      this.reg.X = this.read(this.reg.DB, addr);
      this.updateNZ8(this.reg.X);
      this.cycles += 4;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      this.reg.X = (high << 8) | low;
      this.updateNZ16(this.reg.X);
      this.cycles += 5;
    }
  }

  private LDY_immediate(): void {
    if (this.isX8) {
      this.reg.Y = this.readPC();
      this.updateNZ8(this.reg.Y);
      this.cycles += 2;
    } else {
      this.reg.Y = this.readPC16();
      this.updateNZ16(this.reg.Y);
      this.cycles += 3;
    }
  }

  private LDY_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    if (this.isX8) {
      this.reg.Y = this.read(0x00, addr);
      this.updateNZ8(this.reg.Y);
      this.cycles += 3;
    } else {
      const low = this.read(0x00, addr);
      const high = this.read(0x00, (addr + 1) & 0xFFFF);
      this.reg.Y = (high << 8) | low;
      this.updateNZ16(this.reg.Y);
      this.cycles += 4;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private LDY_absolute(): void {
    const addr = this.readPC16();
    if (this.isX8) {
      this.reg.Y = this.read(this.reg.DB, addr);
      this.updateNZ8(this.reg.Y);
      this.cycles += 4;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      this.reg.Y = (high << 8) | low;
      this.updateNZ16(this.reg.Y);
      this.cycles += 5;
    }
  }

  // LDY dp,X - $B4
  private LDY_directX(): void {
    const dp = this.readPC();
    const addr = (this.reg.D + dp + this.reg.X) & 0xFFFF;
    if (this.isX8) {
      this.reg.Y = this.read(0x00, addr);
      this.updateNZ8(this.reg.Y);
      this.cycles += 4;
    } else {
      const low = this.read(0x00, addr);
      const high = this.read(0x00, (addr + 1) & 0xFFFF);
      this.reg.Y = (high << 8) | low;
      this.updateNZ16(this.reg.Y);
      this.cycles += 5;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  // LDY abs,X - $BC
  private LDY_absoluteX(): void {
    const addr = (this.readPC16() + this.reg.X) & 0xFFFF;
    if (this.isX8) {
      this.reg.Y = this.read(this.reg.DB, addr);
      this.updateNZ8(this.reg.Y);
      this.cycles += 4;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      this.reg.Y = (high << 8) | low;
      this.updateNZ16(this.reg.Y);
      this.cycles += 5;
    }
    // Add 1 cycle for page boundary crossing (simplified - always add)
  }

  // LDX dp,Y - $B6
  private LDX_directY(): void {
    const dp = this.readPC();
    const addr = (this.reg.D + dp + this.reg.Y) & 0xFFFF;
    if (this.isX8) {
      this.reg.X = this.read(0x00, addr);
      this.updateNZ8(this.reg.X);
      this.cycles += 4;
    } else {
      const low = this.read(0x00, addr);
      const high = this.read(0x00, (addr + 1) & 0xFFFF);
      this.reg.X = (high << 8) | low;
      this.updateNZ16(this.reg.X);
      this.cycles += 5;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  // LDX abs,Y - $BE
  private LDX_absoluteY(): void {
    const addr = (this.readPC16() + this.reg.Y) & 0xFFFF;
    if (this.isX8) {
      this.reg.X = this.read(this.reg.DB, addr);
      this.updateNZ8(this.reg.X);
      this.cycles += 4;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      this.reg.X = (high << 8) | low;
      this.updateNZ16(this.reg.X);
      this.cycles += 5;
    }
    // Add 1 cycle for page boundary crossing (simplified - always add)
  }

  // --- Store Instructions ---
  
  private STA_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    if (this.isM8) {
      this.write(0x00, addr, this.reg.A & 0xFF);
      this.cycles += 3;
    } else {
      this.write(0x00, addr, this.reg.A & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, this.reg.A >> 8);
      this.cycles += 4;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private STA_absolute(): void {
    const addr = this.readPC16();
    if (this.isM8) {
      this.write(this.reg.DB, addr, this.reg.A & 0xFF);
      this.cycles += 4;
    } else {
      this.write(this.reg.DB, addr, this.reg.A & 0xFF);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, this.reg.A >> 8);
      this.cycles += 5;
    }
  }

  private STA_directIndexedIndirect(): void {
    // STA (dp,X) - $81
    const base = this.readPC();
    const addr = (this.reg.D + base + this.reg.X) & 0xFFFF;
    const ptr = this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
    if (this.isM8) {
      this.write(this.reg.DB, ptr, this.reg.A & 0xFF);
      this.cycles += 6;
    } else {
      this.write(this.reg.DB, ptr, this.reg.A & 0xFF);
      this.write(this.reg.DB, (ptr + 1) & 0xFFFF, this.reg.A >> 8);
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private STA_stackRelative(): void {
    // STA sr,S - $83
    const offset = this.readPC();
    const addr = (this.reg.SP + offset) & 0xFFFF;
    if (this.isM8) {
      this.write(0x00, addr, this.reg.A & 0xFF);
      this.cycles += 4;
    } else {
      this.write(0x00, addr, this.reg.A & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, this.reg.A >> 8);
      this.cycles += 5;
    }
  }

  private STA_directIndirectLong(): void {
    // STA [dp] - $87
    const base = this.readPC();
    const addr = (this.reg.D + base) & 0xFFFF;
    const ptr = this.read(0x00, addr) | 
                (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
    const bank = this.read(0x00, (addr + 2) & 0xFFFF);
    if (this.isM8) {
      this.write(bank, ptr, this.reg.A & 0xFF);
      this.cycles += 6;
    } else {
      this.write(bank, ptr, this.reg.A & 0xFF);
      this.write(bank, (ptr + 1) & 0xFFFF, this.reg.A >> 8);
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private STA_absoluteLong(): void {
    // STA long - $8F
    const addr = this.readPC16();
    const bank = this.readPC();
    if (this.isM8) {
      this.write(bank, addr, this.reg.A & 0xFF);
      this.cycles += 5;
    } else {
      this.write(bank, addr, this.reg.A & 0xFF);
      this.write(bank, (addr + 1) & 0xFFFF, this.reg.A >> 8);
      this.cycles += 6;
    }
  }

  private STA_directIndirectY(): void {
    // STA (dp),Y - $91
    const base = this.readPC();
    const addr = (this.reg.D + base) & 0xFFFF;
    const ptr = this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
    const effectiveAddr = (ptr + this.reg.Y) & 0xFFFF;
    if (this.isM8) {
      this.write(this.reg.DB, effectiveAddr, this.reg.A & 0xFF);
      this.cycles += 6;
    } else {
      this.write(this.reg.DB, effectiveAddr, this.reg.A & 0xFF);
      this.write(this.reg.DB, (effectiveAddr + 1) & 0xFFFF, this.reg.A >> 8);
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private STA_directIndirect(): void {
    // STA (dp) - $92
    const base = this.readPC();
    const addr = (this.reg.D + base) & 0xFFFF;
    const ptr = this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
    if (this.isM8) {
      this.write(this.reg.DB, ptr, this.reg.A & 0xFF);
      this.cycles += 5;
    } else {
      this.write(this.reg.DB, ptr, this.reg.A & 0xFF);
      this.write(this.reg.DB, (ptr + 1) & 0xFFFF, this.reg.A >> 8);
      this.cycles += 6;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private STA_stackRelativeIndirectY(): void {
    // STA (sr,S),Y - $93
    const offset = this.readPC();
    const addr = (this.reg.SP + offset) & 0xFFFF;
    const ptr = this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
    const effectiveAddr = (ptr + this.reg.Y) & 0xFFFF;
    if (this.isM8) {
      this.write(this.reg.DB, effectiveAddr, this.reg.A & 0xFF);
      this.cycles += 7;
    } else {
      this.write(this.reg.DB, effectiveAddr, this.reg.A & 0xFF);
      this.write(this.reg.DB, (effectiveAddr + 1) & 0xFFFF, this.reg.A >> 8);
      this.cycles += 8;
    }
  }

  private STA_directX(): void {
    // STA dp,X - $95
    const base = this.readPC();
    const addr = (this.reg.D + base + this.reg.X) & 0xFFFF;
    if (this.isM8) {
      this.write(0x00, addr, this.reg.A & 0xFF);
      this.cycles += 4;
    } else {
      this.write(0x00, addr, this.reg.A & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, this.reg.A >> 8);
      this.cycles += 5;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private STA_directIndirectLongY(): void {
    // STA [dp],Y - $97
    const base = this.readPC();
    const addr = (this.reg.D + base) & 0xFFFF;
    const ptr = this.read(0x00, addr) | 
                (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
    const bank = this.read(0x00, (addr + 2) & 0xFFFF);
    const effectiveAddr = (ptr + this.reg.Y) & 0xFFFF;
    if (this.isM8) {
      this.write(bank, effectiveAddr, this.reg.A & 0xFF);
      this.cycles += 6;
    } else {
      this.write(bank, effectiveAddr, this.reg.A & 0xFF);
      this.write(bank, (effectiveAddr + 1) & 0xFFFF, this.reg.A >> 8);
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private STA_absoluteY(): void {
    // STA abs,Y - $99
    const addr = this.readPC16();
    const effectiveAddr = (addr + this.reg.Y) & 0xFFFF;
    if (this.isM8) {
      this.write(this.reg.DB, effectiveAddr, this.reg.A & 0xFF);
      this.cycles += 5;
    } else {
      this.write(this.reg.DB, effectiveAddr, this.reg.A & 0xFF);
      this.write(this.reg.DB, (effectiveAddr + 1) & 0xFFFF, this.reg.A >> 8);
      this.cycles += 6;
    }
  }

  private STA_absoluteX(): void {
    // STA abs,X - $9D
    const addr = this.readPC16();
    const effectiveAddr = (addr + this.reg.X) & 0xFFFF;
    if (this.isM8) {
      this.write(this.reg.DB, effectiveAddr, this.reg.A & 0xFF);
      this.cycles += 5;
    } else {
      this.write(this.reg.DB, effectiveAddr, this.reg.A & 0xFF);
      this.write(this.reg.DB, (effectiveAddr + 1) & 0xFFFF, this.reg.A >> 8);
      this.cycles += 6;
    }
  }

  private STA_absoluteLongX(): void {
    // STA long,X - $9F
    const addr = this.readPC16();
    const bank = this.readPC();
    const effectiveAddr = (addr + this.reg.X) & 0xFFFF;
    if (this.isM8) {
      this.write(bank, effectiveAddr, this.reg.A & 0xFF);
      this.cycles += 5;
    } else {
      this.write(bank, effectiveAddr, this.reg.A & 0xFF);
      this.write(bank, (effectiveAddr + 1) & 0xFFFF, this.reg.A >> 8);
      this.cycles += 6;
    }
  }

  private STX_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    if (this.isX8) {
      this.write(0x00, addr, this.reg.X);
      this.cycles += 3;
    } else {
      this.write(0x00, addr, this.reg.X & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, this.reg.X >> 8);
      this.cycles += 4;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private STX_absolute(): void {
    const addr = this.readPC16();
    if (this.isX8) {
      this.write(this.reg.DB, addr, this.reg.X);
      this.cycles += 4;
    } else {
      this.write(this.reg.DB, addr, this.reg.X & 0xFF);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, this.reg.X >> 8);
      this.cycles += 5;
    }
  }

  private STY_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    if (this.isX8) {
      this.write(0x00, addr, this.reg.Y);
      this.cycles += 3;
    } else {
      this.write(0x00, addr, this.reg.Y & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, this.reg.Y >> 8);
      this.cycles += 4;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private STY_absolute(): void {
    const addr = this.readPC16();
    if (this.isX8) {
      this.write(this.reg.DB, addr, this.reg.Y);
      this.cycles += 4;
    } else {
      this.write(this.reg.DB, addr, this.reg.Y & 0xFF);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, this.reg.Y >> 8);
      this.cycles += 5;
    }
  }

  private STZ_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    if (this.isM8) {
      this.write(0x00, addr, 0);
      this.cycles += 3;
    } else {
      this.write(0x00, addr, 0);
      this.write(0x00, (addr + 1) & 0xFFFF, 0);
      this.cycles += 4;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private STZ_absolute(): void {
    const addr = this.readPC16();
    if (this.isM8) {
      this.write(this.reg.DB, addr, 0);
      this.cycles += 4;
    } else {
      this.write(this.reg.DB, addr, 0);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, 0);
      this.cycles += 5;
    }
  }

  private STZ_direct_x(): void {
    const addr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    if (this.isM8) {
      this.write(0x00, addr, 0);
      this.cycles += 4;
    } else {
      this.write(0x00, addr, 0);
      this.write(0x00, (addr + 1) & 0xFFFF, 0);
      this.cycles += 5;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private STZ_absolute_x(): void {
    const addr = (this.readPC16() + this.reg.X) & 0xFFFF;
    if (this.isM8) {
      this.write(this.reg.DB, addr, 0);
      this.cycles += 5;
    } else {
      this.write(this.reg.DB, addr, 0);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, 0);
      this.cycles += 6;
    }
  }

  // --- Arithmetic Instructions ---
  
  private ADC_immediate(): void {
    const operand = this.isM8 ? this.readPC() : this.readPC16();
    this.performADC(operand);
    this.cycles += this.isM8 ? 2 : 3;
  }

  private ADC_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(0x00, addr);
      this.cycles += 3;
    } else {
      const low = this.read(0x00, addr);
      const high = this.read(0x00, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 4;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
    this.performADC(operand);
  }

  private ADC_absolute(): void {
    const addr = this.readPC16();
    let operand: number;
    if (this.isM8) {
      operand = this.read(this.reg.DB, addr);
      this.cycles += 4;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 5;
    }
    this.performADC(operand);
  }

  private ADC_absoluteLong(): void {
    const addr = this.readPC16();
    const bank = this.readPC();
    let operand: number;
    if (this.isM8) {
      operand = this.read(bank, addr);
      this.cycles += 5;
    } else {
      const low = this.read(bank, addr);
      const high = this.read(bank, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 6;
    }
    this.performADC(operand);
  }

  private ADC_absoluteLongX(): void {
    const baseAddr = this.readPC16();
    const bank = this.readPC();
    const addr = (baseAddr + this.reg.X) & 0xFFFF;
    const newBank = (bank + ((baseAddr + this.reg.X) >> 16)) & 0xFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(newBank, addr);
      this.cycles += 5;
    } else {
      const low = this.read(newBank, addr);
      const high = this.read(newBank, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 6;
    }
    this.performADC(operand);
  }

  private ADC_directX(): void {
    const addr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(0x00, addr);
      this.cycles += 4;
    } else {
      const low = this.read(0x00, addr);
      const high = this.read(0x00, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 5;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
    this.performADC(operand);
  }

  private ADC_absoluteX(): void {
    const baseAddr = this.readPC16();
    const addr = (baseAddr + this.reg.X) & 0xFFFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(this.reg.DB, addr);
      this.cycles += 4;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 5;
    }
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
    this.performADC(operand);
  }

  private ADC_absoluteY(): void {
    const baseAddr = this.readPC16();
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(this.reg.DB, addr);
      this.cycles += 4;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 5;
    }
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
    this.performADC(operand);
  }

  private ADC_directIndirectX(): void {
    const ptr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    const addr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    let operand: number;
    if (this.isM8) {
      operand = this.read(this.reg.DB, addr);
      this.cycles += 6;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
    this.performADC(operand);
  }

  private ADC_directIndirectY(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const baseAddr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(this.reg.DB, addr);
      this.cycles += 5;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 6;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
    this.performADC(operand);
  }

  private ADC_directIndirect(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    let operand: number;
    if (this.isM8) {
      operand = this.read(this.reg.DB, addr);
      this.cycles += 5;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 6;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
    this.performADC(operand);
  }

  private ADC_directIndirectLong(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addrLow = this.read(0x00, ptr);
    const addrHigh = this.read(0x00, (ptr + 1) & 0xFFFF);
    const bank = this.read(0x00, (ptr + 2) & 0xFFFF);
    const addr = addrLow | (addrHigh << 8);
    let operand: number;
    if (this.isM8) {
      operand = this.read(bank, addr);
      this.cycles += 6;
    } else {
      const low = this.read(bank, addr);
      const high = this.read(bank, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
    this.performADC(operand);
  }

  private ADC_directIndirectLongY(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addrLow = this.read(0x00, ptr);
    const addrHigh = this.read(0x00, (ptr + 1) & 0xFFFF);
    const bank = this.read(0x00, (ptr + 2) & 0xFFFF);
    const baseAddr = addrLow | (addrHigh << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const newBank = (bank + ((baseAddr + this.reg.Y) >> 16)) & 0xFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(newBank, addr);
      this.cycles += 6;
    } else {
      const low = this.read(newBank, addr);
      const high = this.read(newBank, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
    this.performADC(operand);
  }

  private ADC_stackRelative(): void {
    const offset = this.readPC();
    const addr = (this.reg.SP + offset) & 0xFFFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(0x00, addr);
      this.cycles += 4;
    } else {
      const low = this.read(0x00, addr);
      const high = this.read(0x00, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 5;
    }
    this.performADC(operand);
  }

  private ADC_stackRelativeIndirectY(): void {
    const offset = this.readPC();
    const ptr = (this.reg.SP + offset) & 0xFFFF;
    const baseAddr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(this.reg.DB, addr);
      this.cycles += 7;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 8;
    }
    this.performADC(operand);
  }

  private performADC(operand: number): void {
    const carry = this.getFlag(StatusFlag.C) ? 1 : 0;
    
    if (this.isM8) {
      const a = this.reg.A & 0xFF;
      if (this.getFlag(StatusFlag.D)) {
        // Decimal mode
        let lo = (a & 0x0F) + (operand & 0x0F) + carry;
        let hi = (a >> 4) + (operand >> 4);
        if (lo > 9) { lo -= 10; hi++; }
        if (hi > 9) { hi -= 10; this.setFlag(StatusFlag.C, true); }
        else { this.setFlag(StatusFlag.C, false); }
        const result = ((hi << 4) | (lo & 0x0F)) & 0xFF;
        this.reg.A = (this.reg.A & 0xFF00) | result;
      } else {
        // Binary mode
        const result = a + operand + carry;
        this.setFlag(StatusFlag.C, result > 0xFF);
        this.setFlag(StatusFlag.V, ((~(a ^ operand)) & (a ^ result) & 0x80) !== 0);
        this.reg.A = (this.reg.A & 0xFF00) | (result & 0xFF);
      }
      this.updateNZ8(this.reg.A);
    } else {
      if (this.getFlag(StatusFlag.D)) {
        // 16-bit decimal (complex, simplified here)
        const result = this.reg.A + operand + carry;
        this.setFlag(StatusFlag.C, result > 0xFFFF);
        this.reg.A = result & 0xFFFF;
      } else {
        const result = this.reg.A + operand + carry;
        this.setFlag(StatusFlag.C, result > 0xFFFF);
        this.setFlag(StatusFlag.V, ((~(this.reg.A ^ operand)) & (this.reg.A ^ result) & 0x8000) !== 0);
        this.reg.A = result & 0xFFFF;
      }
      this.updateNZ16(this.reg.A);
    }
  }

  private SBC_immediate(): void {
    const operand = this.isM8 ? this.readPC() : this.readPC16();
    this.performSBC(operand);
    this.cycles += this.isM8 ? 2 : 3;
  }

  private SBC_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(0x00, addr);
      this.cycles += 3;
    } else {
      const low = this.read(0x00, addr);
      const high = this.read(0x00, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 4;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
    this.performSBC(operand);
  }

  private SBC_absolute(): void {
    const addr = this.readPC16();
    let operand: number;
    if (this.isM8) {
      operand = this.read(this.reg.DB, addr);
      this.cycles += 4;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 5;
    }
    this.performSBC(operand);
  }

  private SBC_absoluteLong(): void {
    const addr = this.readPC16();
    const bank = this.readPC();
    let operand: number;
    if (this.isM8) {
      operand = this.read(bank, addr);
      this.cycles += 5;
    } else {
      const low = this.read(bank, addr);
      const high = this.read(bank, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 6;
    }
    this.performSBC(operand);
  }

  private SBC_absoluteLongX(): void {
    const baseAddr = this.readPC16();
    const bank = this.readPC();
    const addr = (baseAddr + this.reg.X) & 0xFFFF;
    const newBank = (bank + ((baseAddr + this.reg.X) >> 16)) & 0xFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(newBank, addr);
      this.cycles += 5;
    } else {
      const low = this.read(newBank, addr);
      const high = this.read(newBank, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 6;
    }
    this.performSBC(operand);
  }

  private SBC_directX(): void {
    const addr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(0x00, addr);
      this.cycles += 4;
    } else {
      const low = this.read(0x00, addr);
      const high = this.read(0x00, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 5;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
    this.performSBC(operand);
  }

  private SBC_absoluteX(): void {
    const baseAddr = this.readPC16();
    const addr = (baseAddr + this.reg.X) & 0xFFFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(this.reg.DB, addr);
      this.cycles += 4;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 5;
    }
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
    this.performSBC(operand);
  }

  private SBC_absoluteY(): void {
    const baseAddr = this.readPC16();
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(this.reg.DB, addr);
      this.cycles += 4;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 5;
    }
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
    this.performSBC(operand);
  }

  private SBC_directIndirectX(): void {
    const ptr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    const addr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    let operand: number;
    if (this.isM8) {
      operand = this.read(this.reg.DB, addr);
      this.cycles += 6;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
    this.performSBC(operand);
  }

  private SBC_directIndirectY(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const baseAddr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(this.reg.DB, addr);
      this.cycles += 5;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 6;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
    this.performSBC(operand);
  }

  private SBC_directIndirect(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    let operand: number;
    if (this.isM8) {
      operand = this.read(this.reg.DB, addr);
      this.cycles += 5;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 6;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
    this.performSBC(operand);
  }

  private SBC_directIndirectLong(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addrLow = this.read(0x00, ptr);
    const addrHigh = this.read(0x00, (ptr + 1) & 0xFFFF);
    const bank = this.read(0x00, (ptr + 2) & 0xFFFF);
    const addr = addrLow | (addrHigh << 8);
    let operand: number;
    if (this.isM8) {
      operand = this.read(bank, addr);
      this.cycles += 6;
    } else {
      const low = this.read(bank, addr);
      const high = this.read(bank, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
    this.performSBC(operand);
  }

  private SBC_directIndirectLongY(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addrLow = this.read(0x00, ptr);
    const addrHigh = this.read(0x00, (ptr + 1) & 0xFFFF);
    const bank = this.read(0x00, (ptr + 2) & 0xFFFF);
    const baseAddr = addrLow | (addrHigh << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const newBank = (bank + ((baseAddr + this.reg.Y) >> 16)) & 0xFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(newBank, addr);
      this.cycles += 6;
    } else {
      const low = this.read(newBank, addr);
      const high = this.read(newBank, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
    this.performSBC(operand);
  }

  private SBC_stackRelative(): void {
    const offset = this.readPC();
    const addr = (this.reg.SP + offset) & 0xFFFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(0x00, addr);
      this.cycles += 4;
    } else {
      const low = this.read(0x00, addr);
      const high = this.read(0x00, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 5;
    }
    this.performSBC(operand);
  }

  private SBC_stackRelativeIndirectY(): void {
    const offset = this.readPC();
    const ptr = (this.reg.SP + offset) & 0xFFFF;
    const baseAddr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    let operand: number;
    if (this.isM8) {
      operand = this.read(this.reg.DB, addr);
      this.cycles += 7;
    } else {
      const low = this.read(this.reg.DB, addr);
      const high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      operand = (high << 8) | low;
      this.cycles += 8;
    }
    this.performSBC(operand);
  }

  private performSBC(operand: number): void {
    // SBC is ADC with inverted operand
    this.performADC(this.isM8 ? (operand ^ 0xFF) : (operand ^ 0xFFFF));
  }

  // --- Inc/Dec Instructions ---
  
  private INC_A(): void {
    if (this.isM8) {
      const result = ((this.reg.A & 0xFF) + 1) & 0xFF;
      this.reg.A = (this.reg.A & 0xFF00) | result;
      this.updateNZ8(result);
    } else {
      this.reg.A = (this.reg.A + 1) & 0xFFFF;
      this.updateNZ16(this.reg.A);
    }
    this.cycles += 2;
  }

  private INC_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    if (this.isM8) {
      let value = this.read(0x00, addr);
      value = (value + 1) & 0xFF;
      this.write(0x00, addr, value);
      this.updateNZ8(value);
      this.cycles += 5;
    } else {
      let low = this.read(0x00, addr);
      let high = this.read(0x00, (addr + 1) & 0xFFFF);
      let value = ((high << 8) | low) + 1;
      value &= 0xFFFF;
      this.write(0x00, addr, value & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 6;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private INC_absolute(): void {
    const addr = this.readPC16();
    if (this.isM8) {
      let value = this.read(this.reg.DB, addr);
      value = (value + 1) & 0xFF;
      this.write(this.reg.DB, addr, value);
      this.updateNZ8(value);
      this.cycles += 6;
    } else {
      let low = this.read(this.reg.DB, addr);
      let high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      let value = ((high << 8) | low) + 1;
      value &= 0xFFFF;
      this.write(this.reg.DB, addr, value & 0xFF);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 8;
    }
  }

  private INX(): void {
    if (this.isX8) {
      this.reg.X = (this.reg.X + 1) & 0xFF;
      this.updateNZ8(this.reg.X);
    } else {
      this.reg.X = (this.reg.X + 1) & 0xFFFF;
      this.updateNZ16(this.reg.X);
    }
    this.cycles += 2;
  }

  private INY(): void {
    if (this.isX8) {
      this.reg.Y = (this.reg.Y + 1) & 0xFF;
      this.updateNZ8(this.reg.Y);
    } else {
      this.reg.Y = (this.reg.Y + 1) & 0xFFFF;
      this.updateNZ16(this.reg.Y);
    }
    this.cycles += 2;
  }

  private DEC_A(): void {
    if (this.isM8) {
      const result = ((this.reg.A & 0xFF) - 1) & 0xFF;
      this.reg.A = (this.reg.A & 0xFF00) | result;
      this.updateNZ8(result);
    } else {
      this.reg.A = (this.reg.A - 1) & 0xFFFF;
      this.updateNZ16(this.reg.A);
    }
    this.cycles += 2;
  }

  private DEC_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    if (this.isM8) {
      let value = this.read(0x00, addr);
      value = (value - 1) & 0xFF;
      this.write(0x00, addr, value);
      this.updateNZ8(value);
      this.cycles += 5;
    } else {
      let low = this.read(0x00, addr);
      let high = this.read(0x00, (addr + 1) & 0xFFFF);
      let value = ((high << 8) | low) - 1;
      value &= 0xFFFF;
      this.write(0x00, addr, value & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 6;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private DEC_absolute(): void {
    const addr = this.readPC16();
    if (this.isM8) {
      let value = this.read(this.reg.DB, addr);
      value = (value - 1) & 0xFF;
      this.write(this.reg.DB, addr, value);
      this.updateNZ8(value);
      this.cycles += 6;
    } else {
      let low = this.read(this.reg.DB, addr);
      let high = this.read(this.reg.DB, (addr + 1) & 0xFFFF);
      let value = ((high << 8) | low) - 1;
      value &= 0xFFFF;
      this.write(this.reg.DB, addr, value & 0xFF);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 8;
    }
  }

  private DEX(): void {
    if (this.isX8) {
      this.reg.X = (this.reg.X - 1) & 0xFF;
      this.updateNZ8(this.reg.X);
    } else {
      this.reg.X = (this.reg.X - 1) & 0xFFFF;
      this.updateNZ16(this.reg.X);
    }
    this.cycles += 2;
  }

  private DEY(): void {
    if (this.isX8) {
      this.reg.Y = (this.reg.Y - 1) & 0xFF;
      this.updateNZ8(this.reg.Y);
    } else {
      this.reg.Y = (this.reg.Y - 1) & 0xFFFF;
      this.updateNZ16(this.reg.Y);
    }
    this.cycles += 2;
  }

  // --- Logical Instructions ---
  
  private performAND(operand: number): void {
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | ((this.reg.A & operand) & 0xFF);
      this.updateNZ8(this.reg.A);
    } else {
      this.reg.A = this.reg.A & operand;
      this.updateNZ16(this.reg.A);
    }
  }

  private performORA(operand: number): void {
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | ((this.reg.A | operand) & 0xFF);
      this.updateNZ8(this.reg.A);
    } else {
      this.reg.A = this.reg.A | operand;
      this.updateNZ16(this.reg.A);
    }
  }

  private performEOR(operand: number): void {
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | ((this.reg.A ^ operand) & 0xFF);
      this.updateNZ8(this.reg.A);
    } else {
      this.reg.A = this.reg.A ^ operand;
      this.updateNZ16(this.reg.A);
    }
  }

  private AND_immediate(): void {
    const operand = this.isM8 ? this.readPC() : this.readPC16();
    this.performAND(operand);
    this.cycles += this.isM8 ? 2 : 3;
  }

  private AND_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    const operand = this.isM8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    this.performAND(operand);
    this.cycles += this.isM8 ? 3 : 4;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private AND_absolute(): void {
    const addr = this.readPC16();
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performAND(operand);
    this.cycles += this.isM8 ? 4 : 5;
  }

  private AND_absoluteLong(): void {
    const addr = this.readPC16();
    const bank = this.readPC();
    const operand = this.isM8 ? this.read(bank, addr) : (this.read(bank, addr) | (this.read(bank, (addr + 1) & 0xFFFF) << 8));
    this.performAND(operand);
    this.cycles += this.isM8 ? 5 : 6;
  }

  private AND_absoluteLongX(): void {
    const baseAddr = this.readPC16();
    const bank = this.readPC();
    const addr = (baseAddr + this.reg.X) & 0xFFFF;
    const newBank = (bank + ((baseAddr + this.reg.X) >> 16)) & 0xFF;
    const operand = this.isM8 ? this.read(newBank, addr) : (this.read(newBank, addr) | (this.read(newBank, (addr + 1) & 0xFFFF) << 8));
    this.performAND(operand);
    this.cycles += this.isM8 ? 5 : 6;
  }

  private AND_directX(): void {
    const addr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    const operand = this.isM8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    this.performAND(operand);
    this.cycles += this.isM8 ? 4 : 5;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private AND_absoluteX(): void {
    const baseAddr = this.readPC16();
    const addr = (baseAddr + this.reg.X) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performAND(operand);
    this.cycles += this.isM8 ? 4 : 5;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private AND_absoluteY(): void {
    const baseAddr = this.readPC16();
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performAND(operand);
    this.cycles += this.isM8 ? 4 : 5;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private AND_directIndirectX(): void {
    const ptr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    const addr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performAND(operand);
    this.cycles += this.isM8 ? 6 : 7;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private AND_directIndirectY(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const baseAddr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performAND(operand);
    this.cycles += this.isM8 ? 5 : 6;
    if (this.reg.D & 0xFF) this.cycles += 1;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private AND_directIndirect(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performAND(operand);
    this.cycles += this.isM8 ? 5 : 6;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private AND_directIndirectLong(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addrLow = this.read(0x00, ptr);
    const addrHigh = this.read(0x00, (ptr + 1) & 0xFFFF);
    const bank = this.read(0x00, (ptr + 2) & 0xFFFF);
    const addr = addrLow | (addrHigh << 8);
    const operand = this.isM8 ? this.read(bank, addr) : (this.read(bank, addr) | (this.read(bank, (addr + 1) & 0xFFFF) << 8));
    this.performAND(operand);
    this.cycles += this.isM8 ? 6 : 7;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private AND_directIndirectLongY(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addrLow = this.read(0x00, ptr);
    const addrHigh = this.read(0x00, (ptr + 1) & 0xFFFF);
    const bank = this.read(0x00, (ptr + 2) & 0xFFFF);
    const baseAddr = addrLow | (addrHigh << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const newBank = (bank + ((baseAddr + this.reg.Y) >> 16)) & 0xFF;
    const operand = this.isM8 ? this.read(newBank, addr) : (this.read(newBank, addr) | (this.read(newBank, (addr + 1) & 0xFFFF) << 8));
    this.performAND(operand);
    this.cycles += this.isM8 ? 6 : 7;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private AND_stackRelative(): void {
    const offset = this.readPC();
    const addr = (this.reg.SP + offset) & 0xFFFF;
    const operand = this.isM8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    this.performAND(operand);
    this.cycles += this.isM8 ? 4 : 5;
  }

  private AND_stackRelativeIndirectY(): void {
    const offset = this.readPC();
    const ptr = (this.reg.SP + offset) & 0xFFFF;
    const baseAddr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performAND(operand);
    this.cycles += this.isM8 ? 7 : 8;
  }

  private ORA_immediate(): void {
    const operand = this.isM8 ? this.readPC() : this.readPC16();
    this.performORA(operand);
    this.cycles += this.isM8 ? 2 : 3;
  }

  private ORA_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    const operand = this.isM8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    this.performORA(operand);
    this.cycles += this.isM8 ? 3 : 4;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private ORA_absolute(): void {
    const addr = this.readPC16();
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performORA(operand);
    this.cycles += this.isM8 ? 4 : 5;
  }

  private ORA_absoluteLong(): void {
    const addr = this.readPC16();
    const bank = this.readPC();
    const operand = this.isM8 ? this.read(bank, addr) : (this.read(bank, addr) | (this.read(bank, (addr + 1) & 0xFFFF) << 8));
    this.performORA(operand);
    this.cycles += this.isM8 ? 5 : 6;
  }

  private ORA_absoluteLongX(): void {
    const baseAddr = this.readPC16();
    const bank = this.readPC();
    const addr = (baseAddr + this.reg.X) & 0xFFFF;
    const newBank = (bank + ((baseAddr + this.reg.X) >> 16)) & 0xFF;
    const operand = this.isM8 ? this.read(newBank, addr) : (this.read(newBank, addr) | (this.read(newBank, (addr + 1) & 0xFFFF) << 8));
    this.performORA(operand);
    this.cycles += this.isM8 ? 5 : 6;
  }

  private ORA_directX(): void {
    const addr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    const operand = this.isM8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    this.performORA(operand);
    this.cycles += this.isM8 ? 4 : 5;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private ORA_absoluteX(): void {
    const baseAddr = this.readPC16();
    const addr = (baseAddr + this.reg.X) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performORA(operand);
    this.cycles += this.isM8 ? 4 : 5;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private ORA_absoluteY(): void {
    const baseAddr = this.readPC16();
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performORA(operand);
    this.cycles += this.isM8 ? 4 : 5;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private ORA_directIndirectX(): void {
    const ptr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    const addr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performORA(operand);
    this.cycles += this.isM8 ? 6 : 7;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private ORA_directIndirectY(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const baseAddr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performORA(operand);
    this.cycles += this.isM8 ? 5 : 6;
    if (this.reg.D & 0xFF) this.cycles += 1;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private ORA_directIndirect(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performORA(operand);
    this.cycles += this.isM8 ? 5 : 6;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private ORA_directIndirectLong(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addrLow = this.read(0x00, ptr);
    const addrHigh = this.read(0x00, (ptr + 1) & 0xFFFF);
    const bank = this.read(0x00, (ptr + 2) & 0xFFFF);
    const addr = addrLow | (addrHigh << 8);
    const operand = this.isM8 ? this.read(bank, addr) : (this.read(bank, addr) | (this.read(bank, (addr + 1) & 0xFFFF) << 8));
    this.performORA(operand);
    this.cycles += this.isM8 ? 6 : 7;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private ORA_directIndirectLongY(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addrLow = this.read(0x00, ptr);
    const addrHigh = this.read(0x00, (ptr + 1) & 0xFFFF);
    const bank = this.read(0x00, (ptr + 2) & 0xFFFF);
    const baseAddr = addrLow | (addrHigh << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const newBank = (bank + ((baseAddr + this.reg.Y) >> 16)) & 0xFF;
    const operand = this.isM8 ? this.read(newBank, addr) : (this.read(newBank, addr) | (this.read(newBank, (addr + 1) & 0xFFFF) << 8));
    this.performORA(operand);
    this.cycles += this.isM8 ? 6 : 7;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private ORA_stackRelative(): void {
    const offset = this.readPC();
    const addr = (this.reg.SP + offset) & 0xFFFF;
    const operand = this.isM8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    this.performORA(operand);
    this.cycles += this.isM8 ? 4 : 5;
  }

  private ORA_stackRelativeIndirectY(): void {
    const offset = this.readPC();
    const ptr = (this.reg.SP + offset) & 0xFFFF;
    const baseAddr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performORA(operand);
    this.cycles += this.isM8 ? 7 : 8;
  }

  private EOR_immediate(): void {
    const operand = this.isM8 ? this.readPC() : this.readPC16();
    this.performEOR(operand);
    this.cycles += this.isM8 ? 2 : 3;
  }

  private EOR_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    const operand = this.isM8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    this.performEOR(operand);
    this.cycles += this.isM8 ? 3 : 4;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private EOR_absolute(): void {
    const addr = this.readPC16();
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performEOR(operand);
    this.cycles += this.isM8 ? 4 : 5;
  }

  private EOR_absoluteLong(): void {
    const addr = this.readPC16();
    const bank = this.readPC();
    const operand = this.isM8 ? this.read(bank, addr) : (this.read(bank, addr) | (this.read(bank, (addr + 1) & 0xFFFF) << 8));
    this.performEOR(operand);
    this.cycles += this.isM8 ? 5 : 6;
  }

  private EOR_absoluteLongX(): void {
    const baseAddr = this.readPC16();
    const bank = this.readPC();
    const addr = (baseAddr + this.reg.X) & 0xFFFF;
    const newBank = (bank + ((baseAddr + this.reg.X) >> 16)) & 0xFF;
    const operand = this.isM8 ? this.read(newBank, addr) : (this.read(newBank, addr) | (this.read(newBank, (addr + 1) & 0xFFFF) << 8));
    this.performEOR(operand);
    this.cycles += this.isM8 ? 5 : 6;
  }

  private EOR_directX(): void {
    const addr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    const operand = this.isM8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    this.performEOR(operand);
    this.cycles += this.isM8 ? 4 : 5;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private EOR_absoluteX(): void {
    const baseAddr = this.readPC16();
    const addr = (baseAddr + this.reg.X) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performEOR(operand);
    this.cycles += this.isM8 ? 4 : 5;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private EOR_absoluteY(): void {
    const baseAddr = this.readPC16();
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performEOR(operand);
    this.cycles += this.isM8 ? 4 : 5;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private EOR_directIndirectX(): void {
    const ptr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    const addr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performEOR(operand);
    this.cycles += this.isM8 ? 6 : 7;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private EOR_directIndirectY(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const baseAddr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performEOR(operand);
    this.cycles += this.isM8 ? 5 : 6;
    if (this.reg.D & 0xFF) this.cycles += 1;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private EOR_directIndirect(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performEOR(operand);
    this.cycles += this.isM8 ? 5 : 6;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private EOR_directIndirectLong(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addrLow = this.read(0x00, ptr);
    const addrHigh = this.read(0x00, (ptr + 1) & 0xFFFF);
    const bank = this.read(0x00, (ptr + 2) & 0xFFFF);
    const addr = addrLow | (addrHigh << 8);
    const operand = this.isM8 ? this.read(bank, addr) : (this.read(bank, addr) | (this.read(bank, (addr + 1) & 0xFFFF) << 8));
    this.performEOR(operand);
    this.cycles += this.isM8 ? 6 : 7;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private EOR_directIndirectLongY(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addrLow = this.read(0x00, ptr);
    const addrHigh = this.read(0x00, (ptr + 1) & 0xFFFF);
    const bank = this.read(0x00, (ptr + 2) & 0xFFFF);
    const baseAddr = addrLow | (addrHigh << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const newBank = (bank + ((baseAddr + this.reg.Y) >> 16)) & 0xFF;
    const operand = this.isM8 ? this.read(newBank, addr) : (this.read(newBank, addr) | (this.read(newBank, (addr + 1) & 0xFFFF) << 8));
    this.performEOR(operand);
    this.cycles += this.isM8 ? 6 : 7;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private EOR_stackRelative(): void {
    const offset = this.readPC();
    const addr = (this.reg.SP + offset) & 0xFFFF;
    const operand = this.isM8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    this.performEOR(operand);
    this.cycles += this.isM8 ? 4 : 5;
  }

  private EOR_stackRelativeIndirectY(): void {
    const offset = this.readPC();
    const ptr = (this.reg.SP + offset) & 0xFFFF;
    const baseAddr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performEOR(operand);
    this.cycles += this.isM8 ? 7 : 8;
  }

  // --- Compare Instructions ---
  
  private performCMP(register: number, operand: number, is8bit: boolean): void {
    if (is8bit) {
      const result = (register & 0xFF) - operand;
      this.setFlag(StatusFlag.C, (register & 0xFF) >= operand);
      this.updateNZ8(result & 0xFF);
    } else {
      const result = register - operand;
      this.setFlag(StatusFlag.C, register >= operand);
      this.updateNZ16(result & 0xFFFF);
    }
  }

  private CMP_immediate(): void {
    const operand = this.isM8 ? this.readPC() : this.readPC16();
    this.performCMP(this.reg.A, operand, this.isM8);
    this.cycles += this.isM8 ? 2 : 3;
  }

  private CMP_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    const operand = this.isM8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.A, operand, this.isM8);
    this.cycles += this.isM8 ? 3 : 4;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private CMP_absolute(): void {
    const addr = this.readPC16();
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.A, operand, this.isM8);
    this.cycles += this.isM8 ? 4 : 5;
  }

  private CMP_absoluteLong(): void {
    const addr = this.readPC16();
    const bank = this.readPC();
    const operand = this.isM8 ? this.read(bank, addr) : (this.read(bank, addr) | (this.read(bank, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.A, operand, this.isM8);
    this.cycles += this.isM8 ? 5 : 6;
  }

  private CMP_absoluteLongX(): void {
    const baseAddr = this.readPC16();
    const bank = this.readPC();
    const addr = (baseAddr + this.reg.X) & 0xFFFF;
    const newBank = (bank + ((baseAddr + this.reg.X) >> 16)) & 0xFF;
    const operand = this.isM8 ? this.read(newBank, addr) : (this.read(newBank, addr) | (this.read(newBank, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.A, operand, this.isM8);
    this.cycles += this.isM8 ? 5 : 6;
  }

  private CMP_directX(): void {
    const addr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    const operand = this.isM8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.A, operand, this.isM8);
    this.cycles += this.isM8 ? 4 : 5;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private CMP_absoluteX(): void {
    const baseAddr = this.readPC16();
    const addr = (baseAddr + this.reg.X) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.A, operand, this.isM8);
    this.cycles += this.isM8 ? 4 : 5;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private CMP_absoluteY(): void {
    const baseAddr = this.readPC16();
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.A, operand, this.isM8);
    this.cycles += this.isM8 ? 4 : 5;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private CMP_directIndirectX(): void {
    const ptr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    const addr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.A, operand, this.isM8);
    this.cycles += this.isM8 ? 6 : 7;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private CMP_directIndirectY(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const baseAddr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.A, operand, this.isM8);
    this.cycles += this.isM8 ? 5 : 6;
    if (this.reg.D & 0xFF) this.cycles += 1;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private CMP_directIndirect(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.A, operand, this.isM8);
    this.cycles += this.isM8 ? 5 : 6;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private CMP_directIndirectLong(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addrLow = this.read(0x00, ptr);
    const addrHigh = this.read(0x00, (ptr + 1) & 0xFFFF);
    const bank = this.read(0x00, (ptr + 2) & 0xFFFF);
    const addr = addrLow | (addrHigh << 8);
    const operand = this.isM8 ? this.read(bank, addr) : (this.read(bank, addr) | (this.read(bank, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.A, operand, this.isM8);
    this.cycles += this.isM8 ? 6 : 7;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private CMP_directIndirectLongY(): void {
    const ptr = (this.reg.D + this.readPC()) & 0xFFFF;
    const addrLow = this.read(0x00, ptr);
    const addrHigh = this.read(0x00, (ptr + 1) & 0xFFFF);
    const bank = this.read(0x00, (ptr + 2) & 0xFFFF);
    const baseAddr = addrLow | (addrHigh << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const newBank = (bank + ((baseAddr + this.reg.Y) >> 16)) & 0xFF;
    const operand = this.isM8 ? this.read(newBank, addr) : (this.read(newBank, addr) | (this.read(newBank, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.A, operand, this.isM8);
    this.cycles += this.isM8 ? 6 : 7;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private CMP_stackRelative(): void {
    const offset = this.readPC();
    const addr = (this.reg.SP + offset) & 0xFFFF;
    const operand = this.isM8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.A, operand, this.isM8);
    this.cycles += this.isM8 ? 4 : 5;
  }

  private CMP_stackRelativeIndirectY(): void {
    const offset = this.readPC();
    const ptr = (this.reg.SP + offset) & 0xFFFF;
    const baseAddr = this.read(0x00, ptr) | (this.read(0x00, (ptr + 1) & 0xFFFF) << 8);
    const addr = (baseAddr + this.reg.Y) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.A, operand, this.isM8);
    this.cycles += this.isM8 ? 7 : 8;
  }

  private CPX_immediate(): void {
    const operand = this.isX8 ? this.readPC() : this.readPC16();
    this.performCMP(this.reg.X, operand, this.isX8);
    this.cycles += this.isX8 ? 2 : 3;
  }

  private CPX_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    const operand = this.isX8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.X, operand, this.isX8);
    this.cycles += this.isX8 ? 3 : 4;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private CPX_absolute(): void {
    const addr = this.readPC16();
    const operand = this.isX8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.X, operand, this.isX8);
    this.cycles += this.isX8 ? 4 : 5;
  }

  private CPY_immediate(): void {
    const operand = this.isX8 ? this.readPC() : this.readPC16();
    this.performCMP(this.reg.Y, operand, this.isX8);
    this.cycles += this.isX8 ? 2 : 3;
  }

  private CPY_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    const operand = this.isX8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.Y, operand, this.isX8);
    this.cycles += this.isX8 ? 3 : 4;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private CPY_absolute(): void {
    const addr = this.readPC16();
    const operand = this.isX8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    this.performCMP(this.reg.Y, operand, this.isX8);
    this.cycles += this.isX8 ? 4 : 5;
  }

  // --- Branch Instructions ---
  
  private branch(condition: boolean): void {
    const offset = this.readPC();
    if (condition) {
      const signedOffset = offset > 127 ? offset - 256 : offset;
      const oldPC = this.reg.PC;
      this.reg.PC = (this.reg.PC + signedOffset) & 0xFFFF;
      this.cycles += 1; // Branch taken
      if ((oldPC & 0xFF00) !== (this.reg.PC & 0xFF00)) {
        this.cycles += 1; // Page crossed
      }
    }
    this.cycles += 2;
  }

  private BPL(): void { this.branch(!this.getFlag(StatusFlag.N)); }
  private BMI(): void { this.branch(this.getFlag(StatusFlag.N)); }
  private BVC(): void { this.branch(!this.getFlag(StatusFlag.V)); }
  private BVS(): void { this.branch(this.getFlag(StatusFlag.V)); }
  private BCC(): void { this.branch(!this.getFlag(StatusFlag.C)); }
  private BCS(): void { this.branch(this.getFlag(StatusFlag.C)); }
  private BNE(): void { this.branch(!this.getFlag(StatusFlag.Z)); }
  private BEQ(): void { this.branch(this.getFlag(StatusFlag.Z)); }
  private BRA(): void { this.branch(true); }
  
  private BRL(): void {
    const offset = this.readPC16();
    const signedOffset = offset > 32767 ? offset - 65536 : offset;
    this.reg.PC = (this.reg.PC + signedOffset) & 0xFFFF;
    this.cycles += 4;
  }

  // --- Jump/Call Instructions ---
  
  private JMP_absolute(): void {
    this.reg.PC = this.readPC16();
    this.cycles += 3;
  }

  private JMP_absoluteLong(): void {
    const low = this.readPC();
    const high = this.readPC();
    const bank = this.readPC();
    this.reg.PC = (high << 8) | low;
    this.reg.PB = bank;
    this.cycles += 4;
  }

  private JMP_indirect(): void {
    const addr = this.readPC16();
    const low = this.read(0x00, addr);
    const high = this.read(0x00, (addr + 1) & 0xFFFF);
    this.reg.PC = (high << 8) | low;
    this.cycles += 5;
  }

  private JMP_indexedIndirect(): void {
    const addr = (this.readPC16() + this.reg.X) & 0xFFFF;
    const low = this.read(this.reg.PB, addr);
    const high = this.read(this.reg.PB, (addr + 1) & 0xFFFF);
    this.reg.PC = (high << 8) | low;
    this.cycles += 6;
  }

  private JSR_absolute(): void {
    const addr = this.readPC16();
    this.pushWord(this.reg.PC - 1);
    this.reg.PC = addr;
    this.cycles += 6;
  }

  private JSR_absoluteX(): void {
    // JSR (abs,X) - Jump to Subroutine Indexed Indirect
    const baseAddr = this.readPC16();
    this.pushWord(this.reg.PC - 1);
    const effectiveAddr = (baseAddr + this.reg.X) & 0xFFFF;
    const low = this.read(this.reg.PB, effectiveAddr);
    const high = this.read(this.reg.PB, (effectiveAddr + 1) & 0xFFFF);
    this.reg.PC = (high << 8) | low;
    this.cycles += 8;
  }

  private JSL_absoluteLong(): void {
    const addr = this.readPC16();
    const bank = this.readPC();
    this.pushByte(this.reg.PB);
    this.pushWord(this.reg.PC - 1);
    this.reg.PB = bank;
    this.reg.PC = addr;
    this.cycles += 8;
  }

  private RTS(): void {
    this.reg.PC = (this.pullWord() + 1) & 0xFFFF;
    this.cycles += 6;
  }

  private RTL(): void {
    this.reg.PC = (this.pullWord() + 1) & 0xFFFF;
    this.reg.PB = this.pullByte();
    this.cycles += 6;
  }

  private RTI(): void {
    this.reg.P = this.pullByte();
    this.reg.PC = this.pullWord();
    if (!this.reg.E) {
      this.reg.PB = this.pullByte();
    }
    this.cycles += this.reg.E ? 6 : 7;
  }

  // --- Stack Instructions ---
  
  private PHA(): void {
    if (this.isM8) {
      this.pushByte(this.reg.A & 0xFF);
      this.cycles += 3;
    } else {
      this.pushWord(this.reg.A);
      this.cycles += 4;
    }
  }

  private PLA(): void {
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | this.pullByte();
      this.updateNZ8(this.reg.A);
      this.cycles += 4;
    } else {
      this.reg.A = this.pullWord();
      this.updateNZ16(this.reg.A);
      this.cycles += 5;
    }
  }

  private PHX(): void {
    if (this.isX8) {
      this.pushByte(this.reg.X);
      this.cycles += 3;
    } else {
      this.pushWord(this.reg.X);
      this.cycles += 4;
    }
  }

  private PLX(): void {
    if (this.isX8) {
      this.reg.X = this.pullByte();
      this.updateNZ8(this.reg.X);
      this.cycles += 4;
    } else {
      this.reg.X = this.pullWord();
      this.updateNZ16(this.reg.X);
      this.cycles += 5;
    }
  }

  private PHY(): void {
    if (this.isX8) {
      this.pushByte(this.reg.Y);
      this.cycles += 3;
    } else {
      this.pushWord(this.reg.Y);
      this.cycles += 4;
    }
  }

  private PLY(): void {
    if (this.isX8) {
      this.reg.Y = this.pullByte();
      this.updateNZ8(this.reg.Y);
      this.cycles += 4;
    } else {
      this.reg.Y = this.pullWord();
      this.updateNZ16(this.reg.Y);
      this.cycles += 5;
    }
  }

  private PHP(): void {
    this.pushByte(this.reg.P);
    this.cycles += 3;
  }

  private PLP(): void {
    this.reg.P = this.pullByte();
    if (this.reg.E) {
      // In emulation mode, M and X are always 1
      this.reg.P |= StatusFlag.M | StatusFlag.X;
    }
    this.cycles += 4;
  }

  private PHB(): void {
    this.pushByte(this.reg.DB);
    this.cycles += 3;
  }

  private PLB(): void {
    this.reg.DB = this.pullByte();
    this.updateNZ8(this.reg.DB);
    this.cycles += 4;
  }

  private PHD(): void {
    this.pushWord(this.reg.D);
    this.cycles += 4;
  }

  private PLD(): void {
    this.reg.D = this.pullWord();
    this.updateNZ16(this.reg.D);
    this.cycles += 5;
  }

  private PHK(): void {
    this.pushByte(this.reg.PB);
    this.cycles += 3;
  }

  // PEA - Push Effective Absolute Address ($F4)
  // Always pushes 16-bit value regardless of register sizes
  private PEA(): void {
    const addr = this.readPC16();
    this.pushWord(addr);
    this.cycles += 5;
  }

  // PEI - Push Effective Indirect Address ($D4)
  // Pushes the 16-bit value at the direct page address
  private PEI(): void {
    const dp = this.readPC();
    const addr = (this.reg.D + dp) & 0xFFFF;
    const low = this.read(0x00, addr);
    const high = this.read(0x00, (addr + 1) & 0xFFFF);
    this.pushWord((high << 8) | low);
    this.cycles += 6;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  // PER - Push Effective Relative Address ($62)
  // Pushes PC + signed offset (for position-independent code)
  private PER(): void {
    const offset = this.readPC16();
    // Offset is treated as signed 16-bit
    const effectiveAddr = (this.reg.PC + ((offset << 16) >> 16)) & 0xFFFF;
    this.pushWord(effectiveAddr);
    this.cycles += 6;
  }

  // --- Transfer Instructions ---
  
  private TAX(): void {
    if (this.isX8) {
      this.reg.X = this.reg.A & 0xFF;
      this.updateNZ8(this.reg.X);
    } else {
      this.reg.X = this.reg.A;
      this.updateNZ16(this.reg.X);
    }
    this.cycles += 2;
  }

  private TAY(): void {
    if (this.isX8) {
      this.reg.Y = this.reg.A & 0xFF;
      this.updateNZ8(this.reg.Y);
    } else {
      this.reg.Y = this.reg.A;
      this.updateNZ16(this.reg.Y);
    }
    this.cycles += 2;
  }

  private TXA(): void {
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | (this.reg.X & 0xFF);
      this.updateNZ8(this.reg.A);
    } else {
      this.reg.A = this.reg.X;
      this.updateNZ16(this.reg.A);
    }
    this.cycles += 2;
  }

  private TYA(): void {
    if (this.isM8) {
      this.reg.A = (this.reg.A & 0xFF00) | (this.reg.Y & 0xFF);
      this.updateNZ8(this.reg.A);
    } else {
      this.reg.A = this.reg.Y;
      this.updateNZ16(this.reg.A);
    }
    this.cycles += 2;
  }

  private TSX(): void {
    if (this.isX8) {
      this.reg.X = this.reg.SP & 0xFF;
      this.updateNZ8(this.reg.X);
    } else {
      this.reg.X = this.reg.SP;
      this.updateNZ16(this.reg.X);
    }
    this.cycles += 2;
  }

  private TXS(): void {
    if (this.reg.E) {
      this.reg.SP = 0x0100 | (this.reg.X & 0xFF);
    } else {
      this.reg.SP = this.reg.X;
    }
    this.cycles += 2;
  }

  private TXY(): void {
    this.reg.Y = this.reg.X;
    if (this.isX8) {
      this.updateNZ8(this.reg.Y);
    } else {
      this.updateNZ16(this.reg.Y);
    }
    this.cycles += 2;
  }

  private TYX(): void {
    this.reg.X = this.reg.Y;
    if (this.isX8) {
      this.updateNZ8(this.reg.X);
    } else {
      this.updateNZ16(this.reg.X);
    }
    this.cycles += 2;
  }

  private TCD(): void {
    this.reg.D = this.reg.A;
    this.updateNZ16(this.reg.D);
    this.cycles += 2;
  }

  private TDC(): void {
    this.reg.A = this.reg.D;
    this.updateNZ16(this.reg.A);
    this.cycles += 2;
  }

  private TCS(): void {
    if (this.reg.E) {
      this.reg.SP = 0x0100 | (this.reg.A & 0xFF);
    } else {
      this.reg.SP = this.reg.A;
    }
    this.cycles += 2;
  }

  private TSC(): void {
    this.reg.A = this.reg.SP;
    this.updateNZ16(this.reg.A);
    this.cycles += 2;
  }

  // --- Flag Instructions ---
  
  private CLC(): void { this.setFlag(StatusFlag.C, false); this.cycles += 2; }
  private SEC(): void { this.setFlag(StatusFlag.C, true); this.cycles += 2; }
  private CLI(): void { this.setFlag(StatusFlag.I, false); this.cycles += 2; }
  private SEI(): void { this.setFlag(StatusFlag.I, true); this.cycles += 2; }
  private CLD(): void { this.setFlag(StatusFlag.D, false); this.cycles += 2; }
  private SED(): void { this.setFlag(StatusFlag.D, true); this.cycles += 2; }
  private CLV(): void { this.setFlag(StatusFlag.V, false); this.cycles += 2; }

  private REP(): void {
    const mask = this.readPC();
    this.reg.P &= ~mask;
    if (this.reg.E) {
      this.reg.P |= StatusFlag.M | StatusFlag.X;
    }
    this.cycles += 3;
  }

  private SEP(): void {
    const mask = this.readPC();
    this.reg.P |= mask;
    if (this.getFlag(StatusFlag.X)) {
      this.reg.X &= 0xFF;
      this.reg.Y &= 0xFF;
    }
    this.cycles += 3;
  }

  private XCE(): void {
    const oldE = this.reg.E;
    const oldC = this.getFlag(StatusFlag.C);
    this.reg.E = oldC;
    this.setFlag(StatusFlag.C, oldE);
    
    if (this.reg.E) {
      // Entering emulation mode
      this.reg.P |= StatusFlag.M | StatusFlag.X;
      this.reg.X &= 0xFF;
      this.reg.Y &= 0xFF;
      this.reg.SP = 0x0100 | (this.reg.SP & 0xFF);
    }
    this.cycles += 2;
  }

  // --- Shift/Rotate Instructions ---
  
  private ASL_A(): void {
    if (this.isM8) {
      const result = (this.reg.A & 0xFF) << 1;
      this.setFlag(StatusFlag.C, (this.reg.A & 0x80) !== 0);
      this.reg.A = (this.reg.A & 0xFF00) | (result & 0xFF);
      this.updateNZ8(result & 0xFF);
    } else {
      const result = this.reg.A << 1;
      this.setFlag(StatusFlag.C, (this.reg.A & 0x8000) !== 0);
      this.reg.A = result & 0xFFFF;
      this.updateNZ16(this.reg.A);
    }
    this.cycles += 2;
  }

  private ASL_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    if (this.isM8) {
      let value = this.read(0x00, addr);
      this.setFlag(StatusFlag.C, (value & 0x80) !== 0);
      value = (value << 1) & 0xFF;
      this.write(0x00, addr, value);
      this.updateNZ8(value);
      this.cycles += 5;
    } else {
      let value = this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x8000) !== 0);
      value = (value << 1) & 0xFFFF;
      this.write(0x00, addr, value & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 6;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private ASL_absolute(): void {
    const addr = this.readPC16();
    if (this.isM8) {
      let value = this.read(this.reg.DB, addr);
      this.setFlag(StatusFlag.C, (value & 0x80) !== 0);
      value = (value << 1) & 0xFF;
      this.write(this.reg.DB, addr, value);
      this.updateNZ8(value);
      this.cycles += 6;
    } else {
      let value = this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x8000) !== 0);
      value = (value << 1) & 0xFFFF;
      this.write(this.reg.DB, addr, value & 0xFF);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 7;
    }
  }

  private ASL_directX(): void {
    const addr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    if (this.isM8) {
      let value = this.read(0x00, addr);
      this.setFlag(StatusFlag.C, (value & 0x80) !== 0);
      value = (value << 1) & 0xFF;
      this.write(0x00, addr, value);
      this.updateNZ8(value);
      this.cycles += 6;
    } else {
      let value = this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x8000) !== 0);
      value = (value << 1) & 0xFFFF;
      this.write(0x00, addr, value & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private ASL_absoluteX(): void {
    const addr = (this.readPC16() + this.reg.X) & 0xFFFF;
    if (this.isM8) {
      let value = this.read(this.reg.DB, addr);
      this.setFlag(StatusFlag.C, (value & 0x80) !== 0);
      value = (value << 1) & 0xFF;
      this.write(this.reg.DB, addr, value);
      this.updateNZ8(value);
      this.cycles += 7;
    } else {
      let value = this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x8000) !== 0);
      value = (value << 1) & 0xFFFF;
      this.write(this.reg.DB, addr, value & 0xFF);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 8;
    }
  }

  private LSR_A(): void {
    if (this.isM8) {
      this.setFlag(StatusFlag.C, (this.reg.A & 0x01) !== 0);
      const result = (this.reg.A & 0xFF) >> 1;
      this.reg.A = (this.reg.A & 0xFF00) | result;
      this.updateNZ8(result);
    } else {
      this.setFlag(StatusFlag.C, (this.reg.A & 0x01) !== 0);
      this.reg.A = this.reg.A >> 1;
      this.updateNZ16(this.reg.A);
    }
    this.cycles += 2;
  }

  private LSR_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    if (this.isM8) {
      let value = this.read(0x00, addr);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = value >> 1;
      this.write(0x00, addr, value);
      this.updateNZ8(value);
      this.cycles += 5;
    } else {
      let value = this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = value >> 1;
      this.write(0x00, addr, value & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 6;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private LSR_absolute(): void {
    const addr = this.readPC16();
    if (this.isM8) {
      let value = this.read(this.reg.DB, addr);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = value >> 1;
      this.write(this.reg.DB, addr, value);
      this.updateNZ8(value);
      this.cycles += 6;
    } else {
      let value = this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = value >> 1;
      this.write(this.reg.DB, addr, value & 0xFF);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 7;
    }
  }

  private LSR_directX(): void {
    const addr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    if (this.isM8) {
      let value = this.read(0x00, addr);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = value >> 1;
      this.write(0x00, addr, value);
      this.updateNZ8(value);
      this.cycles += 6;
    } else {
      let value = this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = value >> 1;
      this.write(0x00, addr, value & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private LSR_absoluteX(): void {
    const addr = (this.readPC16() + this.reg.X) & 0xFFFF;
    if (this.isM8) {
      let value = this.read(this.reg.DB, addr);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = value >> 1;
      this.write(this.reg.DB, addr, value);
      this.updateNZ8(value);
      this.cycles += 7;
    } else {
      let value = this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = value >> 1;
      this.write(this.reg.DB, addr, value & 0xFF);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 8;
    }
  }

  private ROL_A(): void {
    const carry = this.getFlag(StatusFlag.C) ? 1 : 0;
    if (this.isM8) {
      this.setFlag(StatusFlag.C, (this.reg.A & 0x80) !== 0);
      const result = ((this.reg.A & 0xFF) << 1) | carry;
      this.reg.A = (this.reg.A & 0xFF00) | (result & 0xFF);
      this.updateNZ8(result & 0xFF);
    } else {
      this.setFlag(StatusFlag.C, (this.reg.A & 0x8000) !== 0);
      this.reg.A = ((this.reg.A << 1) | carry) & 0xFFFF;
      this.updateNZ16(this.reg.A);
    }
    this.cycles += 2;
  }

  private ROL_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    const carry = this.getFlag(StatusFlag.C) ? 1 : 0;
    if (this.isM8) {
      let value = this.read(0x00, addr);
      this.setFlag(StatusFlag.C, (value & 0x80) !== 0);
      value = ((value << 1) | carry) & 0xFF;
      this.write(0x00, addr, value);
      this.updateNZ8(value);
      this.cycles += 5;
    } else {
      let value = this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x8000) !== 0);
      value = ((value << 1) | carry) & 0xFFFF;
      this.write(0x00, addr, value & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 6;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private ROL_absolute(): void {
    const addr = this.readPC16();
    const carry = this.getFlag(StatusFlag.C) ? 1 : 0;
    if (this.isM8) {
      let value = this.read(this.reg.DB, addr);
      this.setFlag(StatusFlag.C, (value & 0x80) !== 0);
      value = ((value << 1) | carry) & 0xFF;
      this.write(this.reg.DB, addr, value);
      this.updateNZ8(value);
      this.cycles += 6;
    } else {
      let value = this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x8000) !== 0);
      value = ((value << 1) | carry) & 0xFFFF;
      this.write(this.reg.DB, addr, value & 0xFF);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 7;
    }
  }

  private ROL_directX(): void {
    const addr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    const carry = this.getFlag(StatusFlag.C) ? 1 : 0;
    if (this.isM8) {
      let value = this.read(0x00, addr);
      this.setFlag(StatusFlag.C, (value & 0x80) !== 0);
      value = ((value << 1) | carry) & 0xFF;
      this.write(0x00, addr, value);
      this.updateNZ8(value);
      this.cycles += 6;
    } else {
      let value = this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x8000) !== 0);
      value = ((value << 1) | carry) & 0xFFFF;
      this.write(0x00, addr, value & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private ROL_absoluteX(): void {
    const addr = (this.readPC16() + this.reg.X) & 0xFFFF;
    const carry = this.getFlag(StatusFlag.C) ? 1 : 0;
    if (this.isM8) {
      let value = this.read(this.reg.DB, addr);
      this.setFlag(StatusFlag.C, (value & 0x80) !== 0);
      value = ((value << 1) | carry) & 0xFF;
      this.write(this.reg.DB, addr, value);
      this.updateNZ8(value);
      this.cycles += 7;
    } else {
      let value = this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x8000) !== 0);
      value = ((value << 1) | carry) & 0xFFFF;
      this.write(this.reg.DB, addr, value & 0xFF);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 8;
    }
  }

  private ROR_A(): void {
    const carry = this.getFlag(StatusFlag.C) ? (this.isM8 ? 0x80 : 0x8000) : 0;
    if (this.isM8) {
      this.setFlag(StatusFlag.C, (this.reg.A & 0x01) !== 0);
      const result = ((this.reg.A & 0xFF) >> 1) | carry;
      this.reg.A = (this.reg.A & 0xFF00) | result;
      this.updateNZ8(result);
    } else {
      this.setFlag(StatusFlag.C, (this.reg.A & 0x01) !== 0);
      this.reg.A = (this.reg.A >> 1) | carry;
      this.updateNZ16(this.reg.A);
    }
    this.cycles += 2;
  }

  private ROR_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    const carry = this.getFlag(StatusFlag.C) ? (this.isM8 ? 0x80 : 0x8000) : 0;
    if (this.isM8) {
      let value = this.read(0x00, addr);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = (value >> 1) | carry;
      this.write(0x00, addr, value);
      this.updateNZ8(value);
      this.cycles += 5;
    } else {
      let value = this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = (value >> 1) | carry;
      this.write(0x00, addr, value & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 6;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private ROR_absolute(): void {
    const addr = this.readPC16();
    const carry = this.getFlag(StatusFlag.C) ? (this.isM8 ? 0x80 : 0x8000) : 0;
    if (this.isM8) {
      let value = this.read(this.reg.DB, addr);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = (value >> 1) | carry;
      this.write(this.reg.DB, addr, value);
      this.updateNZ8(value);
      this.cycles += 6;
    } else {
      let value = this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = (value >> 1) | carry;
      this.write(this.reg.DB, addr, value & 0xFF);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 7;
    }
  }

  private ROR_directX(): void {
    const addr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    const carry = this.getFlag(StatusFlag.C) ? (this.isM8 ? 0x80 : 0x8000) : 0;
    if (this.isM8) {
      let value = this.read(0x00, addr);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = (value >> 1) | carry;
      this.write(0x00, addr, value);
      this.updateNZ8(value);
      this.cycles += 6;
    } else {
      let value = this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = (value >> 1) | carry;
      this.write(0x00, addr, value & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 7;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private ROR_absoluteX(): void {
    const addr = (this.readPC16() + this.reg.X) & 0xFFFF;
    const carry = this.getFlag(StatusFlag.C) ? (this.isM8 ? 0x80 : 0x8000) : 0;
    if (this.isM8) {
      let value = this.read(this.reg.DB, addr);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = (value >> 1) | carry;
      this.write(this.reg.DB, addr, value);
      this.updateNZ8(value);
      this.cycles += 7;
    } else {
      let value = this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.C, (value & 0x01) !== 0);
      value = (value >> 1) | carry;
      this.write(this.reg.DB, addr, value & 0xFF);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, value >> 8);
      this.updateNZ16(value);
      this.cycles += 8;
    }
  }

  // --- Bit Instructions ---
  
  private BIT_immediate(): void {
    const operand = this.isM8 ? this.readPC() : this.readPC16();
    const result = (this.isM8 ? (this.reg.A & 0xFF) : this.reg.A) & operand;
    this.setFlag(StatusFlag.Z, result === 0);
    // Note: BIT immediate does NOT affect N and V flags
    this.cycles += this.isM8 ? 2 : 3;
  }

  private BIT_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    const operand = this.isM8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    const result = (this.isM8 ? (this.reg.A & 0xFF) : this.reg.A) & operand;
    this.setFlag(StatusFlag.Z, result === 0);
    if (this.isM8) {
      this.setFlag(StatusFlag.N, (operand & 0x80) !== 0);
      this.setFlag(StatusFlag.V, (operand & 0x40) !== 0);
    } else {
      this.setFlag(StatusFlag.N, (operand & 0x8000) !== 0);
      this.setFlag(StatusFlag.V, (operand & 0x4000) !== 0);
    }
    this.cycles += this.isM8 ? 3 : 4;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private BIT_absolute(): void {
    const addr = this.readPC16();
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    const result = (this.isM8 ? (this.reg.A & 0xFF) : this.reg.A) & operand;
    this.setFlag(StatusFlag.Z, result === 0);
    if (this.isM8) {
      this.setFlag(StatusFlag.N, (operand & 0x80) !== 0);
      this.setFlag(StatusFlag.V, (operand & 0x40) !== 0);
    } else {
      this.setFlag(StatusFlag.N, (operand & 0x8000) !== 0);
      this.setFlag(StatusFlag.V, (operand & 0x4000) !== 0);
    }
    this.cycles += this.isM8 ? 4 : 5;
  }

  private BIT_directX(): void {
    const addr = (this.reg.D + this.readPC() + this.reg.X) & 0xFFFF;
    const operand = this.isM8 ? this.read(0x00, addr) : (this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8));
    const result = (this.isM8 ? (this.reg.A & 0xFF) : this.reg.A) & operand;
    this.setFlag(StatusFlag.Z, result === 0);
    if (this.isM8) {
      this.setFlag(StatusFlag.N, (operand & 0x80) !== 0);
      this.setFlag(StatusFlag.V, (operand & 0x40) !== 0);
    } else {
      this.setFlag(StatusFlag.N, (operand & 0x8000) !== 0);
      this.setFlag(StatusFlag.V, (operand & 0x4000) !== 0);
    }
    this.cycles += this.isM8 ? 4 : 5;
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private BIT_absoluteX(): void {
    const baseAddr = this.readPC16();
    const addr = (baseAddr + this.reg.X) & 0xFFFF;
    const operand = this.isM8 ? this.read(this.reg.DB, addr) : (this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8));
    const result = (this.isM8 ? (this.reg.A & 0xFF) : this.reg.A) & operand;
    this.setFlag(StatusFlag.Z, result === 0);
    if (this.isM8) {
      this.setFlag(StatusFlag.N, (operand & 0x80) !== 0);
      this.setFlag(StatusFlag.V, (operand & 0x40) !== 0);
    } else {
      this.setFlag(StatusFlag.N, (operand & 0x8000) !== 0);
      this.setFlag(StatusFlag.V, (operand & 0x4000) !== 0);
    }
    this.cycles += this.isM8 ? 4 : 5;
    if ((baseAddr & 0xFF00) !== (addr & 0xFF00)) this.cycles += 1;
  }

  private TSB_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    if (this.isM8) {
      const value = this.read(0x00, addr);
      this.setFlag(StatusFlag.Z, (value & (this.reg.A & 0xFF)) === 0);
      this.write(0x00, addr, value | (this.reg.A & 0xFF));
      this.cycles += 5;
    } else {
      const value = this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.Z, (value & this.reg.A) === 0);
      const result = value | this.reg.A;
      this.write(0x00, addr, result & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, result >> 8);
      this.cycles += 6;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private TSB_absolute(): void {
    const addr = this.readPC16();
    if (this.isM8) {
      const value = this.read(this.reg.DB, addr);
      this.setFlag(StatusFlag.Z, (value & (this.reg.A & 0xFF)) === 0);
      this.write(this.reg.DB, addr, value | (this.reg.A & 0xFF));
      this.cycles += 6;
    } else {
      const value = this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.Z, (value & this.reg.A) === 0);
      const result = value | this.reg.A;
      this.write(this.reg.DB, addr, result & 0xFF);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, result >> 8);
      this.cycles += 7;
    }
  }

  private TRB_direct(): void {
    const addr = (this.reg.D + this.readPC()) & 0xFFFF;
    if (this.isM8) {
      const value = this.read(0x00, addr);
      this.setFlag(StatusFlag.Z, (value & (this.reg.A & 0xFF)) === 0);
      this.write(0x00, addr, value & ~(this.reg.A & 0xFF));
      this.cycles += 5;
    } else {
      const value = this.read(0x00, addr) | (this.read(0x00, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.Z, (value & this.reg.A) === 0);
      const result = value & ~this.reg.A;
      this.write(0x00, addr, result & 0xFF);
      this.write(0x00, (addr + 1) & 0xFFFF, result >> 8);
      this.cycles += 6;
    }
    if (this.reg.D & 0xFF) this.cycles += 1;
  }

  private TRB_absolute(): void {
    const addr = this.readPC16();
    if (this.isM8) {
      const value = this.read(this.reg.DB, addr);
      this.setFlag(StatusFlag.Z, (value & (this.reg.A & 0xFF)) === 0);
      this.write(this.reg.DB, addr, value & ~(this.reg.A & 0xFF));
      this.cycles += 6;
    } else {
      const value = this.read(this.reg.DB, addr) | (this.read(this.reg.DB, (addr + 1) & 0xFFFF) << 8);
      this.setFlag(StatusFlag.Z, (value & this.reg.A) === 0);
      const result = value & ~this.reg.A;
      this.write(this.reg.DB, addr, result & 0xFF);
      this.write(this.reg.DB, (addr + 1) & 0xFFFF, result >> 8);
      this.cycles += 7;
    }
  }

  // --- Miscellaneous Instructions ---
  
  private NOP(): void { this.cycles += 2; }
  
  private WAI(): void {
    this.waitingForInterrupt = true;
    this.cycles += 3;
  }
  
  private STP(): void {
    this.halted = true;
    this.cycles += 3;
  }
  
  private WDM(): void {
    // Reserved instruction, acts as 2-byte NOP
    this.readPC(); // Skip signature byte
    this.cycles += 2;
  }
  
  private BRK(): void {
    this.readPC(); // Skip signature byte
    this.handleInterrupt(InterruptType.BRK);
  }
  
  private COP(): void {
    this.readPC(); // Skip signature byte
    this.handleInterrupt(InterruptType.COP);
  }
  
  private MVP(): void {
    const destBank = this.readPC();
    const srcBank = this.readPC();
    this.reg.DB = destBank;
    
    const src = this.read(srcBank, this.reg.X);
    this.write(destBank, this.reg.Y, src);
    
    if (this.isX8) {
      this.reg.X = (this.reg.X - 1) & 0xFF;
      this.reg.Y = (this.reg.Y - 1) & 0xFF;
    } else {
      this.reg.X = (this.reg.X - 1) & 0xFFFF;
      this.reg.Y = (this.reg.Y - 1) & 0xFFFF;
    }
    
    this.reg.A = (this.reg.A - 1) & 0xFFFF;
    
    if (this.reg.A !== 0xFFFF) {
      this.reg.PC -= 3; // Repeat instruction
    }
    this.cycles += 7;
  }
  
  private MVN(): void {
    const destBank = this.readPC();
    const srcBank = this.readPC();
    this.reg.DB = destBank;
    
    const src = this.read(srcBank, this.reg.X);
    this.write(destBank, this.reg.Y, src);
    
    if (this.isX8) {
      this.reg.X = (this.reg.X + 1) & 0xFF;
      this.reg.Y = (this.reg.Y + 1) & 0xFF;
    } else {
      this.reg.X = (this.reg.X + 1) & 0xFFFF;
      this.reg.Y = (this.reg.Y + 1) & 0xFFFF;
    }
    
    this.reg.A = (this.reg.A - 1) & 0xFFFF;
    
    if (this.reg.A !== 0xFFFF) {
      this.reg.PC -= 3; // Repeat instruction
    }
    this.cycles += 7;
  }
  
  private XBA(): void {
    const low = this.reg.A & 0xFF;
    const high = (this.reg.A >> 8) & 0xFF;
    this.reg.A = (low << 8) | high;
    this.updateNZ8(this.reg.A & 0xFF);
    this.cycles += 3;
  }

  // ============================================================================
  // State Management
  // ============================================================================

  saveState(): CPUState {
    return {
      registers: { ...this.reg },
      cycles: this.cycles,
      halted: this.halted,
      waitingForInterrupt: this.waitingForInterrupt,
      pendingInterrupt: this.pendingNMI ? InterruptType.NMI : 
                        this.pendingIRQ ? InterruptType.IRQ : InterruptType.NONE,
    };
  }

  loadState(state: CPUState): void {
    this.reg = { ...state.registers };
    this.cycles = state.cycles;
    this.halted = state.halted;
    this.waitingForInterrupt = state.waitingForInterrupt;
    this.pendingNMI = state.pendingInterrupt === InterruptType.NMI;
    this.pendingIRQ = state.pendingInterrupt === InterruptType.IRQ;
  }

  // Debug helpers
  getRegisters(): CPURegisters {
    return { ...this.reg };
  }

  getTotalCycles(): bigint {
    return this.totalCycles;
  }
  
  isWaitingForInterrupt(): boolean {
    return this.waitingForInterrupt;
  }
  
  isHalted(): boolean {
    return this.halted;
  }
  
  /**
   * Read memory at specific location (for debugging)
   */
  peekMemory(bank: number, address: number): number {
    return this.memory.read(bank, address);
  }
  
  // Trace control
  enableTrace(maxInstructions: number = 200): void {
    this.traceEnabled = true;
    this.maxTraceCount = maxInstructions;
    this.traceLog = [];
    this.traceCount = 0;
  }
  
  disableTrace(): void {
    this.traceEnabled = false;
  }
  
  getTraceLog(): string[] {
    return this.traceLog;
  }
}
