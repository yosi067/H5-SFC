/**
 * Project 16-bit: SFC Emulator
 * APU (Audio Processing Unit) Implementation
 * 
 * Emulates the SPC700 CPU and Sony DSP
 */

import {
  SPC700_CONSTANTS,
  DSP_REG,
  SPCFlag,
  SPC700Registers,
  VoiceState,
  APUState,
  TimerState,
} from './types';

export class APU {
  // Memory
  private ram: Uint8Array = new Uint8Array(SPC700_CONSTANTS.RAM_SIZE);
  private dspRegs: Uint8Array = new Uint8Array(128);
  
  // CPU Registers
  private reg: SPC700Registers = {
    A: 0,
    X: 0,
    Y: 0,
    SP: 0xFF,
    PC: 0xFFC0,  // IPL ROM entry point
    PSW: 0,
  };
  
  // Communication ports
  private ports: Uint8Array = new Uint8Array(4);       // APU → CPU
  private portsFromCPU: Uint8Array = new Uint8Array(4); // CPU → APU
  
  // Timers (0,1 = 8kHz, 2 = 64kHz)
  private timerTargets: Uint8Array = new Uint8Array(3);
  private timerCounters: Uint8Array = new Uint8Array(3);
  private timerDividers: Uint8Array = new Uint8Array(3);
  private timerEnabled: number = 0;
  
  // DSP state
  private dspAddress: number = 0;
  private voices: VoiceState[] = [];
  
  // Audio output
  private sampleBuffer: Float32Array = new Float32Array(
    SPC700_CONSTANTS.SAMPLES_PER_FRAME * 2
  );
  private sampleIndex: number = 0;
  
  // Cycle counter
  private cycles: number = 0;
  private cycleAccumulator: number = 0;
  
  // IPL ROM (boot ROM)
  private readonly iplRom: Uint8Array = new Uint8Array([
    0xCD, 0xEF, 0xBD, 0xE8, 0x00, 0xC6, 0x1D, 0xD0,
    0xFC, 0x8F, 0xAA, 0xF4, 0x8F, 0xBB, 0xF5, 0x78,
    0xCC, 0xF4, 0xD0, 0xFB, 0x2F, 0x19, 0xEB, 0xF4,
    0xD0, 0xFC, 0x7E, 0xF4, 0xD0, 0x0B, 0xE4, 0xF5,
    0xCB, 0xF4, 0xD7, 0x00, 0xFC, 0xD0, 0xF3, 0xAB,
    0x01, 0x10, 0xEF, 0x7E, 0xF4, 0x10, 0xEB, 0xBA,
    0xF6, 0xDA, 0x00, 0xBA, 0xF4, 0xC4, 0xF4, 0xDD,
    0x5D, 0xD0, 0xDB, 0x1F, 0x00, 0x00, 0xC0, 0xFF,
  ]);
  
  private iplEnabled: boolean = true;
  
  constructor() {
    this.initVoices();
    this.reset();
  }
  
  private initVoices(): void {
    this.voices = [];
    for (let i = 0; i < 8; i++) {
      this.voices.push({
        sampleAddress: 0,
        sampleOffset: 0,
        sampleBuffer: new Int16Array(16),
        bufferOffset: 0,
        pitch: 0,
        pitchCounter: 0,
        envelope: 0,
        envelopeMode: 'release',
        adsrRate: 0,
        brrHeader: 0,
        brrShift: 0,
        brrFilter: 0,
        brrEnd: false,
        brrLoop: false,
        prevSamples: new Int16Array(4),
        output: 0,
        enabled: false,
      });
    }
  }
  
  reset(): void {
    this.ram.fill(0);
    this.dspRegs.fill(0);
    
    // Note: We do NOT copy IPL ROM to RAM here.
    // The IPL ROM is boot code, not a TCALL vector table.
    // TCALL vectors should be set up by the game's sound driver if it uses TCALL.
    // The IPL ROM only overlays RAM at $FFC0-$FFFF for reads when enabled.
    
    this.reg = {
      A: 0,
      X: 0,
      Y: 0,
      SP: 0xFF,
      PC: 0xFFC0,
      PSW: 0,
    };
    
    // Initialize ports with boot handshake values
    // The IPL ROM writes $AA to port 0 and $BB to port 1 on boot
    // Pre-initialize to avoid boot timing issues
    this.ports[0] = 0xAA;
    this.ports[1] = 0xBB;
    this.ports[2] = 0;
    this.ports[3] = 0;
    this.portsFromCPU.fill(0);
    this.timerTargets.fill(0);
    this.timerCounters.fill(0);
    this.timerDividers.fill(0);
    this.timerEnabled = 0;
    
    this.dspAddress = 0;
    this.iplEnabled = true;
    this.cycles = 0;
    this.sampleIndex = 0;
    
    // Initialize DSP
    this.dspRegs[DSP_REG.FLG] = 0xE0; // Reset, mute, echo off
    
    for (const voice of this.voices) {
      voice.enabled = false;
      voice.envelope = 0;
      voice.envelopeMode = 'release';
    }
  }
  
  // ============================================================================
  // Communication with Main CPU
  // ============================================================================
  
  /**
   * Read from APU port (main CPU side)
   */
  readPort(port: number): number {
    return this.ports[port & 3];
  }
  
  /**
   * Write to APU port (main CPU side)
   */
  writePort(port: number, value: number): void {
    this.portsFromCPU[port & 3] = value;
  }
  
  // ============================================================================
  // Memory Access
  // ============================================================================
  
  private read(address: number): number {
    address &= 0xFFFF;
    
    // IPL ROM area
    if (this.iplEnabled && address >= 0xFFC0) {
      return this.iplRom[address - 0xFFC0];
    }
    
    // I/O registers
    if (address >= 0xF0 && address <= 0xFF) {
      return this.readIO(address);
    }
    
    return this.ram[address];
  }
  
  private write(address: number, value: number): void {
    address &= 0xFFFF;
    
    // I/O registers
    if (address >= 0xF0 && address <= 0xFF) {
      this.writeIO(address, value);
      return;
    }
    
    // RAM is always writable, even in the IPL ROM area ($FFC0-$FFFF)
    // The IPL ROM only affects reads, not writes
    this.ram[address] = value;
  }
  
  private readIO(address: number): number {
    switch (address) {
      case SPC700_CONSTANTS.REG_DSPADDR:
        return this.dspAddress;
        
      case SPC700_CONSTANTS.REG_DSPDATA:
        return this.dspRegs[this.dspAddress & 0x7F];
        
      case SPC700_CONSTANTS.REG_PORT0:
      case SPC700_CONSTANTS.REG_PORT1:
      case SPC700_CONSTANTS.REG_PORT2:
      case SPC700_CONSTANTS.REG_PORT3:
        return this.portsFromCPU[address - SPC700_CONSTANTS.REG_PORT0];
        
      case SPC700_CONSTANTS.REG_COUNTER0:
        const c0 = this.timerCounters[0];
        this.timerCounters[0] = 0;
        return c0 & 0x0F;
        
      case SPC700_CONSTANTS.REG_COUNTER1:
        const c1 = this.timerCounters[1];
        this.timerCounters[1] = 0;
        return c1 & 0x0F;
        
      case SPC700_CONSTANTS.REG_COUNTER2:
        const c2 = this.timerCounters[2];
        this.timerCounters[2] = 0;
        return c2 & 0x0F;
        
      default:
        return this.ram[address];
    }
  }
  
