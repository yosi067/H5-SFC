/**
 * Project 16-bit: SFC Emulator
 * Main Emulator Class
 * 
 * System integrator that ties CPU, PPU, APU, Memory, and Chips together
 */

import { CPU65C816 } from './core/cpu/cpu65c816';
import { PPU } from './core/ppu/ppu';
import { APU } from './core/apu/apu';
import { SNESMemoryBus } from './core/memory/memoryBus';
import { ChipManager, parseROMHeader, ROMHeader } from './core/chips/chipManager';
import { ROMLoader } from './core/loader/romLoader';
import type { LoadedROM, LoadResult } from './core/loader/romLoader';
import { EventEmitter } from 'eventemitter3';

// Re-export loader utilities
export { ROMLoader } from './core/loader/romLoader';
export type { LoadedROM, LoadResult } from './core/loader/romLoader';
export { loadROMFile, loadROMFromURL, loadROMData, getSupportedFormats } from './core/loader/romLoader';

// ============================================================================
// Types
// ============================================================================

export interface EmulatorConfig {
  /** Target frames per second (default: 60 for NTSC) */
  targetFPS: number;
  /** Enable audio emulation */
  enableAudio: boolean;
  /** Audio sample rate */
  sampleRate: number;
  /** Enable frame limiting */
  frameLimiting: boolean;
  /** Enable save states */
  enableSaveStates: boolean;
  /** Maximum speed multiplier (for fast forward) */
  maxSpeedMultiplier: number;
}

export interface EmulatorState {
  cpu: unknown;
  ppu: unknown;
  apu: unknown;
  memory: unknown;
  chips: unknown;
  romHeader: ROMHeader | null;
  frameCount: number;
}

export interface InputState {
  player1: ControllerState;
  player2: ControllerState;
}

export interface ControllerState {
  a: boolean;
  b: boolean;
  x: boolean;
  y: boolean;
  l: boolean;
  r: boolean;
  start: boolean;
  select: boolean;
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export type EmulatorEvent = 
  | 'frame'      // New frame ready
  | 'audio'      // Audio buffer ready
  | 'reset'      // Emulator reset
  | 'loadROM'    // ROM loaded
  | 'saveState'  // State saved
  | 'loadState'; // State loaded

// ============================================================================
// Constants
// ============================================================================

const NTSC_MASTER_CLOCK = 21477272;  // 21.477272 MHz
const PAL_MASTER_CLOCK = 21281370;   // 21.28137 MHz

const NTSC_CPU_DIVIDER = 6;          // CPU runs at master/6 = 3.58 MHz
const PPU_DIVIDER = 4;               // PPU runs at master/4 = 5.37 MHz
const APU_CYCLES_PER_CPU_CYCLE = 1;  // APU runs at 1.024 MHz

const SCANLINES_PER_FRAME_NTSC = 262;
const SCANLINES_PER_FRAME_PAL = 312;

const DOTS_PER_SCANLINE = 341;
const VBLANK_SCANLINE = 225;

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: EmulatorConfig = {
  targetFPS: 60,
  enableAudio: true,
  sampleRate: 44100,
  frameLimiting: true,
  enableSaveStates: true,
  maxSpeedMultiplier: 4
};

// ============================================================================
// Emulator Class
// ============================================================================

export class Emulator extends EventEmitter<EmulatorEvent> {
  // Components
  private cpu!: CPU65C816;
  private ppu!: PPU;
  private apu!: APU;
  private memory!: SNESMemoryBus;
  private chipManager!: ChipManager;
  
  // ROM data
  private rom: Uint8Array | null = null;
  private romHeader: ROMHeader | null = null;
  
  // Configuration
  private config: EmulatorConfig;
  
  // State
  private running: boolean = false;
  private paused: boolean = false;
  private frameCount: number = 0;
  private totalCycles: number = 0;
  private speedMultiplier: number = 1;
  
  // Timing
  private lastFrameTime: number = 0;
  private frameTimeAccumulator: number = 0;
  private targetFrameTime: number;
  
  // Input
  private inputState: InputState;
  
  // Animation frame ID for cancellation
  private animationFrameId: number | null = null;
  
  constructor(config: Partial<EmulatorConfig> = {}) {
    super();
    
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.targetFrameTime = 1000 / this.config.targetFPS;
    
    this.inputState = {
      player1: this.createEmptyControllerState(),
      player2: this.createEmptyControllerState()
    };
    
    this.initializeComponents();
  }
  
  // ============================================================================
  // Initialization
  // ============================================================================
  
