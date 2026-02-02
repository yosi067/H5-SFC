/**
 * Project 16-bit: SFC Emulator
 * DSP-1 Enhancement Chip Implementation
 * 
 * The DSP-1 is a math coprocessor used primarily for:
 * - Mode 7 3D calculations (Super Mario Kart, Pilotwings)
 * - Trigonometry (sin, cos, atan)
 * - Matrix operations
 * - Perspective projection
 */

import {
  EnhancementChip,
  ChipType,
  ChipState,
  chipRegistry,
} from './chipManager';

// DSP-1 Commands
enum DSP1Command {
  MULTIPLY = 0x00,
  INVERSE = 0x10,
  TRIANGLE = 0x04,
  RADIUS = 0x08,
  RANGE = 0x18,
  DISTANCE = 0x28,
  ROTATE = 0x0C,
  POLAR = 0x1C,
  PROJECT = 0x06,
  PARAMETER = 0x0A,
  RASTER = 0x1A,
  TARGET = 0x0E,
  SUBJECTIVE = 0x02,
  SCALAR = 0x12,
  GYRATE = 0x14,
  MEMORY_TEST = 0x1F,
}

export class DSP1Chip implements EnhancementChip {
  readonly name = 'DSP-1';
  readonly type = ChipType.DSP1;
  readonly chipId = 'DSP-1';
  readonly baseAddress = 0x6000;
  
  // Status
  private waiting: boolean = false;
  private busy: boolean = false;
  
  // Command state
  private command: number = 0;
  private inputIndex: number = 0;
  private inputByteIndex: number = 0;  // Byte-level index for 16-bit word assembly
  private outputIndex: number = 0;
  private inputBuffer: Int16Array = new Int16Array(32);
  private outputBuffer: Int16Array = new Int16Array(32);
  private inputSize: number = 0;
  private outputSize: number = 0;
  
  // Precomputed tables for faster trig
  private sinTable: Float64Array = new Float64Array(512);
  private cosTable: Float64Array = new Float64Array(512);
  
  // Center position for projection
  private centerX: number = 0;
  private centerY: number = 0;
  private centerZ: number = 0;
  
  // Attitude angles
  private azimuth: number = 0;
  private zenith: number = 0;
  private tilt: number = 0;
  
  // Precalculated matrix values
  private matrixA: number = 0;
  private matrixB: number = 0;
  private matrixC: number = 0;
  private matrixD: number = 0;
  
  // View distance
  private viewDistance: number = 0;
  
  // Raster parameters
  private rasterCoeffA: number = 0;
  private rasterCoeffB: number = 0;
  private rasterCoeffC: number = 0;
  private rasterCoeffD: number = 0;
  
  constructor() {
    this.initTables();
  }
  
  private initTables(): void {
    // Precompute sine/cosine tables (512 entries = 360 degrees)
    for (let i = 0; i < 512; i++) {
      const angle = (i * Math.PI * 2) / 512;
      this.sinTable[i] = Math.sin(angle);
      this.cosTable[i] = Math.cos(angle);
    }
  }
  
  // ============================================================================
  // Lifecycle
  // ============================================================================
  
  init(rom: Uint8Array, sram: Uint8Array): void {
    this.reset();
  }
  
  reset(): void {
    this.waiting = false;
    this.busy = false;
    this.command = 0;
    this.inputIndex = 0;
    this.outputIndex = 0;
    this.inputBuffer.fill(0);
    this.outputBuffer.fill(0);
    this.inputSize = 0;
    this.outputSize = 0;
    
    this.centerX = 0;
    this.centerY = 0;
    this.centerZ = 0;
    this.azimuth = 0;
    this.zenith = 0;
    this.tilt = 0;
    this.viewDistance = 0;
  }
  
  // ============================================================================
  // Memory Mapping
  // ============================================================================
  
  handles(bank: number, address: number): boolean {
    // DSP-1 is typically mapped to:
    // LoROM: banks $20-$3F, $A0-$BF at $8000-$FFFF
    // And status at banks $00-$1F at $6000-$7FFF
    
    if ((bank >= 0x00 && bank <= 0x1F) || 
        (bank >= 0x80 && bank <= 0x9F)) {
      if (address >= 0x6000 && address <= 0x7FFF) {
        return true;
      }
    }
    
    if ((bank >= 0x20 && bank <= 0x3F) || 
        (bank >= 0xA0 && bank <= 0xBF)) {
      if (address >= 0x8000 && address <= 0xFFFF) {
        return true;
      }
    }
    
    return false;
  }
  
