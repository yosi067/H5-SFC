/**
 * Project 16-bit: SFC Emulator
 * CPU Types & Constants for 65C816 Processor
 */

// ============================================================================
// CPU Status Flags (P Register)
// ============================================================================

export enum StatusFlag {
  C = 0x01,  // Carry
  Z = 0x02,  // Zero
  I = 0x04,  // IRQ Disable
  D = 0x08,  // Decimal Mode
  X = 0x10,  // Index Register Size (0=16-bit, 1=8-bit) [Native mode only]
  M = 0x20,  // Accumulator Size (0=16-bit, 1=8-bit) [Native mode only]
  V = 0x40,  // Overflow
  N = 0x80,  // Negative
  // Emulation mode uses B (Break) instead of X at position 0x10
  B = 0x10,  // Break [Emulation mode only]
}

// ============================================================================
// CPU Registers
// ============================================================================

export interface CPURegisters {
  // Accumulator (16-bit, can be accessed as 8-bit A with hidden B)
  A: number;   // Full 16-bit accumulator
  
  // Index Registers (16-bit capable)
  X: number;   // Index X
  Y: number;   // Index Y
  
  // Stack Pointer (16-bit in native mode, 8-bit + $01xx in emulation)
  SP: number;
  
  // Direct Page Register (16-bit)
  D: number;
  
  // Data Bank Register (8-bit) - Used for data access
  DB: number;
  
  // Program Bank Register (8-bit) - Used for instruction fetch
  PB: number;
  
  // Program Counter (16-bit)
  PC: number;
  
  // Processor Status (8-bit)
  P: number;
  
  // Emulation Mode Flag (not part of P register)
  E: boolean;
}

// ============================================================================
// Addressing Modes
// ============================================================================

export enum AddressingMode {
  IMPLIED,
  ACCUMULATOR,
  IMMEDIATE_M,            // #const (size depends on M flag)
  IMMEDIATE_X,            // #const (size depends on X flag)
  IMMEDIATE_8,            // #const (always 8-bit)
  ABSOLUTE,               // addr
  ABSOLUTE_LONG,          // long
  ABSOLUTE_X,             // addr,X
  ABSOLUTE_LONG_X,        // long,X
  ABSOLUTE_Y,             // addr,Y
  DIRECT,                 // dp
  DIRECT_X,               // dp,X
  DIRECT_Y,               // dp,Y
  DIRECT_INDIRECT,        // (dp)
  DIRECT_INDIRECT_LONG,   // [dp]
  DIRECT_X_INDIRECT,      // (dp,X)
  DIRECT_INDIRECT_Y,      // (dp),Y
  DIRECT_INDIRECT_LONG_Y, // [dp],Y
  STACK_RELATIVE,         // sr,S
  STACK_RELATIVE_Y,       // (sr,S),Y
  RELATIVE_8,             // nearlabel (8-bit offset)
  RELATIVE_16,            // label (16-bit offset)
  BLOCK_MOVE,             // srcbk,destbk
  ABSOLUTE_INDIRECT,      // (addr)
  ABSOLUTE_INDIRECT_LONG, // [addr]
  ABSOLUTE_X_INDIRECT,    // (addr,X)
}

// ============================================================================
// Interrupt Types
// ============================================================================

export enum InterruptType {
  NONE = 0,
  IRQ = 1,
  NMI = 2,
  BRK = 3,
  COP = 4,
  ABORT = 5,
  RESET = 6,
}

// ============================================================================
// Interrupt Vectors
// ============================================================================

export const INTERRUPT_VECTORS = {
  // Native Mode Vectors (at bank $00)
  NATIVE: {
    COP:   0xFFE4,
    BRK:   0xFFE6,
    ABORT: 0xFFE8,
    NMI:   0xFFEA,
    IRQ:   0xFFEE,
  },
  // Emulation Mode Vectors (at bank $00)
  EMULATION: {
    COP:   0xFFF4,
    ABORT: 0xFFF8,
    NMI:   0xFFFA,
    RESET: 0xFFFC,
    IRQ:   0xFFFE,  // Also BRK in emulation mode
  },
} as const;

// ============================================================================
// CPU State for Save States
// ============================================================================

export interface CPUState {
  registers: CPURegisters;
  cycles: number;
  halted: boolean;
  waitingForInterrupt: boolean;
  pendingInterrupt: InterruptType;
}

// ============================================================================
// Timing Constants
// ============================================================================

export const CPU_TIMING = {
  MASTER_CLOCK_NTSC: 21477272,  // Hz
  MASTER_CLOCK_PAL: 21281370,   // Hz
  
  CPU_CLOCK_DIVIDER: 6,         // Master / 6 = ~3.58 MHz
  
  CYCLES_PER_SCANLINE: 1364,
  SCANLINES_PER_FRAME_NTSC: 262,
  SCANLINES_PER_FRAME_PAL: 312,
  
  // Fast/Slow ROM access cycles
  FAST_ROM_CYCLES: 6,
  SLOW_ROM_CYCLES: 8,
} as const;

// ============================================================================
// Memory Access Speed Regions
// ============================================================================

export enum MemorySpeed {
  FAST = 6,   // 2.68 MHz access
  SLOW = 8,   // 3.58 MHz access
  XSLOW = 12, // Extra slow (open bus, etc.)
}
