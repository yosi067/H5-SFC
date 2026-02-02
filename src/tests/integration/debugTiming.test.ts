/**
 * Debug test for timing accuracy
 */
import { describe, it, expect } from 'vitest';

describe('Timing Calculation', () => {
  it('should calculate correct cycles per scanline', () => {
    const NTSC_CPU_DIVIDER = 6;
    const PPU_DIVIDER = 4;
    const DOTS_PER_SCANLINE = 341;
    
    // My formula
    const cyclesPerScanline = Math.floor(DOTS_PER_SCANLINE * PPU_DIVIDER / NTSC_CPU_DIVIDER);
    console.log('Cycles per scanline:', cyclesPerScanline);
    // = 341 * 4 / 6 = 227.33 -> 227
    
    // How many PPU dots do we get from 227 CPU cycles?
    const ppuDotsPerScanline = 227 * NTSC_CPU_DIVIDER / PPU_DIVIDER;
    console.log('PPU dots from 227 CPU cycles:', ppuDotsPerScanline);
    // = 227 * 6 / 4 = 340.5
    
    // How many scanlines should we see after 262 * 227 = 59474 CPU cycles?
    const cpuCyclesPerFrame = 262 * 227;
    console.log('CPU cycles per frame:', cpuCyclesPerFrame);
    
    const ppuDotsPerFrame = cpuCyclesPerFrame * NTSC_CPU_DIVIDER / PPU_DIVIDER;
    console.log('PPU dots per frame:', ppuDotsPerFrame);
    // = 59474 * 1.5 = 89211
    
    const scanlinesPerFrame = ppuDotsPerFrame / DOTS_PER_SCANLINE;
    console.log('Scanlines per frame:', scanlinesPerFrame);
    // = 89211 / 341 = 261.6
    
    // Actually the problem might be integer division
    // Let's check what happens with actual cycles per instruction
    let totalPpuDots = 0;
    let totalCpuCycles = 0;
    const cyclesPerInstruction = [2, 3, 3, 4, 4, 4, 5, 5, 6, 8]; // typical mix
    
    // Simulate running 262 scanlines
    for (let scanline = 0; scanline < 262; scanline++) {
      let cyclesRemaining = 227;
      while (cyclesRemaining > 0) {
        const cpuCycles = cyclesPerInstruction[Math.floor(Math.random() * 10)];
        cyclesRemaining -= cpuCycles;
        totalCpuCycles += cpuCycles;
        
        const ppuDots = Math.ceil(cpuCycles * NTSC_CPU_DIVIDER / PPU_DIVIDER);
        totalPpuDots += ppuDots;
      }
    }
    
    console.log('Simulation results:');
    console.log('  Total CPU cycles:', totalCpuCycles);
    console.log('  Total PPU dots:', totalPpuDots);
    console.log('  Expected PPU dots per frame:', 262 * 341);
    console.log('  Actual scanlines:', totalPpuDots / 341);
    
    expect(true).toBe(true);
  });
});