  read(bank: number, address: number): number {
    // Status read
    if (address & 0x0001) {
      return this.getStatus();
    }
    
    // Data read
    return this.readData();
  }
  
  write(bank: number, address: number, value: number): void {
    // Data write
    this.writeData(value);
  }
  
  private getStatus(): number {
    let status = 0;
    
    // Bit 7: Data available (output ready)
    if (this.outputIndex < this.outputSize) {
      status |= 0x80;
    }
    
    // Bit 6: Waiting for command/data
    if (!this.waiting) {
      status |= 0x40;
    }
    
    // Bit 0: Busy processing
    if (this.busy) {
      status |= 0x01;
    }
    
    return status;
  }
  
  private readData(): number {
    if (this.outputIndex >= this.outputSize * 2) {
      return 0x00;
    }
    
    const wordIndex = Math.floor(this.outputIndex / 2);
    const value = this.outputBuffer[wordIndex];
    
    // Return low byte first, then high byte
    if ((this.outputIndex & 1) === 0) {
      this.outputIndex++;
      return value & 0xFF;
    } else {
      this.outputIndex++;
      return (value >> 8) & 0xFF;
    }
  }
  
  private writeData(value: number): void {
    if (!this.waiting) {
      // Receiving command
      this.command = value;
      this.waiting = true;
      this.inputIndex = 0;
      this.inputByteIndex = 0;
      this.outputIndex = 0;
      this.inputSize = this.getInputSize(this.command);
      this.outputSize = this.getOutputSize(this.command);
      
      if (this.inputSize === 0) {
        this.executeCommand();
      }
    } else {
      // Receiving data bytes - build 16-bit words
      const wordIndex = Math.floor(this.inputByteIndex / 2);
      
      if ((this.inputByteIndex & 1) === 0) {
        // Low byte
        this.inputBuffer[wordIndex] = value;
      } else {
        // High byte
        this.inputBuffer[wordIndex] |= value << 8;
      }
      
      this.inputByteIndex++;
      
      if (this.inputByteIndex >= this.inputSize * 2) {
        this.executeCommand();
      }
    }
  }
  
  private getInputSize(cmd: number): number {
    switch (cmd & 0x1F) {
      case DSP1Command.MULTIPLY: return 3;
      case DSP1Command.INVERSE: return 2;
      case DSP1Command.TRIANGLE: return 1;  // Just angle
      case DSP1Command.RADIUS: return 3;
      case DSP1Command.RANGE: return 4;
      case DSP1Command.DISTANCE: return 3;
      case DSP1Command.ROTATE: return 3;
      case DSP1Command.POLAR: return 3;
      case DSP1Command.PROJECT: return 3;
      case DSP1Command.PARAMETER: return 7;
      case DSP1Command.RASTER: return 1;
      case DSP1Command.TARGET: return 2;
      case DSP1Command.SUBJECTIVE: return 6;
      case DSP1Command.SCALAR: return 3;
      case DSP1Command.GYRATE: return 6;
      case DSP1Command.MEMORY_TEST: return 0;
      default: return 0;
    }
  }
  
  private getOutputSize(cmd: number): number {
    switch (cmd & 0x1F) {
      case DSP1Command.MULTIPLY: return 1;
      case DSP1Command.INVERSE: return 2;
      case DSP1Command.TRIANGLE: return 2;
      case DSP1Command.RADIUS: return 1;
      case DSP1Command.RANGE: return 1;
      case DSP1Command.DISTANCE: return 1;
      case DSP1Command.ROTATE: return 2;
      case DSP1Command.POLAR: return 2;
      case DSP1Command.PROJECT: return 3;
      case DSP1Command.PARAMETER: return 0;
      case DSP1Command.RASTER: return 4;
      case DSP1Command.TARGET: return 2;
      case DSP1Command.SUBJECTIVE: return 3;
      case DSP1Command.SCALAR: return 2;
      case DSP1Command.GYRATE: return 3;
      case DSP1Command.MEMORY_TEST: return 1;
      default: return 0;
    }
  }
  
  // ============================================================================
  // Command Execution
  // ============================================================================
  