  private initializeComponents(): void {
    this.memory = new SNESMemoryBus();
    this.cpu = new CPU65C816(this.memory);
    this.ppu = new PPU();
    this.apu = new APU();
    this.chipManager = new ChipManager();
    
    // Connect components using callbacks
    this.memory.setPPUCallbacks(
      (address: number) => this.ppu.readRegister(address),
      (address: number, value: number) => this.ppu.writeRegister(address, value),
      () => this.ppu.isInVBlank(),
      () => this.ppu.isInHBlank()
    );
    this.memory.setAPUCallbacks(
      (port: number) => this.apu.readPort(port),
      (port: number, value: number) => this.apu.writePort(port, value)
    );
    this.memory.setChipManager(this.chipManager);
  }
  
  private createEmptyControllerState(): ControllerState {
    return {
      a: false, b: false, x: false, y: false,
      l: false, r: false,
      start: false, select: false,
      up: false, down: false, left: false, right: false
    };
  }
  
  // ============================================================================
  // ROM Loading
  // ============================================================================
  
  /**
   * Load ROM from raw Uint8Array data
   */
  loadROM(data: Uint8Array): boolean {
    try {
      this.rom = data;
      
      // Parse ROM header
      this.romHeader = parseROMHeader(data);
      console.log(`Loaded: ${this.romHeader.title}`);
      console.log(`Map Mode: ${this.romHeader.mapMode}`);
      console.log(`ROM Size: ${this.romHeader.romSize}KB`);
      console.log(`Enhancement Chip: ${this.romHeader.enhancementChip || 'None'}`);
      
      // Load ROM into memory
      this.memory.loadROM(data, this.romHeader.isHiROM, this.romHeader.isFastROM);
      
      // Debug: Check reset vector
      const resetLow = this.memory.read(0x00, 0xFFFC);
      const resetHigh = this.memory.read(0x00, 0xFFFD);
      const resetVector = (resetHigh << 8) | resetLow;
      console.log(`Reset vector: $${resetVector.toString(16).padStart(4, '0')}`);
      
      // Initialize enhancement chips
      this.chipManager.loadROM(data);
      
      // Reset all components
      this.reset();
      
      this.emit('loadROM');
      return true;
    } catch (error) {
      console.error('Failed to load ROM:', error);
      return false;
    }
  }
  
  /**
   * Load ROM from a File object (for browser file input)
   * Supports .smc, .sfc, .fig, .swc, and .zip files
   */
  async loadROMFile(file: File): Promise<boolean> {
    const result = await ROMLoader.loadFromFile(file);
    
    if (!result.success || !result.rom) {
      console.error('Failed to load ROM file:', result.error);
      return false;
    }
    
    console.log(`File: ${result.rom.filename}`);
    console.log(`Format: ${result.rom.format}`);
    if (result.rom.hadHeader) {
      console.log('SMC copier header detected and removed');
    }
    
    return this.loadROM(result.rom.data);
  }
  
  /**
   * Load ROM from a URL
   * Supports .smc, .sfc, .fig, .swc, and .zip files
   */
  async loadROMFromURL(url: string): Promise<boolean> {
    const result = await ROMLoader.loadFromURL(url);
    
    if (!result.success || !result.rom) {
      console.error('Failed to load ROM from URL:', result.error);
      return false;
    }
    
    console.log(`Loaded from: ${url}`);
    console.log(`Format: ${result.rom.format}`);
    if (result.rom.hadHeader) {
      console.log('SMC copier header detected and removed');
    }
    
    return this.loadROM(result.rom.data);
  }
  
  /**
   * Get list of supported ROM file formats
   */
  static getSupportedFormats(): string[] {
    return ROMLoader.getSupportedFormats();
  }
  
  // ============================================================================
  // Control
  // ============================================================================
  
  reset(): void {
    this.cpu.reset();
    this.ppu.reset();
    this.apu.reset();
    this.chipManager.reset();
    
    this.frameCount = 0;
    this.totalCycles = 0;
    
    this.emit('reset');
  }
  
  run(): void {
    if (this.running) return;
    if (!this.rom) {
      console.error('No ROM loaded');
      return;
    }
    
    this.running = true;
    this.paused = false;
    this.lastFrameTime = performance.now();
    
    this.mainLoop();
  }
  
  pause(): void {
    this.paused = true;
  }
  
  resume(): void {
    if (!this.running) {
      this.run();
    } else {
      this.paused = false;
      this.lastFrameTime = performance.now();
    }
  }
  
  stop(): void {
    this.running = false;
    this.paused = false;
    
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }
  
  // ============================================================================
  // Main Loop
  // ============================================================================
  
  private mainLoop(): void {
    if (!this.running) return;
    
    const currentTime = performance.now();
    const deltaTime = currentTime - this.lastFrameTime;
    this.lastFrameTime = currentTime;
    
    if (!this.paused) {
      if (this.config.frameLimiting) {
        this.frameTimeAccumulator += deltaTime * this.speedMultiplier;
        
        while (this.frameTimeAccumulator >= this.targetFrameTime) {
          this.runFrame();
          this.frameTimeAccumulator -= this.targetFrameTime;
        }
      } else {
        // Run as fast as possible
        for (let i = 0; i < this.speedMultiplier; i++) {
          this.runFrame();
        }
      }
    }
    
    this.animationFrameId = requestAnimationFrame(() => this.mainLoop());
  }
  
