/**
 * Project 16-bit: SFC Emulator
 * CPU 65C816 Unit Tests
 * 
 * Tests for the 65C816 CPU instruction set
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CPU65C816 } from './cpu65c816';
import { StatusFlag, CPURegisters } from './types';
import { MemoryBus } from '../memory/memoryBus';

// ============================================================================
// Mock Memory Bus
// ============================================================================

class MockMemoryBus implements MemoryBus {
  private memory: Uint8Array = new Uint8Array(0x1000000); // 16MB address space
  
  read(bank: number, address: number): number {
    const fullAddress = (bank << 16) | address;
    return this.memory[fullAddress] ?? 0;
  }
  
  write(bank: number, address: number, value: number): void {
    const fullAddress = (bank << 16) | address;
    this.memory[fullAddress] = value;
  }
  
  getAccessSpeed(bank: number, address: number): number {
    return 6; // Fast ROM timing
  }
  
  // Helper to load program at specific address
  loadProgram(bank: number, address: number, program: number[]): void {
    program.forEach((byte, i) => {
      this.write(bank, address + i, byte);
    });
  }
  
  // Helper to set reset vector
  setResetVector(address: number): void {
    this.write(0x00, 0xFFFC, address & 0xFF);
    this.write(0x00, 0xFFFD, (address >> 8) & 0xFF);
  }
}

// ============================================================================
// Test Suites
// ============================================================================

describe('CPU65C816', () => {
  let cpu: CPU65C816;
  let memory: MockMemoryBus;
  
  beforeEach(() => {
    memory = new MockMemoryBus();
    cpu = new CPU65C816(memory);
  });
  
  describe('Initialization', () => {
    it('should start in emulation mode', () => {
      cpu.reset();
      const regs = cpu.getRegisters();
      expect(regs.E).toBe(true);
    });
    
    it('should have correct initial register values', () => {
      cpu.reset();
      const regs = cpu.getRegisters();
      
      expect(regs.SP).toBe(0x01FF);
      expect(regs.D).toBe(0x0000);
      expect(regs.DB).toBe(0x00);
      expect(regs.PB).toBe(0x00);
    });
    
    it('should set PC from reset vector', () => {
      memory.setResetVector(0x8000);
      cpu.reset();
      const regs = cpu.getRegisters();
      
      expect(regs.PC).toBe(0x8000);
    });
    
    it('should have M and X flags set in emulation mode', () => {
      cpu.reset();
      const regs = cpu.getRegisters();
      
      expect(regs.P & StatusFlag.M).not.toBe(0);
      expect(regs.P & StatusFlag.X).not.toBe(0);
    });
  });
  
  describe('Load Instructions (8-bit mode)', () => {
    beforeEach(() => {
      memory.setResetVector(0x8000);
      cpu.reset();
    });
    
    it('LDA immediate should load value into A', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA9, 0x42,  // LDA #$42
      ]);
      
      cpu.step(10);
      const regs = cpu.getRegisters();
      
      expect(regs.A & 0xFF).toBe(0x42);
    });
    
    it('LDA should set zero flag when loading 0', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA9, 0x00,  // LDA #$00
      ]);
      
      cpu.step(10);
      const regs = cpu.getRegisters();
      
      expect(regs.P & StatusFlag.Z).not.toBe(0);
      expect(regs.P & StatusFlag.N).toBe(0);
    });
    
    it('LDA should set negative flag when loading negative value', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA9, 0x80,  // LDA #$80
      ]);
      
      cpu.step(10);
      const regs = cpu.getRegisters();
      
      expect(regs.P & StatusFlag.N).not.toBe(0);
      expect(regs.P & StatusFlag.Z).toBe(0);
    });
    
    it('LDX immediate should load value into X', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA2, 0x55,  // LDX #$55
      ]);
      
      cpu.step(10);
      const regs = cpu.getRegisters();
      
      expect(regs.X & 0xFF).toBe(0x55);
    });
    
    it('LDY immediate should load value into Y', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA0, 0xAA,  // LDY #$AA
      ]);
      
      cpu.step(10);
      const regs = cpu.getRegisters();
      
      expect(regs.Y & 0xFF).toBe(0xAA);
    });
  });
  
  describe('Store Instructions', () => {
    beforeEach(() => {
      memory.setResetVector(0x8000);
      cpu.reset();
    });
    
    it('STA direct should store A to direct page', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA9, 0x42,  // LDA #$42
        0x85, 0x10,  // STA $10
      ]);
      
      cpu.step(20);
      
      expect(memory.read(0x00, 0x10)).toBe(0x42);
    });
    
    it('STZ should store zero', () => {
      memory.write(0x00, 0x20, 0xFF);
      memory.loadProgram(0x00, 0x8000, [
        0x64, 0x20,  // STZ $20
      ]);
      
      cpu.step(20);
      
      expect(memory.read(0x00, 0x20)).toBe(0x00);
    });
  });
  
  describe('Arithmetic Instructions', () => {
    beforeEach(() => {
      memory.setResetVector(0x8000);
      cpu.reset();
    });
    
    it('ADC should add with carry clear', () => {
      memory.loadProgram(0x00, 0x8000, [
        0x18,        // CLC
        0xA9, 0x10,  // LDA #$10
        0x69, 0x20,  // ADC #$20
      ]);
      
      cpu.step(30);
      const regs = cpu.getRegisters();
      
      expect(regs.A & 0xFF).toBe(0x30);
      expect(regs.P & StatusFlag.C).toBe(0);
    });
    
    it('ADC should set carry on overflow', () => {
      memory.loadProgram(0x00, 0x8000, [
        0x18,        // CLC
        0xA9, 0x80,  // LDA #$80
        0x69, 0x80,  // ADC #$80
      ]);
      
      cpu.step(30);
      const regs = cpu.getRegisters();
      
      expect(regs.A & 0xFF).toBe(0x00);
      expect(regs.P & StatusFlag.C).not.toBe(0);
      expect(regs.P & StatusFlag.Z).not.toBe(0);
    });
    
    it('SBC should subtract with borrow', () => {
      memory.loadProgram(0x00, 0x8000, [
        0x38,        // SEC
        0xA9, 0x30,  // LDA #$30
        0xE9, 0x10,  // SBC #$10
      ]);
      
      cpu.step(30);
      const regs = cpu.getRegisters();
      
      expect(regs.A & 0xFF).toBe(0x20);
    });
    
    it('INC A should increment accumulator', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA9, 0x41,  // LDA #$41
        0x1A,        // INC A
      ]);
      
      cpu.step(20);
      const regs = cpu.getRegisters();
      
      expect(regs.A & 0xFF).toBe(0x42);
    });
    
    it('DEC A should decrement accumulator', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA9, 0x42,  // LDA #$42
        0x3A,        // DEC A
      ]);
      
      cpu.step(20);
      const regs = cpu.getRegisters();
      
      expect(regs.A & 0xFF).toBe(0x41);
    });
    
    it('INX should increment X', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA2, 0x10,  // LDX #$10
        0xE8,        // INX
      ]);
      
      cpu.step(20);
      const regs = cpu.getRegisters();
      
      expect(regs.X & 0xFF).toBe(0x11);
    });
    
    it('DEY should decrement Y', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA0, 0x10,  // LDY #$10
        0x88,        // DEY
      ]);
      
      cpu.step(20);
      const regs = cpu.getRegisters();
      
      expect(regs.Y & 0xFF).toBe(0x0F);
    });
  });
  
  describe('Branch Instructions', () => {
    beforeEach(() => {
      memory.setResetVector(0x8000);
      cpu.reset();
    });
    
    it('BEQ should branch when zero flag set', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA9, 0x00,  // LDA #$00 (sets Z flag)
        0xF0, 0x02,  // BEQ +2
        0xA9, 0xFF,  // LDA #$FF (skipped)
        0xA9, 0x42,  // LDA #$42 (branch target)
      ]);
      
      cpu.step(30);
      const regs = cpu.getRegisters();
      
      expect(regs.A & 0xFF).toBe(0x42);
    });
    
    it('BNE should not branch when zero flag set', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA9, 0x00,  // LDA #$00 (sets Z flag)
        0xD0, 0x02,  // BNE +2 (not taken)
        0xA9, 0xFF,  // LDA #$FF (executed)
        0xEA,        // NOP
      ]);
      
      cpu.step(30);
      const regs = cpu.getRegisters();
      
      expect(regs.A & 0xFF).toBe(0xFF);
    });
    
    it('BRA should always branch', () => {
      memory.loadProgram(0x00, 0x8000, [
        0x80, 0x02,  // BRA +2
        0xA9, 0xFF,  // LDA #$FF (skipped)
        0xA9, 0x42,  // LDA #$42 (branch target)
      ]);
      
      cpu.step(20);
      const regs = cpu.getRegisters();
      
      expect(regs.A & 0xFF).toBe(0x42);
    });
    
    it('should handle backward branches', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA2, 0x03,  // LDX #$03
        0xCA,        // DEX (loop start at $8002)
        0xD0, 0xFD,  // BNE -3 (back to DEX)
        0xA9, 0x42,  // LDA #$42 (after loop)
      ]);
      
      cpu.step(100);
      const regs = cpu.getRegisters();
      
      expect(regs.X & 0xFF).toBe(0x00);
      expect(regs.A & 0xFF).toBe(0x42);
    });
  });
  
  describe('Jump and Call Instructions', () => {
    beforeEach(() => {
      memory.setResetVector(0x8000);
      cpu.reset();
    });
    
    it('JMP absolute should set PC', () => {
      memory.loadProgram(0x00, 0x8000, [
        0x4C, 0x10, 0x80,  // JMP $8010
      ]);
      memory.loadProgram(0x00, 0x8010, [
        0xA9, 0x42,  // LDA #$42
      ]);
      
      cpu.step(100);
      const regs = cpu.getRegisters();
      
      expect(regs.A & 0xFF).toBe(0x42);
    });
    
    it('JSR should push return address and jump', () => {
      memory.loadProgram(0x00, 0x8000, [
        0x20, 0x10, 0x80,  // JSR $8010
        0xA9, 0xFF,        // LDA #$FF (return here)
        0xEA,              // NOP
      ]);
      memory.loadProgram(0x00, 0x8010, [
        0xA9, 0x42,  // LDA #$42
        0x60,        // RTS
      ]);
      
      cpu.step(200);
      const regs = cpu.getRegisters();
      
      // After RTS, should load $FF
      expect(regs.A & 0xFF).toBe(0xFF);
    });
  });
  
  describe('Stack Instructions', () => {
    beforeEach(() => {
      memory.setResetVector(0x8000);
      cpu.reset();
    });
    
    it('PHA/PLA should push and pull A', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA9, 0x42,  // LDA #$42
        0x48,        // PHA
        0xA9, 0x00,  // LDA #$00
        0x68,        // PLA
      ]);
      
      cpu.step(100);
      const regs = cpu.getRegisters();
      
      expect(regs.A & 0xFF).toBe(0x42);
    });
    
    it('PHX/PLX should push and pull X', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA2, 0x55,  // LDX #$55
        0xDA,        // PHX
        0xA2, 0x00,  // LDX #$00
        0xFA,        // PLX
      ]);
      
      cpu.step(100);
      const regs = cpu.getRegisters();
      
      expect(regs.X & 0xFF).toBe(0x55);
    });
  });
  
  describe('Transfer Instructions', () => {
    beforeEach(() => {
      memory.setResetVector(0x8000);
      cpu.reset();
    });
    
    it('TAX should transfer A to X', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA9, 0x42,  // LDA #$42
        0xAA,        // TAX
      ]);
      
      cpu.step(20);
      const regs = cpu.getRegisters();
      
      expect(regs.X & 0xFF).toBe(0x42);
    });
    
    it('TYA should transfer Y to A', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA0, 0x55,  // LDY #$55
        0x98,        // TYA
      ]);
      
      cpu.step(20);
      const regs = cpu.getRegisters();
      
      expect(regs.A & 0xFF).toBe(0x55);
    });
  });
  
  describe('Flag Instructions', () => {
    beforeEach(() => {
      memory.setResetVector(0x8000);
      cpu.reset();
    });
    
    it('SEC should set carry', () => {
      memory.loadProgram(0x00, 0x8000, [
        0x18,  // CLC
        0x38,  // SEC
      ]);
      
      cpu.step(20);
      const regs = cpu.getRegisters();
      
      expect(regs.P & StatusFlag.C).not.toBe(0);
    });
    
    it('CLC should clear carry', () => {
      memory.loadProgram(0x00, 0x8000, [
        0x38,  // SEC
        0x18,  // CLC
      ]);
      
      cpu.step(20);
      const regs = cpu.getRegisters();
      
      expect(regs.P & StatusFlag.C).toBe(0);
    });
    
    it('SEI should set interrupt disable', () => {
      memory.loadProgram(0x00, 0x8000, [
        0x58,  // CLI
        0x78,  // SEI
      ]);
      
      cpu.step(20);
      const regs = cpu.getRegisters();
      
      expect(regs.P & StatusFlag.I).not.toBe(0);
    });
  });
  
  describe('Native Mode (16-bit)', () => {
    beforeEach(() => {
      memory.setResetVector(0x8000);
      cpu.reset();
    });
    
    it('XCE should switch to native mode', () => {
      memory.loadProgram(0x00, 0x8000, [
        0x18,  // CLC
        0xFB,  // XCE (carry=0 -> E=0)
      ]);
      
      cpu.step(20);
      const regs = cpu.getRegisters();
      
      expect(regs.E).toBe(false);
      expect(regs.P & StatusFlag.C).not.toBe(0); // Old E value
    });
    
    it('REP should clear processor flags', () => {
      memory.loadProgram(0x00, 0x8000, [
        0x18,        // CLC
        0xFB,        // XCE (to native mode)
        0xC2, 0x30,  // REP #$30 (clear M and X)
      ]);
      
      cpu.step(30);
      const regs = cpu.getRegisters();
      
      expect(regs.P & StatusFlag.M).toBe(0);
      expect(regs.P & StatusFlag.X).toBe(0);
    });
    
    it('SEP should set processor flags', () => {
      memory.loadProgram(0x00, 0x8000, [
        0x18,        // CLC
        0xFB,        // XCE
        0xC2, 0x30,  // REP #$30
        0xE2, 0x20,  // SEP #$20 (set M)
      ]);
      
      cpu.step(40);
      const regs = cpu.getRegisters();
      
      expect(regs.P & StatusFlag.M).not.toBe(0);
      expect(regs.P & StatusFlag.X).toBe(0);
    });
    
    it('16-bit LDA should load 2 bytes', () => {
      memory.loadProgram(0x00, 0x8000, [
        0x18,              // CLC
        0xFB,              // XCE
        0xC2, 0x20,        // REP #$20 (16-bit A)
        0xA9, 0x34, 0x12,  // LDA #$1234
      ]);
      
      cpu.step(40);
      const regs = cpu.getRegisters();
      
      expect(regs.A).toBe(0x1234);
    });
  });
  
  describe('Interrupts', () => {
    beforeEach(() => {
      memory.setResetVector(0x8000);
      memory.write(0x00, 0xFFFA, 0x00); // NMI vector low
      memory.write(0x00, 0xFFFB, 0x90); // NMI vector high = $9000
      cpu.reset();
    });
    
    it('NMI should push registers and jump to handler', () => {
      memory.loadProgram(0x00, 0x8000, [
        0xA9, 0x42,  // LDA #$42
        0xEA,        // NOP
        0xEA,        // NOP
      ]);
      memory.loadProgram(0x00, 0x9000, [
        0xA9, 0xFF,  // LDA #$FF (NMI handler)
        0x40,        // RTI
      ]);
      
      cpu.step(10);
      cpu.triggerNMI();
      cpu.step(30);
      
      const regs = cpu.getRegisters();
      expect(regs.A & 0xFF).toBe(0xFF);
    });
  });
  
  describe('State Management', () => {
    it('should save and restore state', () => {
      memory.setResetVector(0x8000);
      memory.loadProgram(0x00, 0x8000, [
        0xA9, 0x42,  // LDA #$42
        0xA2, 0x55,  // LDX #$55
      ]);
      
      cpu.reset();
      cpu.step(20);
      
      const state = cpu.saveState();
      
      // Reset and restore
      cpu.reset();
      cpu.loadState(state);
      
      const regs = cpu.getRegisters();
      expect(regs.A & 0xFF).toBe(0x42);
      expect(regs.X & 0xFF).toBe(0x55);
    });
  });
});

// ============================================================================
// TomHarte Test Suite Integration (placeholder)
// ============================================================================

describe('TomHarte 65C816 Tests', () => {
  it.todo('should pass all TomHarte CPU tests');
  
  // These tests would load the actual TomHarte test ROM files
  // and verify each instruction produces correct results
  
  it.todo('should correctly handle all addressing modes');
  it.todo('should correctly handle all edge cases for ADC/SBC');
  it.todo('should correctly handle decimal mode');
  it.todo('should correctly handle all 16-bit operations');
});