  private executeCommand(): void {
    this.busy = true;
    this.outputIndex = 0;
    
    switch (this.command & 0x1F) {
      case DSP1Command.MULTIPLY:
        this.cmdMultiply();
        break;
      case DSP1Command.INVERSE:
        this.cmdInverse();
        break;
      case DSP1Command.TRIANGLE:
        this.cmdTriangle();
        break;
      case DSP1Command.RADIUS:
        this.cmdRadius();
        break;
      case DSP1Command.RANGE:
        this.cmdRange();
        break;
      case DSP1Command.DISTANCE:
        this.cmdDistance();
        break;
      case DSP1Command.ROTATE:
        this.cmdRotate();
        break;
      case DSP1Command.POLAR:
        this.cmdPolar();
        break;
      case DSP1Command.PROJECT:
        this.cmdProject();
        break;
      case DSP1Command.PARAMETER:
        this.cmdParameter();
        break;
      case DSP1Command.RASTER:
        this.cmdRaster();
        break;
      case DSP1Command.TARGET:
        this.cmdTarget();
        break;
      case DSP1Command.SUBJECTIVE:
        this.cmdSubjective();
        break;
      case DSP1Command.SCALAR:
        this.cmdScalar();
        break;
      case DSP1Command.GYRATE:
        this.cmdGyrate();
        break;
      case DSP1Command.MEMORY_TEST:
        this.cmdMemoryTest();
        break;
    }
    
    this.waiting = false;
    this.busy = false;
  }
  
  // ============================================================================
  // Math Helper Functions
  // ============================================================================
  
  private sin(angle: number): number {
    // Angle is 0-511 for full circle
    const index = angle & 0x1FF;
    return this.sinTable[index];
  }
  
  private cos(angle: number): number {
    const index = angle & 0x1FF;
    return this.cosTable[index];
  }
  
  private toFixed(value: number): number {
    // Convert to 16-bit signed fixed point
    return Math.round(value) & 0xFFFF;
  }
  
  private fromSigned16(value: number): number {
    if (value > 0x7FFF) {
      return value - 0x10000;
    }
    return value;
  }
  
  // ============================================================================
  // DSP-1 Commands Implementation
  // ============================================================================
  
  private cmdMultiply(): void {
    // Multiply: K * Sin(A)
    const k = this.fromSigned16(this.inputBuffer[0]);
    const a = this.inputBuffer[1];
    const f = this.inputBuffer[2];
    
    const result = k * this.sin(a >> 7);
    this.outputBuffer[0] = this.toFixed(result);
  }
  
  private cmdInverse(): void {
    // Calculate 1/A, returns quotient and remainder
    const a = this.fromSigned16(this.inputBuffer[0]);
    const shift = this.inputBuffer[1];
    
    if (a === 0) {
      this.outputBuffer[0] = 0x7FFF;
      this.outputBuffer[1] = 0;
    } else {
      const result = (1 << shift) / a;
      this.outputBuffer[0] = this.toFixed(result);
      this.outputBuffer[1] = this.toFixed((1 << shift) % a);
    }
  }
  
  private cmdTriangle(): void {
    // Calculate sin and cos of angle
    // Input is a 16-bit angle (0-65535 maps to 0-360 degrees)
    const angle = this.inputBuffer[0];
    
    // Convert angle: DSP-1 uses angle >> 7 to get index into 512-entry table
    // For angle 0, both sin(0)=0 and cos(0)=1
    const tableIndex = (angle >> 7) & 0x1FF;
    
    // sinTable and cosTable are -1.0 to 1.0, scale to 16-bit signed
    const sinVal = this.sin(tableIndex) * 32767;
    const cosVal = this.cos(tableIndex) * 32767;
    
    this.outputBuffer[0] = this.toFixed(sinVal);
    this.outputBuffer[1] = this.toFixed(cosVal);
  }
  
  private cmdRadius(): void {
    // Calculate sqrt(X² + Y² + Z²)
    const x = this.fromSigned16(this.inputBuffer[0]);
    const y = this.fromSigned16(this.inputBuffer[1]);
    const z = this.fromSigned16(this.inputBuffer[2]);
    
    const radius = Math.sqrt(x * x + y * y + z * z);
    this.outputBuffer[0] = this.toFixed(radius);
  }
  
  private cmdRange(): void {
    // Calculate range between two 2D points
    const x1 = this.fromSigned16(this.inputBuffer[0]);
    const y1 = this.fromSigned16(this.inputBuffer[1]);
    const x2 = this.fromSigned16(this.inputBuffer[2]);
    const y2 = this.fromSigned16(this.inputBuffer[3]);
    
    const dx = x2 - x1;
    const dy = y2 - y1;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    this.outputBuffer[0] = this.toFixed(distance);
  }
  