  private writeIO(address: number, value: number): void {
    switch (address) {
      case SPC700_CONSTANTS.REG_TEST:
        // Test register - ignored
        break;
        
      case SPC700_CONSTANTS.REG_CONTROL:
        this.timerEnabled = value & 0x07;
        
        // Reset timers if enabled
        if (value & 0x01) {
          this.timerDividers[0] = 0;
          this.timerCounters[0] = 0;
        }
        if (value & 0x02) {
          this.timerDividers[1] = 0;
          this.timerCounters[1] = 0;
        }
        if (value & 0x04) {
          this.timerDividers[2] = 0;
          this.timerCounters[2] = 0;
        }
        
        // Clear ports if requested
        if (value & 0x10) {
          this.portsFromCPU[0] = 0;
          this.portsFromCPU[1] = 0;
        }
        if (value & 0x20) {
          this.portsFromCPU[2] = 0;
          this.portsFromCPU[3] = 0;
        }
        
        // IPL ROM enable
        this.iplEnabled = (value & 0x80) !== 0;
        break;
        
      case SPC700_CONSTANTS.REG_DSPADDR:
        this.dspAddress = value;
        break;
        
      case SPC700_CONSTANTS.REG_DSPDATA:
        this.writeDSP(this.dspAddress & 0x7F, value);
        break;
        
      case SPC700_CONSTANTS.REG_PORT0:
      case SPC700_CONSTANTS.REG_PORT1:
      case SPC700_CONSTANTS.REG_PORT2:
      case SPC700_CONSTANTS.REG_PORT3:
        this.ports[address - SPC700_CONSTANTS.REG_PORT0] = value;
        break;
        
      case SPC700_CONSTANTS.REG_TIMER0:
        this.timerTargets[0] = value;
        break;
        
      case SPC700_CONSTANTS.REG_TIMER1:
        this.timerTargets[1] = value;
        break;
        
      case SPC700_CONSTANTS.REG_TIMER2:
        this.timerTargets[2] = value;
        break;
        
      default:
        this.ram[address] = value;
    }
  }
  
  // ============================================================================
  // DSP Access
  // ============================================================================
  
  private writeDSP(address: number, value: number): void {
    this.dspRegs[address] = value;
    
    // Voice registers
    const voice = (address >> 4) & 0x07;
    const reg = address & 0x0F;
    
    switch (address) {
      case DSP_REG.KON:
        // Key on
        for (let v = 0; v < 8; v++) {
          if (value & (1 << v)) {
            this.keyOn(v);
          }
        }
        break;
        
      case DSP_REG.KOFF:
        // Key off
        for (let v = 0; v < 8; v++) {
          if (value & (1 << v)) {
            this.keyOff(v);
          }
        }
        break;
        
      case DSP_REG.FLG:
        // Flags - mute, reset, noise clock, echo enable
        if (value & 0x80) {
          // Soft reset
          for (const v of this.voices) {
            v.enabled = false;
            v.envelope = 0;
          }
        }
        break;
    }
  }
  
  private keyOn(voiceNum: number): void {
    const voice = this.voices[voiceNum];
    const srcn = this.dspRegs[(voiceNum << 4) | DSP_REG.SRCN];
    const dir = this.dspRegs[DSP_REG.DIR] << 8;
    
    // Get sample start address from directory
    const dirAddr = dir + (srcn << 2);
    voice.sampleAddress = this.ram[dirAddr] | (this.ram[dirAddr + 1] << 8);
    voice.sampleOffset = 0;
    voice.bufferOffset = 0;
    
    voice.enabled = true;
    voice.envelopeMode = 'attack';
    voice.envelope = 0;
    voice.pitchCounter = 0;
    
    voice.prevSamples.fill(0);
    voice.brrEnd = false;
    voice.brrLoop = false;
    
    // Clear ENDX flag
    this.dspRegs[DSP_REG.ENDX] &= ~(1 << voiceNum);
  }
  
  private keyOff(voiceNum: number): void {
    this.voices[voiceNum].envelopeMode = 'release';
  }
  
  // ============================================================================
  // Flag Operations
  // ============================================================================
  
  private getFlag(flag: SPCFlag): boolean {
    return (this.reg.PSW & flag) !== 0;
  }
  
  private setFlag(flag: SPCFlag, value: boolean): void {
    if (value) {
      this.reg.PSW |= flag;
    } else {
      this.reg.PSW &= ~flag;
    }
  }
  
  private updateNZ(value: number): void {
    this.setFlag(SPCFlag.Z, (value & 0xFF) === 0);
    this.setFlag(SPCFlag.N, (value & 0x80) !== 0);
  }
  
  private getDirectPageAddress(offset: number): number {
    return (this.getFlag(SPCFlag.P) ? 0x100 : 0) + offset;
  }
  
  // ============================================================================
  // CPU Execution
  // ============================================================================
  
  /**
   * Step the APU by the given number of master cycles
   */
  step(masterCycles: number): void {
    // Convert master cycles to SPC700 cycles
    // SPC700 runs at ~1.024 MHz, master at ~21.477 MHz
    // Ratio is approximately 21
    this.cycleAccumulator += masterCycles;
    
    // Run opcodes while we have enough cycles
    // Minimum opcode takes 2 SPC cycles
    while (this.cycleAccumulator >= 21 * 2) {
      const opcodeCycles = this.stepCPU();
      this.cycleAccumulator -= 21 * opcodeCycles;
      this.stepTimers(opcodeCycles);
    }
  }
  
  /**
   * Execute one SPC700 instruction
   * @returns number of SPC700 cycles consumed
   */
  private stepCPU(): number {
    const opcode = this.read(this.reg.PC);
    this.reg.PC = (this.reg.PC + 1) & 0xFFFF;
    
    const opcodeCycles = this.executeOpcode(opcode);
    this.cycles += opcodeCycles;
    return opcodeCycles;
  }
  
  private stepTimers(cycles: number): void {
    // Timers 0 and 1: 8kHz (every 128 cycles)
    // Timer 2: 64kHz (every 16 cycles)
    
    // Simplified timer implementation
    if ((this.cycles & 127) === 0) {
      if (this.timerEnabled & 0x01) {
        this.timerDividers[0]++;
        if (this.timerDividers[0] >= (this.timerTargets[0] || 256)) {
          this.timerDividers[0] = 0;
          this.timerCounters[0] = (this.timerCounters[0] + 1) & 0x0F;
        }
      }
      if (this.timerEnabled & 0x02) {
        this.timerDividers[1]++;
        if (this.timerDividers[1] >= (this.timerTargets[1] || 256)) {
          this.timerDividers[1] = 0;
          this.timerCounters[1] = (this.timerCounters[1] + 1) & 0x0F;
        }
      }
    }
    
    if ((this.cycles & 15) === 0) {
      if (this.timerEnabled & 0x04) {
        this.timerDividers[2]++;
        if (this.timerDividers[2] >= (this.timerTargets[2] || 256)) {
          this.timerDividers[2] = 0;
          this.timerCounters[2] = (this.timerCounters[2] + 1) & 0x0F;
        }
      }
    }
  }
  
