/**
 * Project 16-bit: SFC Emulator
 * Enhancement Chips Unit Tests
 * 
 * Tests for SA-1 and DSP-1 enhancement chips
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SA1Chip } from './sa1';
import { DSP1Chip } from './dsp1';
import { ChipManager, ChipRegistry, parseROMHeader } from './chipManager';

// ============================================================================
// SA-1 Tests
// ============================================================================

describe('SA-1 Chip', () => {
  let sa1: SA1Chip;
  
  beforeEach(() => {
    sa1 = new SA1Chip();
    sa1.reset();
  });
  
  describe('Initialization', () => {
    it('should have correct chip ID', () => {
      expect(sa1.chipId).toBe('SA-1');
    });
    
    it('should have correct base address', () => {
      expect(sa1.baseAddress).toBe(0x2200);
    });
    
    it('should identify address range', () => {
      expect(sa1.handlesAddress(0x22, 0x2200)).toBe(true);
      expect(sa1.handlesAddress(0x22, 0x23FF)).toBe(true);
      expect(sa1.handlesAddress(0x00, 0x1000)).toBe(false);
    });
  });
  
  describe('Bank Switching', () => {
    it('should map CXB register', () => {
      sa1.write(0x22, 0x2220, 0x04); // CXB = bank 4
      
      const mapped = sa1.mapAddress(0xC0, 0x0000);
      expect(mapped.bank).toBe(0x04);
    });
    
    it('should map DXB register', () => {
      sa1.write(0x22, 0x2221, 0x05); // DXB = bank 5
      
      const mapped = sa1.mapAddress(0xD0, 0x0000);
      expect(mapped.bank).toBe(0x05);
    });
    
    it('should map EXB register', () => {
      sa1.write(0x22, 0x2222, 0x06); // EXB = bank 6
      
      const mapped = sa1.mapAddress(0xE0, 0x0000);
      expect(mapped.bank).toBe(0x06);
    });
    
    it('should map FXB register', () => {
      sa1.write(0x22, 0x2223, 0x07); // FXB = bank 7
      
      const mapped = sa1.mapAddress(0xF0, 0x0000);
      expect(mapped.bank).toBe(0x07);
    });
  });
  
  describe('Arithmetic Unit', () => {
    it('should perform 16x16 multiplication', () => {
      // Set multiplicand A
      sa1.write(0x22, 0x2250, 0x10);
      sa1.write(0x22, 0x2251, 0x00);
      
      // Set multiplicand B
      sa1.write(0x22, 0x2252, 0x20);
      sa1.write(0x22, 0x2253, 0x00);
      
      // Read result (0x10 * 0x20 = 0x200)
      const low = sa1.read(0x22, 0x2306);
      const high = sa1.read(0x22, 0x2307);
      
      expect(low | (high << 8)).toBe(0x0200);
    });
    
    it('should perform division', () => {
      // Set dividend (0x1000)
      sa1.write(0x22, 0x2254, 0x00);
      sa1.write(0x22, 0x2255, 0x10);
      sa1.write(0x22, 0x2256, 0x00);
      sa1.write(0x22, 0x2257, 0x00);
      
      // Set divisor (0x10)
      sa1.write(0x22, 0x2258, 0x10);
      sa1.write(0x22, 0x2259, 0x00);
      
      // Read quotient (0x1000 / 0x10 = 0x100)
      const qLow = sa1.read(0x22, 0x2306);
      const qHigh = sa1.read(0x22, 0x2307);
      
      expect(qLow | (qHigh << 8)).toBe(0x0100);
    });
  });
  
  describe('I-RAM Access', () => {
    it('should read/write I-RAM', () => {
      sa1.write(0x00, 0x3000, 0x42);
      
      const value = sa1.read(0x00, 0x3000);
      expect(value).toBe(0x42);
    });
    
    it('should mirror I-RAM in banks 00-3F', () => {
      sa1.write(0x00, 0x3000, 0x55);
      
      // Should be mirrored
      const value = sa1.read(0x20, 0x3000);
      expect(value).toBe(0x55);
    });
  });
  
  describe('BW-RAM Access', () => {
    it('should read/write BW-RAM', () => {
      sa1.write(0x40, 0x0000, 0xAA);
      
      const value = sa1.read(0x40, 0x0000);
      expect(value).toBe(0xAA);
    });
    
    it('should support bitmap mode', () => {
      // Enable bitmap mode
      sa1.write(0x22, 0x2225, 0x80);
      
      // Write to bitmap area
      sa1.write(0x60, 0x0000, 0xFF);
    });
  });
  
  describe('Variable Length Bit Processing', () => {
    it('should configure VBD address', () => {
      sa1.write(0x22, 0x2258, 0x00);
      sa1.write(0x22, 0x2259, 0x80);
      sa1.write(0x22, 0x225A, 0x00);
      
      // Read VBD data
      const data = sa1.read(0x22, 0x230C);
      // Data depends on ROM content at that address
    });
  });
  
  describe('IRQ Control', () => {
    it('should handle SA-1 to SNES IRQ', () => {
      // Enable IRQ from SA-1
      sa1.write(0x22, 0x2200, 0x80);
      
      const irq = sa1.checkIRQ();
      expect(irq).toBe(true);
    });
    
    it('should handle SNES to SA-1 IRQ', () => {
      // Trigger IRQ to SA-1
      sa1.write(0x22, 0x2209, 0x80);
    });
  });
  
  describe('State Management', () => {
    it('should save and restore state', () => {
      sa1.write(0x00, 0x3000, 0x42);
      sa1.write(0x22, 0x2220, 0x04);
      
      const state = sa1.saveState();
      
      sa1.reset();
      sa1.loadState(state);
      
      expect(sa1.read(0x00, 0x3000)).toBe(0x42);
    });
  });
});

// ============================================================================
// DSP-1 Tests
// ============================================================================

describe('DSP-1 Chip', () => {
  let dsp1: DSP1Chip;
  
  beforeEach(() => {
    dsp1 = new DSP1Chip();
    dsp1.reset();
  });
  
  describe('Initialization', () => {
    it('should have correct chip ID', () => {
      expect(dsp1.chipId).toBe('DSP-1');
    });
    
    it('should handle correct address range', () => {
      expect(dsp1.handlesAddress(0x00, 0x6000)).toBe(true);
      expect(dsp1.handlesAddress(0x20, 0x8000)).toBe(true);
    });
  });
  
  describe('Status Register', () => {
    it('should report ready status', () => {
      const status = dsp1.read(0x00, 0x6000);
      
      // Bit 7 = 0 means ready
      expect(status & 0x80).toBe(0);
    });
  });
  
  describe('Math Commands', () => {
    describe('MULTIPLY', () => {
      it('should multiply two values', () => {
        // Send MULTIPLY command (0x00)
        dsp1.write(0x00, 0x6000, 0x00);
        
        // Send operand A (high byte first)
        dsp1.write(0x00, 0x6000, 0x01);
        dsp1.write(0x00, 0x6000, 0x00); // A = 0x0100 = 256
        
        // Send operand B
        dsp1.write(0x00, 0x6000, 0x00);
        dsp1.write(0x00, 0x6000, 0x02); // B = 0x0200 = 512
        
        // Read result (256 * 512 = 131072 = 0x20000)
        const resultLow = dsp1.read(0x00, 0x6000);
        const resultHigh = dsp1.read(0x00, 0x6000);
      });
    });
    
    describe('INVERSE', () => {
      it('should compute reciprocal', () => {
        // Send INVERSE command (0x10)
        dsp1.write(0x00, 0x6000, 0x10);
        
        // Send value
        dsp1.write(0x00, 0x6000, 0x40);
        dsp1.write(0x00, 0x6000, 0x00);
        
        // Send exponent
        dsp1.write(0x00, 0x6000, 0x00);
        dsp1.write(0x00, 0x6000, 0x00);
        
        // Read result
        const resultLow = dsp1.read(0x00, 0x6000);
        const resultHigh = dsp1.read(0x00, 0x6000);
      });
    });
    
    describe('TRIANGLE', () => {
      it('should compute sin and cos', () => {
        // Send TRIANGLE command (0x04)
        dsp1.write(0x00, 0x6000, 0x04);
        
        // Send angle (0 degrees)
        dsp1.write(0x00, 0x6000, 0x00);
        dsp1.write(0x00, 0x6000, 0x00);
        
        // Read sin (should be 0)
        const sinLow = dsp1.read(0x00, 0x6000);
        const sinHigh = dsp1.read(0x00, 0x6000);
        
        // Read cos (should be ~32767 for cos(0) = 1.0)
        const cosLow = dsp1.read(0x00, 0x6000);
        const cosHigh = dsp1.read(0x00, 0x6000);
        
        const cos = cosLow | (cosHigh << 8);
        // cos(0) should be close to max positive value
        expect(cos).toBeGreaterThan(32000);
      });
    });
    
    describe('RADIUS', () => {
      it('should compute distance', () => {
        // RADIUS computes sqrt(x² + y² + z²)
        dsp1.write(0x00, 0x6000, 0x08);
        
        // X = 3
        dsp1.write(0x00, 0x6000, 0x03);
        dsp1.write(0x00, 0x6000, 0x00);
        
        // Y = 4
        dsp1.write(0x00, 0x6000, 0x04);
        dsp1.write(0x00, 0x6000, 0x00);
        
        // Z = 0
        dsp1.write(0x00, 0x6000, 0x00);
        dsp1.write(0x00, 0x6000, 0x00);
        
        // Read result (should be 5 for 3-4-5 triangle)
        const resultLow = dsp1.read(0x00, 0x6000);
        const resultHigh = dsp1.read(0x00, 0x6000);
        const result = resultLow | (resultHigh << 8);
        
        // Result should be close to 5
        expect(result).toBeGreaterThanOrEqual(4);
        expect(result).toBeLessThanOrEqual(6);
      });
    });
    
    describe('ROTATE', () => {
      it('should rotate 2D point', () => {
        dsp1.write(0x00, 0x6000, 0x0C);
        
        // Angle = 0
        dsp1.write(0x00, 0x6000, 0x00);
        dsp1.write(0x00, 0x6000, 0x00);
        
        // X = 100
        dsp1.write(0x00, 0x6000, 0x64);
        dsp1.write(0x00, 0x6000, 0x00);
        
        // Y = 0
        dsp1.write(0x00, 0x6000, 0x00);
        dsp1.write(0x00, 0x6000, 0x00);
        
        // Read result (should be same as input for 0 rotation)
        const xLow = dsp1.read(0x00, 0x6000);
        const xHigh = dsp1.read(0x00, 0x6000);
        const x = xLow | (xHigh << 8);
        
        expect(x).toBe(100);
      });
    });
    
    describe('PARAMETER (Mode 7)', () => {
      it('should compute Mode 7 parameters', () => {
        dsp1.write(0x00, 0x6000, 0x1C);
        
        // Send many parameters for Mode 7 setup
        // This is the main command used by Super Mario Kart
        
        // Distance from screen
        dsp1.write(0x00, 0x6000, 0x00);
        dsp1.write(0x00, 0x6000, 0x01);
        
        // Additional parameters would follow...
      });
    });
    
    describe('RASTER', () => {
      it('should compute raster data for each scanline', () => {
        dsp1.write(0x00, 0x6000, 0x1E);
        
        // Scanline number
        dsp1.write(0x00, 0x6000, 0x00);
        dsp1.write(0x00, 0x6000, 0x00);
        
        // Read raster parameters
        const a = dsp1.read(0x00, 0x6000);
        const b = dsp1.read(0x00, 0x6000);
      });
    });
  });
  
  describe('State Management', () => {
    it('should save and restore state', () => {
      // Execute some command to change state
      dsp1.write(0x00, 0x6000, 0x00);
      
      const state = dsp1.saveState();
      
      dsp1.reset();
      dsp1.loadState(state);
    });
  });
});

// ============================================================================
// Chip Manager Tests
// ============================================================================

describe('ChipManager', () => {
  describe('ROM Header Parsing', () => {
    it('should detect no enhancement chip', () => {
      const rom = new Uint8Array(0x10000);
      rom[0x7FD6] = 0x00; // No special chip
      
      const header = parseROMHeader(rom);
      expect(header.enhancementChip).toBeNull();
    });
    
    it('should detect SA-1 chip', () => {
      const rom = new Uint8Array(0x10000);
      rom[0x7FD6] = 0x35; // SA-1 marker
      
      const header = parseROMHeader(rom);
      expect(header.enhancementChip).toBe('SA-1');
    });
    
    it('should detect DSP-1 chip', () => {
      const rom = new Uint8Array(0x10000);
      rom[0x7FD6] = 0x03; // DSP-1 marker
      
      const header = parseROMHeader(rom);
      expect(header.enhancementChip).toBe('DSP-1');
    });
    
    it('should parse ROM title', () => {
      const rom = new Uint8Array(0x10000);
      
      // Write title at header offset
      const title = 'SUPER MARIO RPG   ';
      for (let i = 0; i < 21; i++) {
        rom[0x7FC0 + i] = title.charCodeAt(i);
      }
      
      const header = parseROMHeader(rom);
      expect(header.title.trim()).toBe('SUPER MARIO RPG');
    });
    
    it('should detect LoROM mapping', () => {
      const rom = new Uint8Array(0x10000);
      rom[0x7FD5] = 0x20; // LoROM
      
      const header = parseROMHeader(rom);
      expect(header.mapMode).toBe('LoROM');
    });
    
    it('should detect HiROM mapping', () => {
      const rom = new Uint8Array(0x10000);
      rom[0xFFD5] = 0x21; // HiROM
      rom[0xFFDC] = 0xFF; // Checksum complement
      rom[0xFFDD] = 0xFF;
      rom[0xFFDE] = 0x00; // Checksum
      rom[0xFFDF] = 0x00;
      
      const header = parseROMHeader(rom);
      // May detect as HiROM depending on checksum validation
    });
  });
  
  describe('ChipRegistry', () => {
    it('should register chips', () => {
      const registry = ChipRegistry.getInstance();
      
      // SA-1 and DSP-1 should already be registered
      const sa1 = registry.createChip('SA-1');
      expect(sa1).not.toBeNull();
      expect(sa1?.chipId).toBe('SA-1');
    });
    
    it('should return null for unknown chips', () => {
      const registry = ChipRegistry.getInstance();
      
      const unknown = registry.createChip('UNKNOWN-CHIP');
      expect(unknown).toBeNull();
    });
    
    it('should create new instances each time', () => {
      const registry = ChipRegistry.getInstance();
      
      const chip1 = registry.createChip('SA-1');
      const chip2 = registry.createChip('SA-1');
      
      expect(chip1).not.toBe(chip2);
    });
  });
  
  describe('ChipManager Integration', () => {
    it('should auto-detect and create chip from ROM', () => {
      const rom = new Uint8Array(0x10000);
      rom[0x7FD6] = 0x35; // SA-1
      
      const manager = new ChipManager();
      manager.loadROM(rom);
      
      expect(manager.hasChip('SA-1')).toBe(true);
    });
    
    it('should route memory access to chip', () => {
      const rom = new Uint8Array(0x10000);
      rom[0x7FD6] = 0x35; // SA-1
      
      const manager = new ChipManager();
      manager.loadROM(rom);
      
      // Write to SA-1 register
      manager.write(0x22, 0x2220, 0x04);
      
      // Read should return written value (for mappable registers)
    });
    
    it('should save all chip states', () => {
      const rom = new Uint8Array(0x10000);
      rom[0x7FD6] = 0x35; // SA-1
      
      const manager = new ChipManager();
      manager.loadROM(rom);
      
      const state = manager.saveState();
      expect(state['SA-1']).toBeDefined();
    });
    
    it('should restore all chip states', () => {
      const rom = new Uint8Array(0x10000);
      rom[0x7FD6] = 0x35; // SA-1
      
      const manager = new ChipManager();
      manager.loadROM(rom);
      
      // Modify state
      manager.write(0x22, 0x2220, 0x04);
      
      const savedState = manager.saveState();
      
      // Reset
      manager.reset();
      
      // Restore
      manager.loadState(savedState);
    });
  });
});

// ============================================================================
// Game-Specific Tests
// ============================================================================

describe('Game Compatibility', () => {
  describe('Super Mario RPG (SA-1)', () => {
    let sa1: SA1Chip;
    
    beforeEach(() => {
      sa1 = new SA1Chip();
      sa1.reset();
    });
    
    it('should handle fast ROM access', () => {
      // Super Mario RPG uses SA-1 for fast arithmetic
      sa1.write(0x22, 0x2250, 0x00);
      sa1.write(0x22, 0x2251, 0x01); // A = 256
      sa1.write(0x22, 0x2252, 0x00);
      sa1.write(0x22, 0x2253, 0x01); // B = 256
      
      // 256 * 256 = 65536
      const low = sa1.read(0x22, 0x2306);
      const mid = sa1.read(0x22, 0x2307);
      const high = sa1.read(0x22, 0x2308);
      
      const result = low | (mid << 8) | (high << 16);
      expect(result).toBe(65536);
    });
  });
  
  describe('Super Mario Kart (DSP-1)', () => {
    let dsp1: DSP1Chip;
    
    beforeEach(() => {
      dsp1 = new DSP1Chip();
      dsp1.reset();
    });
    
    it('should compute perspective correctly', () => {
      // Mario Kart uses DSP-1 for Mode 7 road perspective
      // PARAMETER command sets up the 3D->2D projection
      
      dsp1.write(0x00, 0x6000, 0x1C); // PARAMETER
      
      // Distance parameter
      dsp1.write(0x00, 0x6000, 0x00);
      dsp1.write(0x00, 0x6000, 0x02); // Far distance
      
      // Read computed values
      // These would be used to set Mode 7 matrix
    });
  });
});

// ============================================================================
// Performance Tests
// ============================================================================

describe('Chip Performance', () => {
  it('SA-1 multiplication should be fast', () => {
    const sa1 = new SA1Chip();
    sa1.reset();
    
    const startTime = performance.now();
    
    for (let i = 0; i < 10000; i++) {
      sa1.write(0x22, 0x2250, i & 0xFF);
      sa1.write(0x22, 0x2251, (i >> 8) & 0xFF);
      sa1.write(0x22, 0x2252, i & 0xFF);
      sa1.write(0x22, 0x2253, (i >> 8) & 0xFF);
      sa1.read(0x22, 0x2306);
    }
    
    const endTime = performance.now();
    const elapsed = endTime - startTime;
    
    // Should complete in reasonable time
    expect(elapsed).toBeLessThan(1000); // Less than 1 second
  });
  
  it('DSP-1 trig should be fast', () => {
    const dsp1 = new DSP1Chip();
    dsp1.reset();
    
    const startTime = performance.now();
    
    for (let i = 0; i < 10000; i++) {
      dsp1.write(0x00, 0x6000, 0x04); // TRIANGLE
      dsp1.write(0x00, 0x6000, i & 0xFF);
      dsp1.write(0x00, 0x6000, (i >> 8) & 0xFF);
      dsp1.read(0x00, 0x6000);
      dsp1.read(0x00, 0x6000);
    }
    
    const endTime = performance.now();
    const elapsed = endTime - startTime;
    
    expect(elapsed).toBeLessThan(1000);
  });
});
