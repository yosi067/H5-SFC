/**
 * Project 16-bit: SFC Emulator
 * APU (Audio Processing Unit) - SPC700 Core
 * 
 * The SNES APU consists of:
 * - SPC700 CPU running at ~1.024 MHz
 * - Sony DSP for audio synthesis
 * - 64KB of Audio RAM
 * - 4 communication ports with main CPU
 */

// ============================================================================
// SPC700 Constants
// ============================================================================

export const SPC700_CONSTANTS = {
  CLOCK_RATE: 1024000,         // ~1.024 MHz
  RAM_SIZE: 0x10000,           // 64KB
  SAMPLE_RATE: 32000,          // 32 kHz output
  SAMPLES_PER_FRAME: 534,      // ~32000 / 60
  RESET_VECTOR: 0xFFC0,        // IPL ROM entry point
  
  // Register addresses in page $00F0-$00FF
  REG_TEST: 0xF0,
  REG_CONTROL: 0xF1,
  REG_DSPADDR: 0xF2,
  REG_DSPDATA: 0xF3,
  REG_PORT0: 0xF4,
  REG_PORT1: 0xF5,
  REG_PORT2: 0xF6,
  REG_PORT3: 0xF7,
  REG_TIMER0: 0xFA,
  REG_TIMER1: 0xFB,
  REG_TIMER2: 0xFC,
  REG_COUNTER0: 0xFD,
  REG_COUNTER1: 0xFE,
  REG_COUNTER2: 0xFF,
} as const;

// ============================================================================
// SPC700 Status Flags
// ============================================================================

export enum SPCFlag {
  C = 0x01,  // Carry
  Z = 0x02,  // Zero
  I = 0x04,  // Interrupt disable
  H = 0x08,  // Half-carry
  B = 0x10,  // Break
  P = 0x20,  // Direct page
  V = 0x40,  // Overflow
  N = 0x80,  // Negative
}

// ============================================================================
// DSP Register Constants
// ============================================================================

export const DSP_REG = {
  // Voice registers (v = 0-7)
  VOL_L: 0x00,    // Left volume
  VOL_R: 0x01,    // Right volume
  PITCH_L: 0x02,  // Pitch low
  PITCH_H: 0x03,  // Pitch high
  SRCN: 0x04,     // Source number
  ADSR1: 0x05,    // ADSR settings 1
  ADSR2: 0x06,    // ADSR settings 2
  GAIN: 0x07,     // GAIN settings
  ENVX: 0x08,     // Current envelope (read)
  OUTX: 0x09,     // Current sample (read)
  
  // Voice 0 register aliases (for test compatibility)
  V0VOLL: 0x00,
  V0VOLR: 0x01,
  V0PITCHL: 0x02,
  V0PITCHH: 0x03,
  V0SRCN: 0x04,
  V0ADSR1: 0x05,
  V0ADSR2: 0x06,
  V0GAIN: 0x07,
  V0ENVX: 0x08,
  V0OUTX: 0x09,
  
  // Global registers
  MVOL_L: 0x0C,   // Main volume left
  MVOL_R: 0x1C,   // Main volume right
  MVOLL: 0x0C,    // Alias
  MVOLR: 0x1C,    // Alias
  EVOL_L: 0x2C,   // Echo volume left
  EVOL_R: 0x3C,   // Echo volume right
  EVOLL: 0x2C,    // Alias
  EVOLR: 0x3C,    // Alias
  KON: 0x4C,      // Key on
  KOFF: 0x5C,     // Key off
  FLG: 0x6C,      // Flags (noise, echo, mute, reset)
  ENDX: 0x7C,     // Voice end flags
  
  EFB: 0x0D,      // Echo feedback
  PMON: 0x2D,     // Pitch modulation
  NON: 0x3D,      // Noise enable
  EON: 0x4D,      // Echo enable
  DIR: 0x5D,      // Sample directory offset
  ESA: 0x6D,      // Echo buffer offset
  EDL: 0x7D,      // Echo delay
  
  // FIR filter coefficients
  FIR0: 0x0F,
  FIR1: 0x1F,
  FIR2: 0x2F,
  FIR3: 0x3F,
  FIR4: 0x4F,
  FIR5: 0x5F,
  FIR6: 0x6F,
  FIR7: 0x7F,
} as const;

// ============================================================================
// SPC700 Registers
// ============================================================================

export interface SPC700Registers {
  A: number;     // Accumulator
  X: number;     // Index X
  Y: number;     // Index Y
  SP: number;    // Stack pointer
  PC: number;    // Program counter
  PSW: number;   // Processor status word
}

// ============================================================================
// Voice State
// ============================================================================

export interface VoiceState {
  // Sample playback
  sampleAddress: number;
  sampleOffset: number;
  sampleBuffer: Int16Array;
  bufferOffset: number;
  
  // Pitch
  pitch: number;
  pitchCounter: number;
  
  // Envelope
  envelope: number;
  envelopeMode: 'attack' | 'decay' | 'sustain' | 'release';
  adsrRate: number;
  
  // BRR decode state
  brrHeader: number;
  brrShift: number;
  brrFilter: number;
  brrEnd: boolean;
  brrLoop: boolean;
  
  // Previous samples for interpolation
  prevSamples: Int16Array;
  
  // Output
  output: number;
  enabled: boolean;
}

// ============================================================================
// Timer State
// ============================================================================

export interface TimerState {
  target: number;
  counter: number;
  divider: number;
  enabled: boolean;
}

// ============================================================================
// SPC700 State (for save states)
// ============================================================================

export interface APUState {
  ram: Uint8Array;
  dspRegs: Uint8Array;
  dspAddr: number;  // Current DSP address register
  registers: SPC700Registers;
  
  // Communication ports
  ports: Uint8Array;
  portsFromCPU: Uint8Array;
  port0: number;
  port1: number;
  port2: number;
  port3: number;
  
  // Timers (array format)
  timers: Uint8Array;
  timerTargets: Uint8Array;
  timerCounters: Uint8Array;
  timerEnabled: number;
  
  // Timer structured format (for testing)
  timer0: TimerState;
  timer1: TimerState;
  timer2: TimerState;
  
  // Cycle counter
  cycles: number;
}
