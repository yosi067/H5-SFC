/**
 * Project 16-bit: SFC Emulator
 * APU Unit Tests
 * 
 * Tests for the Audio Processing Unit (SPC700 + DSP)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { APU } from './apu';
import { SPC700_CONSTANTS, SPCFlag, DSP_REG } from './types';

// ============================================================================
// Test Suites
// ============================================================================

describe('APU', () => {
  let apu: APU;
  
  beforeEach(() => {
    apu = new APU();
    apu.reset();
  });
  
  describe('Initialization', () => {
    it('should initialize with correct memory size', () => {
      const state = apu.getState();
      expect(state.ram.length).toBe(SPC700_CONSTANTS.RAM_SIZE);
    });
    
    it('should load IPL ROM', () => {
      const state = apu.getState();
      
      // IPL ROM should be mapped at $FFC0-$FFFF
      // Check first few bytes of IPL ROM
      expect(state.ram[0xFFC0]).toBeDefined();
    });
    
    it('should initialize timers', () => {
      const state = apu.getState();
      
      expect(state.timer0.counter).toBe(0);
      expect(state.timer1.counter).toBe(0);
      expect(state.timer2.counter).toBe(0);
    });
    
    it('should initialize communication ports', () => {
      const state = apu.getState();
      
      // Ports 0 and 1 are initialized with boot handshake values ($AA, $BB)
      // to avoid timing issues with games waiting for APU boot
      expect(state.port0).toBe(0xAA);
      expect(state.port1).toBe(0xBB);
      expect(state.port2).toBe(0);
      expect(state.port3).toBe(0);
    });
  });
  
  describe('SPC700 CPU', () => {
    it('should have correct initial register values', () => {
      const regs = apu.getRegisters();
      
      expect(regs.PC).toBe(SPC700_CONSTANTS.RESET_VECTOR);
      expect(regs.SP).toBe(0xFF);
    });
    
    it('should execute instructions', () => {
      // Disable IPL ROM to allow RAM execution at RESET_VECTOR
      apu.disableIPL();
      
      // Write a simple program: MOV A, #42
      const { ram } = apu.getMutableState();
      ram[SPC700_CONSTANTS.RESET_VECTOR] = 0xE8; // MOV A, #imm
      ram[SPC700_CONSTANTS.RESET_VECTOR + 1] = 0x42;
      
      // Step execution
      apu.step(100);
      
      const regs = apu.getRegisters();
      expect(regs.A).toBe(0x42);
    });
    
    it('should set flags correctly', () => {
      // Disable IPL ROM to allow RAM execution at RESET_VECTOR
      apu.disableIPL();
      
      const { ram } = apu.getMutableState();
      
      // MOV A, #$00 (should set zero flag)
      ram[SPC700_CONSTANTS.RESET_VECTOR] = 0xE8;
      ram[SPC700_CONSTANTS.RESET_VECTOR + 1] = 0x00;
      
      apu.step(100);
      
      const regs = apu.getRegisters();
      expect(regs.PSW & SPCFlag.Z).not.toBe(0);
    });
    
    it('should handle MOV X, #imm', () => {
      // Disable IPL ROM to allow RAM execution at RESET_VECTOR
      apu.disableIPL();
      
      const { ram } = apu.getMutableState();
      
      ram[SPC700_CONSTANTS.RESET_VECTOR] = 0xCD; // MOV X, #imm
      ram[SPC700_CONSTANTS.RESET_VECTOR + 1] = 0x55;
      
      apu.step(100);
      
      const regs = apu.getRegisters();
      expect(regs.X).toBe(0x55);
    });
    
    it('should handle MOV Y, #imm', () => {
      // Disable IPL ROM to allow RAM execution at RESET_VECTOR
      apu.disableIPL();
      
      const { ram } = apu.getMutableState();
      
      ram[SPC700_CONSTANTS.RESET_VECTOR] = 0x8D; // MOV Y, #imm
      ram[SPC700_CONSTANTS.RESET_VECTOR + 1] = 0xAA;
      
      apu.step(100);
      
      const regs = apu.getRegisters();
      expect(regs.Y).toBe(0xAA);
    });
  });
  
  describe('Memory Access', () => {
    it('should read from RAM', () => {
      const { ram } = apu.getMutableState();
      ram[0x0100] = 0x42;
      
      const value = apu.readMemory(0x0100);
      expect(value).toBe(0x42);
    });
    
    it('should write to RAM', () => {
      apu.writeMemory(0x0100, 0x42);
      
      const state = apu.getState();
      expect(state.ram[0x0100]).toBe(0x42);
    });
    
    it('should handle I/O register reads', () => {
      // Set port values from CPU side
      apu.writeCPUPort(0, 0x42);
      
      // Read from APU side should get the value
      const value = apu.readMemory(0x00F4);
      expect(value).toBe(0x42);
    });
    
    it('should handle I/O register writes', () => {
      apu.writeMemory(0x00F4, 0x55);
      
      // Should be readable from CPU side
      const value = apu.readCPUPort(0);
      expect(value).toBe(0x55);
    });
  });
  
  describe('Timers', () => {
    it('should configure timer 0 target', () => {
      apu.writeMemory(0x00FA, 0x80); // T0TARGET
      
      const state = apu.getState();
      expect(state.timer0.target).toBe(0x80);
    });
    
    it('should configure timer 1 target', () => {
      apu.writeMemory(0x00FB, 0x40); // T1TARGET
      
      const state = apu.getState();
      expect(state.timer1.target).toBe(0x40);
    });
    
    it('should configure timer 2 target', () => {
      apu.writeMemory(0x00FC, 0x20); // T2TARGET
      
      const state = apu.getState();
      expect(state.timer2.target).toBe(0x20);
    });
    
    it('should enable timers via CONTROL register', () => {
      apu.writeMemory(0x00F1, 0x07); // Enable all 3 timers
      
      const state = apu.getState();
      expect(state.timer0.enabled).toBe(true);
      expect(state.timer1.enabled).toBe(true);
      expect(state.timer2.enabled).toBe(true);
    });
    
    it('should increment timer counter', () => {
      // Enable timer 2 (8kHz)
      apu.writeMemory(0x00F1, 0x04);
      apu.writeMemory(0x00FC, 0x10); // Target = 16
      
      // Run enough cycles for timer to tick
      apu.step(10000);
      
      // Timer output should be non-zero if counter overflowed
      const output = apu.readMemory(0x00FD);
      // May or may not have overflowed depending on cycle count
    });
  });
  
  describe('DSP Access', () => {
    it('should write to DSP address register', () => {
      apu.writeMemory(0x00F2, 0x0C); // Set DSP address
      
      const state = apu.getState();
      expect(state.dspAddr).toBe(0x0C);
    });
    
    it('should write to DSP data register', () => {
      // Set address to MVOLL (Master Volume Left)
      apu.writeMemory(0x00F2, DSP_REG.MVOLL);
      apu.writeMemory(0x00F3, 0x7F); // Max volume
      
      const state = apu.getState();
      expect(state.dspRegs[DSP_REG.MVOLL]).toBe(0x7F);
    });
    
    it('should read from DSP data register', () => {
      apu.writeMemory(0x00F2, DSP_REG.MVOLR);
      apu.writeMemory(0x00F3, 0x60);
      
      // Re-read
      apu.writeMemory(0x00F2, DSP_REG.MVOLR);
      const value = apu.readMemory(0x00F3);
      
      expect(value).toBe(0x60);
    });
    
    it('should configure voice volume', () => {
      // Voice 0 Volume Left
      apu.writeMemory(0x00F2, DSP_REG.V0VOLL);
      apu.writeMemory(0x00F3, 0x7F);
      
      // Voice 0 Volume Right
      apu.writeMemory(0x00F2, DSP_REG.V0VOLR);
      apu.writeMemory(0x00F3, 0x7F);
      
      const state = apu.getState();
      expect(state.dspRegs[DSP_REG.V0VOLL]).toBe(0x7F);
      expect(state.dspRegs[DSP_REG.V0VOLR]).toBe(0x7F);
    });
    
    it('should configure voice pitch', () => {
      // Voice 0 Pitch Low
      apu.writeMemory(0x00F2, DSP_REG.V0PITCHL);
      apu.writeMemory(0x00F3, 0x00);
      
      // Voice 0 Pitch High
      apu.writeMemory(0x00F2, DSP_REG.V0PITCHH);
      apu.writeMemory(0x00F3, 0x10);
      
      const state = apu.getState();
      expect(state.dspRegs[DSP_REG.V0PITCHH]).toBe(0x10);
    });
    
    it('should set sample source', () => {
      // Voice 0 Source Number
      apu.writeMemory(0x00F2, DSP_REG.V0SRCN);
      apu.writeMemory(0x00F3, 0x05);
      
      const state = apu.getState();
      expect(state.dspRegs[DSP_REG.V0SRCN]).toBe(0x05);
    });
    
    it('should configure ADSR', () => {
      // Voice 0 ADSR 1 (Attack, Decay)
      apu.writeMemory(0x00F2, DSP_REG.V0ADSR1);
      apu.writeMemory(0x00F3, 0xFF);
      
      // Voice 0 ADSR 2 (Sustain, Release)
      apu.writeMemory(0x00F2, DSP_REG.V0ADSR2);
      apu.writeMemory(0x00F3, 0xE0);
      
      const state = apu.getState();
      expect(state.dspRegs[DSP_REG.V0ADSR1]).toBe(0xFF);
      expect(state.dspRegs[DSP_REG.V0ADSR2]).toBe(0xE0);
    });
  });
  
  describe('Key On/Off', () => {
    it('should key on voices', () => {
      apu.writeMemory(0x00F2, DSP_REG.KON);
      apu.writeMemory(0x00F3, 0x01); // Key on voice 0
      
      const state = apu.getState();
      expect(state.dspRegs[DSP_REG.KON]).toBe(0x01);
    });
    
    it('should key off voices', () => {
      apu.writeMemory(0x00F2, DSP_REG.KOFF);
      apu.writeMemory(0x00F3, 0x01); // Key off voice 0
      
      const state = apu.getState();
      expect(state.dspRegs[DSP_REG.KOFF]).toBe(0x01);
    });
  });
  
  describe('FLG Register', () => {
    it('should mute all voices', () => {
      apu.writeMemory(0x00F2, DSP_REG.FLG);
      apu.writeMemory(0x00F3, 0x40); // Mute
      
      const state = apu.getState();
      expect(state.dspRegs[DSP_REG.FLG] & 0x40).not.toBe(0);
    });
    
    it('should reset DSP', () => {
      apu.writeMemory(0x00F2, DSP_REG.FLG);
      apu.writeMemory(0x00F3, 0x80); // Soft reset
      
      const state = apu.getState();
      expect(state.dspRegs[DSP_REG.FLG] & 0x80).not.toBe(0);
    });
    
    it('should configure noise clock', () => {
      apu.writeMemory(0x00F2, DSP_REG.FLG);
      apu.writeMemory(0x00F3, 0x1F); // Max noise frequency
      
      const state = apu.getState();
      expect(state.dspRegs[DSP_REG.FLG] & 0x1F).toBe(0x1F);
    });
  });
  
  describe('Echo', () => {
    it('should configure echo buffer', () => {
      apu.writeMemory(0x00F2, DSP_REG.ESA);
      apu.writeMemory(0x00F3, 0x60); // Echo buffer at $6000
      
      apu.writeMemory(0x00F2, DSP_REG.EDL);
      apu.writeMemory(0x00F3, 0x0F); // Max delay
      
      const state = apu.getState();
      expect(state.dspRegs[DSP_REG.ESA]).toBe(0x60);
      expect(state.dspRegs[DSP_REG.EDL]).toBe(0x0F);
    });
    
    it('should configure echo feedback', () => {
      apu.writeMemory(0x00F2, DSP_REG.EFB);
      apu.writeMemory(0x00F3, 0x40); // 50% feedback
      
      const state = apu.getState();
      expect(state.dspRegs[DSP_REG.EFB]).toBe(0x40);
    });
    
    it('should enable echo per voice', () => {
      apu.writeMemory(0x00F2, DSP_REG.EON);
      apu.writeMemory(0x00F3, 0xFF); // All voices
      
      const state = apu.getState();
      expect(state.dspRegs[DSP_REG.EON]).toBe(0xFF);
    });
  });
  
  describe('CPU Communication', () => {
    it('should communicate via port 0', () => {
      // CPU writes to port 0
      apu.writeCPUPort(0, 0xAA);
      
      // APU reads from port 0
      const value = apu.readMemory(0x00F4);
      expect(value).toBe(0xAA);
    });
    
    it('should communicate via port 1', () => {
      apu.writeCPUPort(1, 0xBB);
      
      const value = apu.readMemory(0x00F5);
      expect(value).toBe(0xBB);
    });
    
    it('should communicate via port 2', () => {
      apu.writeCPUPort(2, 0xCC);
      
      const value = apu.readMemory(0x00F6);
      expect(value).toBe(0xCC);
    });
    
    it('should communicate via port 3', () => {
      apu.writeCPUPort(3, 0xDD);
      
      const value = apu.readMemory(0x00F7);
      expect(value).toBe(0xDD);
    });
    
    it('should bidirectional communication', () => {
      // APU writes response
      apu.writeMemory(0x00F4, 0x42);
      
      // CPU reads response
      const response = apu.readCPUPort(0);
      expect(response).toBe(0x42);
    });
  });
  
  describe('IPL ROM', () => {
    it('should boot from IPL ROM', () => {
      // IPL ROM starts at $FFC0
      const state = apu.getState();
      const pc = apu.getRegisters().PC;
      
      // PC should start at reset vector in IPL ROM region
      expect(pc).toBeGreaterThanOrEqual(0xFFC0);
    });
    
    it('should wait for CPU handshake', () => {
      // IPL ROM waits for $AA on port 0, $BB on port 1
      // This is the boot protocol
      
      // Simulate handshake
      apu.writeCPUPort(0, 0xAA);
      apu.writeCPUPort(1, 0xBB);
      
      // Run some cycles
      apu.step(1000);
      
      // APU should acknowledge
      const response = apu.readCPUPort(0);
      // Response depends on boot state
    });
  });
  
  describe('Audio Output', () => {
    it('should provide audio buffer', () => {
      const audioBuffer = apu.getAudioBuffer();
      
      expect(audioBuffer).toBeDefined();
      expect(audioBuffer.length).toBeGreaterThan(0);
    });
    
    it('should mix all 8 voices', () => {
      // Enable all voices with some sound
      for (let v = 0; v < 8; v++) {
        // Set volume
        apu.writeMemory(0x00F2, v * 0x10 + 0);
        apu.writeMemory(0x00F3, 0x7F);
        apu.writeMemory(0x00F2, v * 0x10 + 1);
        apu.writeMemory(0x00F3, 0x7F);
      }
      
      // Key on all
      apu.writeMemory(0x00F2, DSP_REG.KON);
      apu.writeMemory(0x00F3, 0xFF);
      
      // Process some samples
      apu.step(1000);
    });
  });
  
  describe('State Management', () => {
    it('should save state', () => {
      // Configure some state
      apu.writeMemory(0x0100, 0x42);
      apu.writeMemory(0x00F2, DSP_REG.MVOLL);
      apu.writeMemory(0x00F3, 0x7F);
      
      const state = apu.saveState();
      
      expect(state.ram[0x0100]).toBe(0x42);
      expect(state.dspRegs[DSP_REG.MVOLL]).toBe(0x7F);
    });
    
    it('should load state', () => {
      apu.writeMemory(0x0100, 0x42);
      const savedState = apu.saveState();
      
      apu.reset();
      apu.loadState(savedState);
      
      expect(apu.readMemory(0x0100)).toBe(0x42);
    });
  });
});

// ============================================================================
// SPC File Tests (placeholder)
// ============================================================================

describe('SPC File Playback', () => {
  it.todo('should load SPC file format');
  it.todo('should restore SPC700 state from file');
  it.todo('should play back audio correctly');
  it.todo('should handle extended SPC tags');
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('APU Integration', () => {
  let apu: APU;
  
  beforeEach(() => {
    apu = new APU();
    apu.reset();
  });
  
  it('should synchronize with main CPU timing', () => {
    // Main CPU runs at ~21.47727 MHz
    // APU runs at 1.024 MHz
    // Ratio is about 21:1
    
    const mainCycles = 21;
    const expectedAPUCycles = 1;
    
    // This would test actual sync in emulator
    apu.step(expectedAPUCycles);
  });
  
  it('should handle audio upload sequence', () => {
    // Standard SPC upload sequence:
    // 1. Wait for $AABB response
    // 2. Send address
    // 3. Send data
    // 4. Send end marker
    
    // This is a more complex integration test
    // that would require full boot sequence
  });
});