  /**
   * Run a single frame of emulation
   */
  runFrame(): void {
    // Run CPU/PPU until PPU reaches VBlank of next frame
    // Get the current PPU frame number
    const startFrame = this.ppu.getFrameCount();
    
    // Keep running until PPU advances to the next frame
    while (this.ppu.getFrameCount() === startFrame) {
      this.runScanlineCycles();
    }
    
    this.frameCount++;
    this.emit('frame');
  }
  
  private runScanlineCycles(): void {
    // Run one scanline worth of cycles
    // Each scanline is approximately 227 CPU cycles (341 dots / 1.5)
    const cyclesPerScanline = Math.floor(DOTS_PER_SCANLINE * PPU_DIVIDER / NTSC_CPU_DIVIDER);
    const prevScanline = this.ppu.getScanline();
    
    let cyclesRemaining = cyclesPerScanline;
    
    while (cyclesRemaining > 0) {
      // Run CPU
      const cpuCycles = this.cpu.step(1);
      cyclesRemaining -= cpuCycles;
      this.totalCycles += cpuCycles;
      
      // Run PPU (catch-up): 1 CPU cycle = NTSC_CPU_DIVIDER/PPU_DIVIDER PPU dots
      const ppuDots = Math.ceil(cpuCycles * NTSC_CPU_DIVIDER / PPU_DIVIDER);
      this.ppu.step(ppuDots);
      
      // Check if PPU just entered VBlank (scanline transition)
      const currentScanline = this.ppu.getScanline();
      if (currentScanline === VBLANK_SCANLINE && prevScanline !== VBLANK_SCANLINE) {
        // Trigger NMI if enabled
        if (this.memory.isNMIEnabled()) {
          this.cpu.triggerNMI();
        }
      }
      
      // Run APU (catch-up): Convert CPU cycles to master cycles
      // CPU runs at master/6, APU expects master cycles
      this.apu.step(cpuCycles * NTSC_CPU_DIVIDER);
      
      // Run enhancement chips
      this.chipManager.step(cpuCycles);
    }
  }
  
  // ============================================================================
  // Input
  // ============================================================================
  
  setButton(player: 1 | 2, button: keyof ControllerState, pressed: boolean): void {
    const controller = player === 1 ? this.inputState.player1 : this.inputState.player2;
    controller[button] = pressed;
    
    // Update memory-mapped controller registers
    this.updateControllerRegisters();
  }
  
  getInput(): InputState {
    return this.inputState;
  }
  
  private updateControllerRegisters(): void {
    // Convert controller state to SNES joypad register format
    const joy1 = this.controllerStateToJoypadData(this.inputState.player1);
    const joy2 = this.controllerStateToJoypadData(this.inputState.player2);
    
    this.memory.setJoypadData(0, joy1);
    this.memory.setJoypadData(1, joy2);
  }
  
  private controllerStateToJoypadData(state: ControllerState): number {
    // SNES joypad format (16 bits):
    // B Y Select Start Up Down Left Right A X L R (4 unused)
    let data = 0;
    
    if (state.b)      data |= 0x8000;
    if (state.y)      data |= 0x4000;
    if (state.select) data |= 0x2000;
    if (state.start)  data |= 0x1000;
    if (state.up)     data |= 0x0800;
    if (state.down)   data |= 0x0400;
    if (state.left)   data |= 0x0200;
    if (state.right)  data |= 0x0100;
    if (state.a)      data |= 0x0080;
    if (state.x)      data |= 0x0040;
    if (state.l)      data |= 0x0020;
    if (state.r)      data |= 0x0010;
    
    return data;
  }
  
  // ============================================================================
  // Output
  // ============================================================================
  
  getFrameBuffer(): Uint8ClampedArray {
    return this.ppu.getFrameBuffer();
  }
  
  getAudioBuffer(): Float32Array {
    return this.apu.getAudioBuffer();
  }
  
  /**
   * Get PPU debug info
   */
  getPPUDebugInfo(): any {
    return this.ppu.getDebugInfo();
  }
  