  // SPC700 cycle counts per opcode (most common values)
  // Based on official SPC700 documentation
  private static readonly OPCODE_CYCLES: number[] = [
    // 0x00-0x0F
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 6, 8,
    // 0x10-0x1F
    2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 4, 6,
    // 0x20-0x2F
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 5, 4,
    // 0x30-0x3F
    2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 3, 8,
    // 0x40-0x4F
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 6, 6,
    // 0x50-0x5F
    2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 4, 5, 2, 2, 4, 3,
    // 0x60-0x6F
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 5, 5,
    // 0x70-0x7F
    2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 6,
    // 0x80-0x8F
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 2, 4, 5,
    // 0x90-0x9F
    2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 12,3,
    // 0xA0-0xAF
    3, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 2, 4, 4,
    // 0xB0-0xBF
    2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 4, 4,
    // 0xC0-0xCF
    3, 8, 4, 5, 4, 5, 4, 7, 2, 5, 6, 4, 5, 2, 4, 9,
    // 0xD0-0xDF
    2, 8, 4, 5, 5, 6, 5, 7, 4, 5, 5, 5, 2, 2, 6, 3,
    // 0xE0-0xEF
    2, 8, 4, 5, 3, 4, 3, 6, 2, 4, 5, 3, 4, 4, 3, 3,
    // 0xF0-0xFF
    2, 8, 4, 5, 4, 5, 5, 6, 3, 4, 5, 4, 2, 2, 4, 3,
  ];
  