  private cmdDistance(): void {
    // Calculate distance for 3D point
    const x = this.fromSigned16(this.inputBuffer[0]);
    const y = this.fromSigned16(this.inputBuffer[1]);
    const z = this.fromSigned16(this.inputBuffer[2]);
    
    const distance = Math.sqrt(x * x + y * y + z * z);
    this.outputBuffer[0] = this.toFixed(distance);
  }
  
  private cmdRotate(): void {
    // 2D rotation: angle, X, Y
    const angle = this.inputBuffer[0];
    const x = this.fromSigned16(this.inputBuffer[1]);
    const y = this.fromSigned16(this.inputBuffer[2]);
    
    const tableIndex = (angle >> 7) & 0x1FF;
    const c = this.cos(tableIndex);
    const s = this.sin(tableIndex);
    
    const newX = x * c - y * s;
    const newY = x * s + y * c;
    
    this.outputBuffer[0] = this.toFixed(newX);
    this.outputBuffer[1] = this.toFixed(newY);
  }
  
  private cmdPolar(): void {
    // Convert rectangular to polar coordinates
    const x = this.fromSigned16(this.inputBuffer[0]);
    const y = this.fromSigned16(this.inputBuffer[1]);
    const z = this.fromSigned16(this.inputBuffer[2]);
    
    const radius = Math.sqrt(x * x + y * y + z * z);
    const theta = Math.atan2(y, x) * 512 / (2 * Math.PI);
    
    this.outputBuffer[0] = this.toFixed(radius);
    this.outputBuffer[1] = this.toFixed(theta) & 0x1FF;
  }
  
  private cmdProject(): void {
    // 3D to 2D projection
    const x = this.fromSigned16(this.inputBuffer[0]);
    const y = this.fromSigned16(this.inputBuffer[1]);
    const z = this.fromSigned16(this.inputBuffer[2]);
    
    // Apply view transformation
    const px = this.matrixA * x + this.matrixB * y;
    const py = this.matrixC * y + this.matrixD * z;
    
    // Perspective divide
    const depth = z + this.viewDistance;
    if (depth !== 0) {
      const scale = this.viewDistance / depth;
      this.outputBuffer[0] = this.toFixed(px * scale);
      this.outputBuffer[1] = this.toFixed(py * scale);
      this.outputBuffer[2] = this.toFixed(scale * 256);
    } else {
      this.outputBuffer[0] = 0;
      this.outputBuffer[1] = 0;
      this.outputBuffer[2] = 0;
    }
  }
  
  private cmdParameter(): void {
    // Set projection parameters
    this.azimuth = this.inputBuffer[0];
    this.zenith = this.inputBuffer[1];
    this.tilt = this.inputBuffer[2];
    this.centerX = this.fromSigned16(this.inputBuffer[3]);
    this.centerY = this.fromSigned16(this.inputBuffer[4]);
    this.centerZ = this.fromSigned16(this.inputBuffer[5]);
    this.viewDistance = this.fromSigned16(this.inputBuffer[6]);
    
    // Precalculate rotation matrix
    const ca = this.cos(this.azimuth >> 7);
    const sa = this.sin(this.azimuth >> 7);
    const cz = this.cos(this.zenith >> 7);
    const sz = this.sin(this.zenith >> 7);
    const ct = this.cos(this.tilt >> 7);
    const st = this.sin(this.tilt >> 7);
    
    this.matrixA = ca * ct - sa * sz * st;
    this.matrixB = -sa * cz;
    this.matrixC = sa * ct + ca * sz * st;
    this.matrixD = ca * cz;
  }
  
  private cmdRaster(): void {
    // Calculate raster line coefficients for Mode 7
    const scanline = this.fromSigned16(this.inputBuffer[0]);
    
    // Mode 7 raster calculation
    const ly = scanline + 1;
    const scale = this.viewDistance / ly;
    
    this.outputBuffer[0] = this.toFixed(this.rasterCoeffA * scale);
    this.outputBuffer[1] = this.toFixed(this.rasterCoeffB * scale);
    this.outputBuffer[2] = this.toFixed(this.rasterCoeffC * scale);
    this.outputBuffer[3] = this.toFixed(this.rasterCoeffD * scale);
  }
  
  private cmdTarget(): void {
    // Calculate angle to target
    const x = this.fromSigned16(this.inputBuffer[0]);
    const y = this.fromSigned16(this.inputBuffer[1]);
    
    const angle = Math.atan2(y, x) * 512 / (2 * Math.PI);
    const distance = Math.sqrt(x * x + y * y);
    
    this.outputBuffer[0] = this.toFixed(angle) & 0x1FF;
    this.outputBuffer[1] = this.toFixed(distance);
  }
  