  /**
   * Get CPU debug info
   */
  getCPUDebugInfo(): any {
    if (!this.cpu) {
      return { error: 'CPU not initialized' };
    }
    const regs = this.cpu.getRegisters();
    if (!regs) {
      return { error: 'No registers' };
    }
    
    // Get opcode at current PC
    const pb = regs.PB ?? 0;
    const pc = regs.PC ?? 0;
    const opcode = this.memory.read(pb, pc);
    
    return {
      PC: (regs.PC ?? 0).toString(16).padStart(4, '0'),
      PB: (regs.PB ?? 0).toString(16).padStart(2, '0'),
      A: (regs.A ?? 0).toString(16).padStart(4, '0'),
      X: (regs.X ?? 0).toString(16).padStart(4, '0'),
      Y: (regs.Y ?? 0).toString(16).padStart(4, '0'),
      SP: (regs.SP ?? 0).toString(16).padStart(4, '0'),
      DP: (regs.DP ?? 0).toString(16).padStart(4, '0'),
      DB: (regs.DB ?? 0).toString(16).padStart(2, '0'),
      P: (regs.P ?? 0).toString(16).padStart(2, '0'),
      E: regs.E ?? true,
      totalCycles: this.cpu.getTotalCycles().toString(),
      opcode: opcode.toString(16).padStart(2, '0'),
      waiting: this.cpu.isWaitingForInterrupt(),
      halted: this.cpu.isHalted(),
      nmiEnabled: this.memory.isNMIEnabled(),
    };
  }
  
  /**
   * Get CPU execution trace log
   */
  getTraceLog(): string[] {
    return this.cpu.getTraceLog();
  }
  
  /**
   * Enable CPU execution trace with specified buffer size
   */
  enableTrace(maxInstructions: number = 200): void {
    this.cpu.enableTrace(maxInstructions);
  }
  
  /**
   * Get APU debug info
   */
  getAPUDebugInfo() {
    return this.apu.getDebugInfo();
  }
  
  // ============================================================================
  // State Management
  // ============================================================================
  
  saveState(): EmulatorState {
    const state: EmulatorState = {
      cpu: this.cpu.saveState(),
      ppu: this.ppu.saveState(),
      apu: this.apu.saveState(),
      memory: this.memory.saveState(),
      chips: this.chipManager.saveState(),
      romHeader: this.romHeader,
      frameCount: this.frameCount
    };
    
    this.emit('saveState');
    return state;
  }
  
  loadState(state: EmulatorState): void {
    this.cpu.loadState(state.cpu);
    this.ppu.loadState(state.ppu);
    this.apu.loadState(state.apu);
    this.memory.loadState(state.memory);
    this.chipManager.loadState(state.chips);
    this.frameCount = state.frameCount;
    
    this.emit('loadState');
  }
  
  // ============================================================================
  // Configuration
  // ============================================================================
  
  setSpeed(multiplier: number): void {
    this.speedMultiplier = Math.min(
      Math.max(multiplier, 0.25),
      this.config.maxSpeedMultiplier
    );
  }
  
  getSpeed(): number {
    return this.speedMultiplier;
  }
  
  setFrameLimiting(enabled: boolean): void {
    this.config.frameLimiting = enabled;
  }
  
  // ============================================================================
  // Debug
  // ============================================================================
  
  getCPURegisters() {
    return this.cpu.getRegisters();
  }
  
  getPPUState() {
    return this.ppu.getState();
  }
  
  getAPUState() {
    return this.apu.getState();
  }
  
  getROMHeader(): ROMHeader | null {
    return this.romHeader;
  }
  
  getFrameCount(): number {
    return this.frameCount;
  }
  
  getTotalCycles(): number {
    return this.totalCycles;
  }
  
  isRunning(): boolean {
    return this.running;
  }
  
  isPaused(): boolean {
    return this.paused;
  }
  
  // Step one CPU instruction (for debugging)
  stepInstruction(): void {
    const cpuCycles = this.cpu.step(1);
    this.totalCycles += cpuCycles;
    
    // Run PPU
    const ppuDots = Math.ceil(cpuCycles * NTSC_CPU_DIVIDER / PPU_DIVIDER);
    this.ppu.step(ppuDots);
    
    // Run APU
    this.apu.step(cpuCycles * NTSC_CPU_DIVIDER);
    
    // Run enhancement chips
    this.chipManager.step(cpuCycles);
  }
  
  // Step one scanline (for debugging)
  stepScanline(): void {
    this.runScanline();
  }
  
  // Step one frame (for debugging)
  stepFrame(): void {
    this.runFrame();
  }
}

// ============================================================================
// Exports
// ============================================================================

export { CPU65C816 } from './core/cpu/cpu65c816';
export { PPU } from './core/ppu/ppu';
export { APU } from './core/apu/apu';
export { SNESMemoryBus, SNESMemoryBus as MemoryBus } from './core/memory/memoryBus';
export { ChipManager, ChipRegistry, parseROMHeader } from './core/chips/chipManager';
export { SA1Chip } from './core/chips/sa1';
export { DSP1Chip } from './core/chips/dsp1';

export * from './core/cpu/types';
export * from './core/ppu/types';
export * from './core/apu/types';