  /**
   * Execute a single SPC700 opcode
   * @returns number of cycles consumed
   */
  private executeOpcode(opcode: number): number {
    const cycles = APU.OPCODE_CYCLES[opcode];
    
    switch (opcode) {
      // NOP
      case 0x00: break;
      
      // MOV A, #imm
      case 0xE8:
        this.reg.A = this.read(this.reg.PC++);
        this.updateNZ(this.reg.A);
        break;
      
      // MOV X, #imm
      case 0xCD:
        this.reg.X = this.read(this.reg.PC++);
        this.updateNZ(this.reg.X);
        break;
      
      // MOV Y, #imm
      case 0x8D:
        this.reg.Y = this.read(this.reg.PC++);
        this.updateNZ(this.reg.Y);
        break;
      
      // MOV A, dp
      case 0xE4:
        const dpAddr = this.getDirectPageAddress(this.read(this.reg.PC++));
        this.reg.A = this.read(dpAddr);
        this.updateNZ(this.reg.A);
        break;
      
      // MOV A, dp+X
      case 0xF4:
        const dpxAddr = this.getDirectPageAddress(
          (this.read(this.reg.PC++) + this.reg.X) & 0xFF
        );
        this.reg.A = this.read(dpxAddr);
        this.updateNZ(this.reg.A);
        break;
      
      // MOV dp, A
      case 0xC4:
        const dpDest = this.getDirectPageAddress(this.read(this.reg.PC++));
        this.write(dpDest, this.reg.A);
        break;
      
      // MOV dp, #imm
      case 0x8F:
        const imm = this.read(this.reg.PC++);
        const dp = this.getDirectPageAddress(this.read(this.reg.PC++));
        this.write(dp, imm);
        break;
      
      // MOV X, dp
      case 0xF8:
        const xdpAddr = this.getDirectPageAddress(this.read(this.reg.PC++));
        this.reg.X = this.read(xdpAddr);
        this.updateNZ(this.reg.X);
        break;
      
      // MOV dp, X
      case 0xD8:
        const xdpDest = this.getDirectPageAddress(this.read(this.reg.PC++));
        this.write(xdpDest, this.reg.X);
        break;
      
      // MOV Y, dp
      case 0xEB:
        const ydpAddr = this.getDirectPageAddress(this.read(this.reg.PC++));
        this.reg.Y = this.read(ydpAddr);
        this.updateNZ(this.reg.Y);
        break;
      
      // MOV dp, Y
      case 0xCB:
        const ydpDest = this.getDirectPageAddress(this.read(this.reg.PC++));
        this.write(ydpDest, this.reg.Y);
        break;
      
      // MOV A, (X)
      case 0xE6:
        this.reg.A = this.read(this.getDirectPageAddress(this.reg.X));
        this.updateNZ(this.reg.A);
        break;
      
      // MOV (X), A - Store A at (DP+X), no increment
      case 0xC6:
        this.write(this.getDirectPageAddress(this.reg.X), this.reg.A);
        break;
      
      // MOV (X)+, A - Store A at (DP+X), then increment X
      case 0xAF:
        this.write(this.getDirectPageAddress(this.reg.X), this.reg.A);
        this.reg.X = (this.reg.X + 1) & 0xFF;
        break;
      
      // MOV A, !abs
      case 0xE5:
        const absL = this.read(this.reg.PC++);
        const absH = this.read(this.reg.PC++);
        this.reg.A = this.read((absH << 8) | absL);
        this.updateNZ(this.reg.A);
        break;
      
      // MOV !abs, A
      case 0xC5:
        const absLw = this.read(this.reg.PC++);
        const absHw = this.read(this.reg.PC++);
        this.write((absHw << 8) | absLw, this.reg.A);
        break;
      
      // Transfer instructions
      case 0x7D: // MOV A, X
        this.reg.A = this.reg.X;
        this.updateNZ(this.reg.A);
        break;
      
      case 0x5D: // MOV X, A
        this.reg.X = this.reg.A;
        this.updateNZ(this.reg.X);
        break;
      
      case 0xDD: // MOV A, Y
        this.reg.A = this.reg.Y;
        this.updateNZ(this.reg.A);
        break;
      
      case 0xFD: // MOV Y, A
        this.reg.Y = this.reg.A;
        this.updateNZ(this.reg.Y);
        break;
      
      case 0x9D: // MOV X, SP
        this.reg.X = this.reg.SP;
        this.updateNZ(this.reg.X);
        break;
      
      case 0xBD: // MOV SP, X
        this.reg.SP = this.reg.X;
        break;
      
      // MOV [dp]+Y, A - Indirect indexed store
      case 0xD7: {
        const dp = this.read(this.reg.PC++);
        const baseAddr = this.getDirectPageAddress(dp);
        const ptr = this.read(baseAddr) | (this.read((baseAddr + 1) & 0xFFFF) << 8);
        this.write((ptr + this.reg.Y) & 0xFFFF, this.reg.A);
        break;
      }
      
      // MOV [dp+X], A - Indexed indirect store
      case 0xC7: {
        const dp = this.read(this.reg.PC++);
        const baseAddr = this.getDirectPageAddress((dp + this.reg.X) & 0xFF);
        const ptr = this.read(baseAddr) | (this.read((baseAddr + 1) & 0xFFFF) << 8);
        this.write(ptr, this.reg.A);
        break;
      }
      
      // MOV A, [dp]+Y - Indirect indexed load
      case 0xF7: {
        const dpF7 = this.read(this.reg.PC++);
        const baseAddrF7 = this.getDirectPageAddress(dpF7);
        const ptrF7 = this.read(baseAddrF7) | (this.read((baseAddrF7 + 1) & 0xFFFF) << 8);
        this.reg.A = this.read((ptrF7 + this.reg.Y) & 0xFFFF);
        this.updateNZ(this.reg.A);
        break;
      }
      
      // MOV A, [dp+X] - Indexed indirect load
      case 0xE7: {
        const dpE7 = this.read(this.reg.PC++);
        const baseAddrE7 = this.getDirectPageAddress((dpE7 + this.reg.X) & 0xFF);
        const ptrE7 = this.read(baseAddrE7) | (this.read((baseAddrE7 + 1) & 0xFFFF) << 8);
        this.reg.A = this.read(ptrE7);
        this.updateNZ(this.reg.A);
        break;
      }
      
      // Stack operations
      case 0x2D: // PUSH A
        this.pushByte(this.reg.A);
        break;
      
      case 0x4D: // PUSH X
        this.pushByte(this.reg.X);
        break;
      
      case 0x6D: // PUSH Y
        this.pushByte(this.reg.Y);
        break;
      
      case 0x0D: // PUSH PSW
        this.pushByte(this.reg.PSW);
        break;
      
      case 0xAE: // POP A
        this.reg.A = this.pullByte();
        break;
      
      case 0xCE: // POP X
        this.reg.X = this.pullByte();
        break;
      
      case 0xEE: // POP Y
        this.reg.Y = this.pullByte();
        break;
      
      case 0x8E: // POP PSW
        this.reg.PSW = this.pullByte();
        break;
      
      // INC/DEC
      case 0xBC: // INC A
        this.reg.A = (this.reg.A + 1) & 0xFF;
        this.updateNZ(this.reg.A);
        break;
      
      case 0x3D: // INC X
        this.reg.X = (this.reg.X + 1) & 0xFF;
        this.updateNZ(this.reg.X);
        break;
      
      case 0xFC: // INC Y
        this.reg.Y = (this.reg.Y + 1) & 0xFF;
        this.updateNZ(this.reg.Y);
        break;
      
      case 0x9C: // DEC A
        this.reg.A = (this.reg.A - 1) & 0xFF;
        this.updateNZ(this.reg.A);
        break;
      
      case 0x1D: // DEC X
        this.reg.X = (this.reg.X - 1) & 0xFF;
        this.updateNZ(this.reg.X);
        break;
      
      case 0xDC: // DEC Y
        this.reg.Y = (this.reg.Y - 1) & 0xFF;
        this.updateNZ(this.reg.Y);
        break;
      
      // Branches
      case 0x2F: // BRA rel
        this.branch(true);
        break;
      
      case 0xF0: // BEQ rel
        this.branch(this.getFlag(SPCFlag.Z));
        break;
      
      case 0xD0: // BNE rel
        this.branch(!this.getFlag(SPCFlag.Z));
        break;
      
      case 0xB0: // BCS rel
        this.branch(this.getFlag(SPCFlag.C));
        break;
      
      case 0x90: // BCC rel
        this.branch(!this.getFlag(SPCFlag.C));
        break;
      
      case 0x30: // BMI rel
        this.branch(this.getFlag(SPCFlag.N));
        break;
      
      case 0x10: // BPL rel
        this.branch(!this.getFlag(SPCFlag.N));
        break;
      
      case 0x70: // BVS rel
        this.branch(this.getFlag(SPCFlag.V));
        break;
      
      case 0x50: // BVC rel
        this.branch(!this.getFlag(SPCFlag.V));
        break;
      
      // Compare branches
      case 0x78: // CMP dp, #imm
        const cmpImm = this.read(this.reg.PC++);
        const cmpDp = this.getDirectPageAddress(this.read(this.reg.PC++));
        const cmpVal = this.read(cmpDp);
        this.compare(cmpVal, cmpImm);
        break;
      
      case 0x6E: // DBNZ dp, rel
        const dbnzDp = this.getDirectPageAddress(this.read(this.reg.PC++));
        let dbnzVal = (this.read(dbnzDp) - 1) & 0xFF;
        this.write(dbnzDp, dbnzVal);
        this.branch(dbnzVal !== 0);
        break;
      
      case 0xFE: // DBNZ Y, rel
        this.reg.Y = (this.reg.Y - 1) & 0xFF;
        this.branch(this.reg.Y !== 0);
        break;
      
      // Jumps and calls
      case 0x5F: // JMP !abs
        const jmpL = this.read(this.reg.PC++);
        const jmpH = this.read(this.reg.PC++);
        this.reg.PC = (jmpH << 8) | jmpL;
        break;
      
      case 0x1F: // JMP [!abs+X]
        const jmpxL = this.read(this.reg.PC++);
        const jmpxH = this.read(this.reg.PC++);
        const jmpxAddr = ((jmpxH << 8) | jmpxL) + this.reg.X;
        this.reg.PC = this.read(jmpxAddr) | (this.read(jmpxAddr + 1) << 8);
        break;
      
      case 0x3F: // CALL !abs
        const callL = this.read(this.reg.PC++);
        const callH = this.read(this.reg.PC++);
        this.pushByte((this.reg.PC >> 8) & 0xFF);
        this.pushByte(this.reg.PC & 0xFF);
        this.reg.PC = (callH << 8) | callL;
        break;
      
      case 0x6F: // RET
        const retL = this.pullByte();
        const retH = this.pullByte();
        this.reg.PC = (retH << 8) | retL;
        break;
      
      case 0x7F: // RETI
        this.reg.PSW = this.pullByte();
        const retiL = this.pullByte();
        const retiH = this.pullByte();
        this.reg.PC = (retiH << 8) | retiL;
        break;
      
      // Flag operations
      case 0x60: // CLRC
        this.setFlag(SPCFlag.C, false);
        break;
      
      case 0x80: // SETC
        this.setFlag(SPCFlag.C, true);
        break;
      
      case 0xED: // NOTC
        this.setFlag(SPCFlag.C, !this.getFlag(SPCFlag.C));
        break;
      
      case 0xE0: // CLRV
        this.setFlag(SPCFlag.V, false);
        this.setFlag(SPCFlag.H, false);
        break;
      
      case 0x20: // CLRP
        this.setFlag(SPCFlag.P, false);
        break;
      
      case 0x40: // SETP
        this.setFlag(SPCFlag.P, true);
        break;
      
      case 0xA0: // EI
        this.setFlag(SPCFlag.I, true);
        break;
      
      case 0xC0: // DI
        this.setFlag(SPCFlag.I, false);
        break;
      
      // Logical operations
      case 0x28: // AND A, #imm
        this.reg.A &= this.read(this.reg.PC++);
        this.updateNZ(this.reg.A);
        break;
      
      case 0x08: // OR A, #imm
        this.reg.A |= this.read(this.reg.PC++);
        this.updateNZ(this.reg.A);
        break;
      
      case 0x48: // EOR A, #imm
        this.reg.A ^= this.read(this.reg.PC++);
        this.updateNZ(this.reg.A);
        break;
      
      // Compare
      case 0x68: // CMP A, #imm
        this.compare(this.reg.A, this.read(this.reg.PC++));
        break;
      
      case 0xC8: // CMP X, #imm
        this.compare(this.reg.X, this.read(this.reg.PC++));
        break;
      
      case 0xAD: // CMP Y, #imm
        this.compare(this.reg.Y, this.read(this.reg.PC++));
        break;
      
      case 0x7E: // CMP Y, dp
        const cmpYDp = this.getDirectPageAddress(this.read(this.reg.PC++));
        this.compare(this.reg.Y, this.read(cmpYDp));
        break;
      
      // Add/Subtract
      case 0x88: // ADC A, #imm
        this.adc(this.read(this.reg.PC++));
        break;
      
      case 0xA8: // SBC A, #imm
        this.sbc(this.read(this.reg.PC++));
        break;
      
      // INC/DEC dp
      case 0xAB: // INC dp
        const incDp = this.getDirectPageAddress(this.read(this.reg.PC++));
        const incVal = (this.read(incDp) + 1) & 0xFF;
        this.write(incDp, incVal);
        this.updateNZ(incVal);
        break;
      
      case 0x8B: // DEC dp
        const decDp = this.getDirectPageAddress(this.read(this.reg.PC++));
        const decVal = (this.read(decDp) - 1) & 0xFF;
        this.write(decDp, decVal);
        this.updateNZ(decVal);
        break;
      
      // 16-bit operations
      case 0xBA: // MOVW YA, dp
        const movwDp = this.getDirectPageAddress(this.read(this.reg.PC++));
        this.reg.A = this.read(movwDp);
        this.reg.Y = this.read(movwDp + 1);
        this.setFlag(SPCFlag.Z, this.reg.A === 0 && this.reg.Y === 0);
        this.setFlag(SPCFlag.N, (this.reg.Y & 0x80) !== 0);
        break;
      
      case 0xDA: // MOVW dp, YA
        const movwDpDest = this.getDirectPageAddress(this.read(this.reg.PC++));
        this.write(movwDpDest, this.reg.A);
        this.write(movwDpDest + 1, this.reg.Y);
        break;
      
      case 0x3A: // INCW dp
        const incwDp = this.getDirectPageAddress(this.read(this.reg.PC++));
        let incwVal = this.read(incwDp) | (this.read(incwDp + 1) << 8);
        incwVal = (incwVal + 1) & 0xFFFF;
        this.write(incwDp, incwVal & 0xFF);
        this.write(incwDp + 1, (incwVal >> 8) & 0xFF);
        this.setFlag(SPCFlag.Z, incwVal === 0);
        this.setFlag(SPCFlag.N, (incwVal & 0x8000) !== 0);
        break;
      
      case 0x1A: // DECW dp
        const decwDp = this.getDirectPageAddress(this.read(this.reg.PC++));
        let decwVal = this.read(decwDp) | (this.read(decwDp + 1) << 8);
        decwVal = (decwVal - 1) & 0xFFFF;
        this.write(decwDp, decwVal & 0xFF);
        this.write(decwDp + 1, (decwVal >> 8) & 0xFF);
        this.setFlag(SPCFlag.Z, decwVal === 0);
        this.setFlag(SPCFlag.N, (decwVal & 0x8000) !== 0);
        break;
      
      // SLEEP/STOP
      case 0xEF: // SLEEP
      case 0xFF: // STOP
        // Halt until reset
        this.reg.PC--;
        break;
      
      // ============================================
      // Additional addressing modes
      // ============================================
      
      // MOV !abs+X, A - Absolute indexed X store
      case 0xD5: {
        const lowD5 = this.read(this.reg.PC++);
        const highD5 = this.read(this.reg.PC++);
        const addrD5 = ((highD5 << 8) | lowD5) + this.reg.X;
        this.write(addrD5 & 0xFFFF, this.reg.A);
        break;
      }
      
      // MOV !abs+Y, A - Absolute indexed Y store
      case 0xD6: {
        const lowD6 = this.read(this.reg.PC++);
        const highD6 = this.read(this.reg.PC++);
        const addrD6 = ((highD6 << 8) | lowD6) + this.reg.Y;
        this.write(addrD6 & 0xFFFF, this.reg.A);
        break;
      }
      
      // MOV A, !abs+X - Absolute indexed X load
      case 0xF5: {
        const lowF5 = this.read(this.reg.PC++);
        const highF5 = this.read(this.reg.PC++);
        const addrF5 = ((highF5 << 8) | lowF5) + this.reg.X;
        this.reg.A = this.read(addrF5 & 0xFFFF);
        this.updateNZ(this.reg.A);
        break;
      }
      
      // MOV A, !abs+Y - Absolute indexed Y load
      case 0xF6: {
        const lowF6 = this.read(this.reg.PC++);
        const highF6 = this.read(this.reg.PC++);
        const addrF6 = ((highF6 << 8) | lowF6) + this.reg.Y;
        this.reg.A = this.read(addrF6 & 0xFFFF);
        this.updateNZ(this.reg.A);
        break;
      }
      
      // CMP A, dp - Compare A with direct page
      case 0x64: {
        const dpCmp64 = this.getDirectPageAddress(this.read(this.reg.PC++));
        const valCmp64 = this.read(dpCmp64);
        const result64 = this.reg.A - valCmp64;
        this.setFlag(SPCFlag.N, (result64 & 0x80) !== 0);
        this.setFlag(SPCFlag.Z, (result64 & 0xFF) === 0);
        this.setFlag(SPCFlag.C, this.reg.A >= valCmp64);
        break;
      }
      
      // CMP A, (X) - Compare A with value at (X)
      case 0x66: {
        const valCmp66 = this.read(this.getDirectPageAddress(this.reg.X));
        const result66 = this.reg.A - valCmp66;
        this.setFlag(SPCFlag.N, (result66 & 0x80) !== 0);
        this.setFlag(SPCFlag.Z, (result66 & 0xFF) === 0);
        this.setFlag(SPCFlag.C, this.reg.A >= valCmp66);
        break;
      }
      
      // ASL A - Arithmetic shift left A
      case 0x1C: {
        this.setFlag(SPCFlag.C, (this.reg.A & 0x80) !== 0);
        this.reg.A = (this.reg.A << 1) & 0xFF;
        this.updateNZ(this.reg.A);
        break;
      }
      
      // LSR A - Logical shift right A
      case 0x5C: {
        this.setFlag(SPCFlag.C, (this.reg.A & 0x01) !== 0);
        this.reg.A = (this.reg.A >> 1) & 0xFF;
        this.updateNZ(this.reg.A);
        break;
      }
      
      // ROL A - Rotate left A through carry
      case 0x3C: {
        const oldC = this.getFlag(SPCFlag.C) ? 1 : 0;
        this.setFlag(SPCFlag.C, (this.reg.A & 0x80) !== 0);
        this.reg.A = ((this.reg.A << 1) | oldC) & 0xFF;
        this.updateNZ(this.reg.A);
        break;
      }
      
      // ROR A - Rotate right A through carry
      case 0x7C: {
        const oldC7C = this.getFlag(SPCFlag.C) ? 0x80 : 0;
        this.setFlag(SPCFlag.C, (this.reg.A & 0x01) !== 0);
        this.reg.A = ((this.reg.A >> 1) | oldC7C) & 0xFF;
        this.updateNZ(this.reg.A);
        break;
      }
      
      // TCALL instructions - Call subroutine from vector table
      case 0x01: this.tcall(0); break;
      case 0x11: this.tcall(1); break;
      case 0x21: this.tcall(2); break;
      case 0x31: this.tcall(3); break;
      case 0x41: this.tcall(4); break;
      case 0x51: this.tcall(5); break;
      case 0x61: this.tcall(6); break;
      case 0x71: this.tcall(7); break;
      case 0x81: this.tcall(8); break;
      case 0x91: this.tcall(9); break;
      case 0xA1: this.tcall(10); break;
      case 0xB1: this.tcall(11); break;
      case 0xC1: this.tcall(12); break;
      case 0xD1: this.tcall(13); break;
      case 0xE1: this.tcall(14); break;
      case 0xF1: this.tcall(15); break;
      
      // CLR1/SET1 - Clear/Set bits in direct page
      case 0x12: { const dp12 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dp12, this.read(dp12) & ~0x01); break; }
      case 0x32: { const dp32 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dp32, this.read(dp32) & ~0x02); break; }
      case 0x52: { const dp52 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dp52, this.read(dp52) & ~0x04); break; }
      case 0x72: { const dp72 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dp72, this.read(dp72) & ~0x08); break; }
      case 0x92: { const dp92 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dp92, this.read(dp92) & ~0x10); break; }
      case 0xB2: { const dpB2 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dpB2, this.read(dpB2) & ~0x20); break; }
      case 0xD2: { const dpD2 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dpD2, this.read(dpD2) & ~0x40); break; }
      case 0xF2: { const dpF2 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dpF2, this.read(dpF2) & ~0x80); break; }
      case 0x02: { const dp02 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dp02, this.read(dp02) | 0x01); break; }
      case 0x22: { const dp22 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dp22, this.read(dp22) | 0x02); break; }
      case 0x42: { const dp42 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dp42, this.read(dp42) | 0x04); break; }
      case 0x62: { const dp62 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dp62, this.read(dp62) | 0x08); break; }
      case 0x82: { const dp82 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dp82, this.read(dp82) | 0x10); break; }
      case 0xA2: { const dpA2 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dpA2, this.read(dpA2) | 0x20); break; }
      case 0xC2: { const dpC2 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dpC2, this.read(dpC2) | 0x40); break; }
      case 0xE2: { const dpE2 = this.getDirectPageAddress(this.read(this.reg.PC++)); this.write(dpE2, this.read(dpE2) | 0x80); break; }

      // BBC - Branch if bit clear
      case 0x13: this.bbc(0); break;
      case 0x33: this.bbc(1); break;
      case 0x53: this.bbc(2); break;
      case 0x73: this.bbc(3); break;
      case 0x93: this.bbc(4); break;
      case 0xB3: this.bbc(5); break;
      case 0xD3: this.bbc(6); break;
      case 0xF3: this.bbc(7); break;
      
      // BBS - Branch if bit set
      case 0x03: this.bbs(0); break;
      case 0x23: this.bbs(1); break;
      case 0x43: this.bbs(2); break;
      case 0x63: this.bbs(3); break;
      case 0x83: this.bbs(4); break;
      case 0xA3: this.bbs(5); break;
      case 0xC3: this.bbs(6); break;
      case 0xE3: this.bbs(7); break;
      
      // OR A, dp
      case 0x04: {
        const dpOr = this.getDirectPageAddress(this.read(this.reg.PC++));
        this.reg.A |= this.read(dpOr);
        this.updateNZ(this.reg.A);
        break;
      }
      
      // OR A, (X)
      case 0x06: {
        this.reg.A |= this.read(this.getDirectPageAddress(this.reg.X));
        this.updateNZ(this.reg.A);
        break;
      }
      
      // OR A, [dp+X]
      case 0x07: {
        const dp07 = this.read(this.reg.PC++);
        const base07 = this.getDirectPageAddress((dp07 + this.reg.X) & 0xFF);
        const ptr07 = this.read(base07) | (this.read((base07 + 1) & 0xFFFF) << 8);
        this.reg.A |= this.read(ptr07);
        this.updateNZ(this.reg.A);
        break;
      }
      
      // ADC A, (X)
      case 0x86: {
        const val86 = this.read(this.getDirectPageAddress(this.reg.X));
        this.adc(val86);
        break;
      }
      
      // ADC A, [dp+X]
      case 0x87: {
        const dp87 = this.read(this.reg.PC++);
        const base87 = this.getDirectPageAddress((dp87 + this.reg.X) & 0xFF);
        const ptr87 = this.read(base87) | (this.read((base87 + 1) & 0xFFFF) << 8);
        this.adc(this.read(ptr87));
        break;
      }
      
      // XCN A - Exchange nibbles
      case 0x9F: {
        this.reg.A = ((this.reg.A >> 4) | (this.reg.A << 4)) & 0xFF;
        this.updateNZ(this.reg.A);
        break;
      }
      
      // ROR dp+X
      case 0x7B: {
        const dp7B = this.getDirectPageAddress((this.read(this.reg.PC++) + this.reg.X) & 0xFF);
        let val7B = this.read(dp7B);
        const oldC7B = this.getFlag(SPCFlag.C) ? 0x80 : 0;
        this.setFlag(SPCFlag.C, (val7B & 0x01) !== 0);
        val7B = ((val7B >> 1) | oldC7B) & 0xFF;
        this.write(dp7B, val7B);
        this.updateNZ(val7B);
        break;
      }
      
      // MOV Y, !abs
      case 0xEC: {
        const lowEC = this.read(this.reg.PC++);
        const highEC = this.read(this.reg.PC++);
        this.reg.Y = this.read((highEC << 8) | lowEC);
        this.updateNZ(this.reg.Y);
        break;
      }
      
      // CMP A, dp+X
      case 0x74: {
        const dp74 = this.getDirectPageAddress((this.read(this.reg.PC++) + this.reg.X) & 0xFF);
        const val74 = this.read(dp74);
        const result74 = this.reg.A - val74;
        this.setFlag(SPCFlag.C, this.reg.A >= val74);
        this.updateNZ(result74 & 0xFF);
        break;
      }
      
      // ADC A, dp
      case 0x84: {
        const dp84 = this.getDirectPageAddress(this.read(this.reg.PC++));
        this.adc(this.read(dp84));
        break;
      }
      
      // MOV dp(d), dp(s)
      case 0xFA: {
        const src = this.getDirectPageAddress(this.read(this.reg.PC++));
        const dest = this.getDirectPageAddress(this.read(this.reg.PC++));
        this.write(dest, this.read(src));
        break;
      }
      
      // AND A, dp
      case 0x24: {
        const dp24 = this.getDirectPageAddress(this.read(this.reg.PC++));
        this.reg.A &= this.read(dp24);
        this.updateNZ(this.reg.A);
        break;
      }
      
      // LSR dp - Logical shift right direct page
      case 0x4B: {
        const dp4B = this.getDirectPageAddress(this.read(this.reg.PC++));
        let val4B = this.read(dp4B);
        this.setFlag(SPCFlag.C, (val4B & 0x01) !== 0);
        val4B = (val4B >> 1) & 0xFF;
        this.write(dp4B, val4B);
        this.updateNZ(val4B);
        break;
      }
      
      // ASL dp - Arithmetic shift left direct page
      case 0x0B: {
        const dp0B = this.getDirectPageAddress(this.read(this.reg.PC++));
        let val0B = this.read(dp0B);
        this.setFlag(SPCFlag.C, (val0B & 0x80) !== 0);
        val0B = (val0B << 1) & 0xFF;
        this.write(dp0B, val0B);
        this.updateNZ(val0B);
        break;
      }
      
      // OR dp, #imm
      case 0x18: {
        const dp18 = this.getDirectPageAddress(this.read(this.reg.PC++));
        const imm18 = this.read(this.reg.PC++);
        const result18 = this.read(dp18) | imm18;
        this.write(dp18, result18);
        this.updateNZ(result18);
        break;
      }
      
      // CMP X, !abs
      case 0x3E: {
        const low3E = this.read(this.reg.PC++);
        const high3E = this.read(this.reg.PC++);
        const val3E = this.read((high3E << 8) | low3E);
        const result3E = this.reg.X - val3E;
        this.setFlag(SPCFlag.C, this.reg.X >= val3E);
        this.updateNZ(result3E & 0xFF);
        break;
      }
      
      // OR A, !abs+Y
      case 0x16: {
        const low16 = this.read(this.reg.PC++);
        const high16 = this.read(this.reg.PC++);
        const addr16 = ((high16 << 8) | low16) + this.reg.Y;
        this.reg.A |= this.read(addr16 & 0xFFFF);
        this.updateNZ(this.reg.A);
        break;
      }
      
      // MOV X, dp
      case 0xE9: {
        const dpE9 = this.getDirectPageAddress(this.read(this.reg.PC++));
        this.reg.X = this.read(dpE9);
        this.updateNZ(this.reg.X);
        break;
      }
      
      // CMP X, !abs (same as 0x3E, but let me verify - it is 0x1E)
      case 0x1E: {
        const low1E = this.read(this.reg.PC++);
        const high1E = this.read(this.reg.PC++);
        const val1E = this.read((high1E << 8) | low1E);
        const result1E = this.reg.X - val1E;
        this.setFlag(SPCFlag.C, this.reg.X >= val1E);
        this.updateNZ(result1E & 0xFF);
        break;
      }
      
      // CMP Y, !abs
      case 0x5E: {
        const low5E = this.read(this.reg.PC++);
        const high5E = this.read(this.reg.PC++);
        const val5E = this.read((high5E << 8) | low5E);
        const result5E = this.reg.Y - val5E;
        this.setFlag(SPCFlag.C, this.reg.Y >= val5E);
        this.updateNZ(result5E & 0xFF);
        break;
      }
      
      // OR A, !abs
      case 0x05: {
        const low05 = this.read(this.reg.PC++);
        const high05 = this.read(this.reg.PC++);
        this.reg.A |= this.read((high05 << 8) | low05);
        this.updateNZ(this.reg.A);
        break;
      }
      
      // MOV dp+X, A
      case 0xD4: {
        const dpD4 = this.getDirectPageAddress((this.read(this.reg.PC++) + this.reg.X) & 0xFF);
        this.write(dpD4, this.reg.A);
        break;
      }
      
      // MOV !abs, Y
      case 0xCC: {
        const lowCC = this.read(this.reg.PC++);
        const highCC = this.read(this.reg.PC++);
        this.write((highCC << 8) | lowCC, this.reg.Y);
        break;
      }
      
      // MOV !abs, X
      case 0xC9: {
        const lowC9 = this.read(this.reg.PC++);
        const highC9 = this.read(this.reg.PC++);
        this.write((highC9 << 8) | lowC9, this.reg.X);
        break;
      }
      
      // ROL dp
      case 0x2B: {
        const dp2B = this.getDirectPageAddress(this.read(this.reg.PC++));
        let val2B = this.read(dp2B);
        const oldC2B = this.getFlag(SPCFlag.C) ? 1 : 0;
        this.setFlag(SPCFlag.C, (val2B & 0x80) !== 0);
        val2B = ((val2B << 1) | oldC2B) & 0xFF;
        this.write(dp2B, val2B);
        this.updateNZ(val2B);
        break;
      }
      
      // AND A, !abs+Y
      case 0x36: {
        const low36 = this.read(this.reg.PC++);
        const high36 = this.read(this.reg.PC++);
        const addr36 = ((high36 << 8) | low36) + this.reg.Y;
        this.reg.A &= this.read(addr36 & 0xFFFF);
        this.updateNZ(this.reg.A);
        break;
      }
      
      // AND dp, #imm
      case 0x38: {
        const dp38 = this.getDirectPageAddress(this.read(this.reg.PC++));
        const imm38 = this.read(this.reg.PC++);
        const result38 = this.read(dp38) & imm38;
        this.write(dp38, result38);
        this.updateNZ(result38);
        break;
      }
      
      // MUL YA
      case 0xCF: {
        const result = this.reg.Y * this.reg.A;
        this.reg.A = result & 0xFF;
        this.reg.Y = (result >> 8) & 0xFF;
        this.updateNZ(this.reg.Y);
        break;
      }

      default:
        // Unknown opcode - NOP
        console.warn(`Unknown SPC700 opcode: $${opcode.toString(16).padStart(2, '0')}`);
        break;
    }
    
    return cycles;
  }
  
  private tcall(n: number): void {
    // TCALL n - Call subroutine from vector at $FFDE - 2*n
    const vectorAddr = 0xFFDE - (n * 2);
    const targetLow = this.read(vectorAddr);
    const targetHigh = this.read(vectorAddr + 1);
    const target = (targetHigh << 8) | targetLow;
    
    // Push PC
    this.pushByte((this.reg.PC >> 8) & 0xFF);
    this.pushByte(this.reg.PC & 0xFF);
    
    this.reg.PC = target;
  }
  
  private bbc(bit: number): void {
    // BBC - Branch if bit clear
    const dp = this.getDirectPageAddress(this.read(this.reg.PC++));
    const rel = this.read(this.reg.PC++);
    const val = this.read(dp);
    if ((val & (1 << bit)) === 0) {
      const offset = rel < 128 ? rel : rel - 256;
      this.reg.PC = (this.reg.PC + offset) & 0xFFFF;
    }
  }
  
  private bbs(bit: number): void {
    // BBS - Branch if bit set
    const dp = this.getDirectPageAddress(this.read(this.reg.PC++));
    const rel = this.read(this.reg.PC++);
    const val = this.read(dp);
    if ((val & (1 << bit)) !== 0) {
      const offset = rel < 128 ? rel : rel - 256;
      this.reg.PC = (this.reg.PC + offset) & 0xFFFF;
    }
  }
  
  // ============================================================================
  // Helper Instructions
  // ============================================================================
  
  private pushByte(value: number): void {
    this.write(0x100 + this.reg.SP, value);
    this.reg.SP = (this.reg.SP - 1) & 0xFF;
  }
  
  private pullByte(): number {
    this.reg.SP = (this.reg.SP + 1) & 0xFF;
    return this.read(0x100 + this.reg.SP);
  }
  
  private branch(condition: boolean): void {
    const offset = this.read(this.reg.PC++);
    if (condition) {
      const signedOffset = offset > 127 ? offset - 256 : offset;
      this.reg.PC = (this.reg.PC + signedOffset) & 0xFFFF;
    }
  }
  
  private compare(a: number, b: number): void {
    const result = a - b;
    this.setFlag(SPCFlag.C, a >= b);
    this.setFlag(SPCFlag.Z, (result & 0xFF) === 0);
    this.setFlag(SPCFlag.N, (result & 0x80) !== 0);
  }
  
  private adc(value: number): void {
    const carry = this.getFlag(SPCFlag.C) ? 1 : 0;
    const result = this.reg.A + value + carry;
    
    this.setFlag(SPCFlag.V, ((~(this.reg.A ^ value)) & (this.reg.A ^ result) & 0x80) !== 0);
    this.setFlag(SPCFlag.H, ((this.reg.A ^ value ^ result) & 0x10) !== 0);
    this.setFlag(SPCFlag.C, result > 0xFF);
    
    this.reg.A = result & 0xFF;
    this.updateNZ(this.reg.A);
  }
  
  private sbc(value: number): void {
    const carry = this.getFlag(SPCFlag.C) ? 0 : 1;
    const result = this.reg.A - value - carry;
    
    this.setFlag(SPCFlag.V, ((this.reg.A ^ value) & (this.reg.A ^ result) & 0x80) !== 0);
    this.setFlag(SPCFlag.H, ((this.reg.A ^ value ^ result) & 0x10) === 0);
    this.setFlag(SPCFlag.C, result >= 0);
    
    this.reg.A = result & 0xFF;
    this.updateNZ(this.reg.A);
  }
  
  // ============================================================================
  // Audio Generation
  // ============================================================================
  
  /**
   * Generate audio samples for the frame
   */
  generateSamples(): Float32Array {
    const mute = (this.dspRegs[DSP_REG.FLG] & 0x40) !== 0;
    
    if (mute) {
      this.sampleBuffer.fill(0);
      return this.sampleBuffer;
    }
    
    // TODO: Implement full BRR decoding and DSP processing
    // For now, return silence
    this.sampleBuffer.fill(0);
    return this.sampleBuffer;
  }
  
  getSampleBuffer(): Float32Array {
    return this.sampleBuffer;
  }
  
  // ============================================================================
  // State Management
  // ============================================================================
  
  saveState(): APUState {
    return {
      ram: new Uint8Array(this.ram),
      dspRegs: new Uint8Array(this.dspRegs),
      dspAddr: this.dspAddress,
      registers: { ...this.reg },
      ports: new Uint8Array(this.ports),
      portsFromCPU: new Uint8Array(this.portsFromCPU),
      port0: this.ports[0],
      port1: this.ports[1],
      port2: this.ports[2],
      port3: this.ports[3],
      timers: new Uint8Array(this.timerDividers),
      timerTargets: new Uint8Array(this.timerTargets),
      timerCounters: new Uint8Array(this.timerCounters),
      timerEnabled: this.timerEnabled,
      timer0: {
        target: this.timerTargets[0],
        counter: this.timerCounters[0],
        divider: this.timerDividers[0],
        enabled: (this.timerEnabled & 0x01) !== 0,
      },
      timer1: {
        target: this.timerTargets[1],
        counter: this.timerCounters[1],
        divider: this.timerDividers[1],
        enabled: (this.timerEnabled & 0x02) !== 0,
      },
      timer2: {
        target: this.timerTargets[2],
        counter: this.timerCounters[2],
        divider: this.timerDividers[2],
        enabled: (this.timerEnabled & 0x04) !== 0,
      },
      cycles: this.cycles,
    };
  }
  
  loadState(state: APUState): void {
    this.ram.set(state.ram);
    this.dspRegs.set(state.dspRegs);
    this.reg = { ...state.registers };
    this.ports.set(state.ports);
    this.portsFromCPU.set(state.portsFromCPU);
    this.timerDividers.set(state.timers);
    this.timerTargets.set(state.timerTargets);
    this.timerCounters.set(state.timerCounters);
    this.timerEnabled = state.timerEnabled;
    this.cycles = state.cycles;
  }
  
  // Debug helpers
  getRegisters(): SPC700Registers {
    return { ...this.reg };
  }
  
  getRAM(): Uint8Array {
    return this.ram;
  }
  
  // ============================================================================
  // Public Memory Access (for testing)
  // ============================================================================
  
  /**
   * Public read interface for testing
   */
  readMemory(address: number): number {
    return this.read(address);
  }
  
  /**
   * Public write interface for testing
   */
  writeMemory(address: number, value: number): void {
    this.write(address, value);
  }
  
  /**
   * Write to APU from main CPU (alias for writePort)
   */
  writeCPUPort(port: number, value: number): void {
    this.writePort(port, value);
  }
  
  /**
   * Read from APU to main CPU (alias for readPort)
   */
  readCPUPort(port: number): number {
    return this.readPort(port);
  }
  
  /**
   * Get audio buffer (alias for getSampleBuffer)
   */
  getAudioBuffer(): Float32Array {
    return this.sampleBuffer;
  }
  
  /**
   * Get debug info for APU state
   */
  getDebugInfo(): {
    PC: number;
    A: number;
    X: number;
    Y: number;
    SP: number;
    PSW: number;
    cycles: number;
    ports: number[];
    portsFromCPU: number[];
    iplEnabled: boolean;
  } {
    return {
      PC: this.reg.PC,
      A: this.reg.A,
      X: this.reg.X,
      Y: this.reg.Y,
      SP: this.reg.SP,
      PSW: this.reg.PSW,
      cycles: this.cycles,
      ports: Array.from(this.ports),
      portsFromCPU: Array.from(this.portsFromCPU),
      iplEnabled: this.iplEnabled,
    };
  }
  
  /**
   * Get current APU state (returns copy for serialization)
   */
  getState(): APUState {
    return this.saveState();
  }
  
  /**
   * Get mutable state reference for testing (returns direct references)
   */
  getMutableState(): { ram: Uint8Array; registers: SPC700Registers } {
    return {
      ram: this.ram,
      registers: this.reg,
    };
  }
  
  /**
   * Disable IPL ROM for testing (allows direct RAM execution)
   */
  disableIPL(): void {
    this.iplEnabled = false;
  }
  
  /**
   * Set PC for testing
   */
  setPC(address: number): void {
    this.reg.PC = address & 0xFFFF;
  }
}