  private cmdSubjective(): void {
    // Subjective coordinate transformation
    const x = this.fromSigned16(this.inputBuffer[0]);
    const y = this.fromSigned16(this.inputBuffer[1]);
    const z = this.fromSigned16(this.inputBuffer[2]);
    const azimuth = this.inputBuffer[3];
    const zenith = this.inputBuffer[4];
    const distance = this.fromSigned16(this.inputBuffer[5]);
    
    // Transform to subjective view
    const ca = this.cos(azimuth >> 7);
    const sa = this.sin(azimuth >> 7);
    const cz = this.cos(zenith >> 7);
    const sz = this.sin(zenith >> 7);
    
    const rx = x * ca - z * sa;
    const rz = x * sa + z * ca;
    const ry = y * cz - rz * sz;
    const rz2 = y * sz + rz * cz;
    
    this.outputBuffer[0] = this.toFixed(rx);
    this.outputBuffer[1] = this.toFixed(ry);
    this.outputBuffer[2] = this.toFixed(rz2 + distance);
  }
  
  private cmdScalar(): void {
    // Multiply with scaling
    const x = this.fromSigned16(this.inputBuffer[0]);
    const y = this.fromSigned16(this.inputBuffer[1]);
    const scale = this.fromSigned16(this.inputBuffer[2]);
    
    this.outputBuffer[0] = this.toFixed(x * scale / 256);
    this.outputBuffer[1] = this.toFixed(y * scale / 256);
  }
  
  private cmdGyrate(): void {
    // 3D rotation around all axes
    const x = this.fromSigned16(this.inputBuffer[0]);
    const y = this.fromSigned16(this.inputBuffer[1]);
    const z = this.fromSigned16(this.inputBuffer[2]);
    const ax = this.inputBuffer[3]; // X rotation
    const ay = this.inputBuffer[4]; // Y rotation
    const az = this.inputBuffer[5]; // Z rotation
    
    // Rotate around X
    let cy = this.cos(ax >> 7);
    let sy = this.sin(ax >> 7);
    let ty = y * cy - z * sy;
    let tz = y * sy + z * cy;
    
    // Rotate around Y
    let cx = this.cos(ay >> 7);
    let sx = this.sin(ay >> 7);
    let tx = x * cx + tz * sx;
    tz = -x * sx + tz * cx;
    
    // Rotate around Z
    let cz = this.cos(az >> 7);
    let sz = this.sin(az >> 7);
    let rx = tx * cz - ty * sz;
    let ry = tx * sz + ty * cz;
    
    this.outputBuffer[0] = this.toFixed(rx);
    this.outputBuffer[1] = this.toFixed(ry);
    this.outputBuffer[2] = this.toFixed(tz);
  }
  
  private cmdMemoryTest(): void {
    // Return test value to verify DSP-1 is working
    this.outputBuffer[0] = 0x0000;
  }
  
  // ============================================================================
  // Execution (no-op for DSP-1, it's purely command-driven)
  // ============================================================================
  
  step(masterCycles: number): void {
    // DSP-1 responds instantly to commands
  }
  
  // ============================================================================
  // State Management
  // ============================================================================
  
  saveState(): ChipState {
    return {
      type: ChipType.DSP1,
      data: new Uint8Array(0),
      registers: {
        centerX: this.centerX,
        centerY: this.centerY,
        centerZ: this.centerZ,
        azimuth: this.azimuth,
        zenith: this.zenith,
        tilt: this.tilt,
        viewDistance: this.viewDistance,
      },
    };
  }
  
  loadState(state: ChipState): void {
    if (state.type !== ChipType.DSP1) return;
    
    this.centerX = state.registers.centerX ?? 0;
    this.centerY = state.registers.centerY ?? 0;
    this.centerZ = state.registers.centerZ ?? 0;
    this.azimuth = state.registers.azimuth ?? 0;
    this.zenith = state.registers.zenith ?? 0;
    this.tilt = state.registers.tilt ?? 0;
    this.viewDistance = state.registers.viewDistance ?? 0;
  }
  
  /**
   * Alias for handles() for test compatibility
   */
  handlesAddress(bank: number, address: number): boolean {
    return this.handles(bank, address);
  }
}

// Register DSP-1 chip
chipRegistry.register(ChipType.DSP1, DSP1Chip);
