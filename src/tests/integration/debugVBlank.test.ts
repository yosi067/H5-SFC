/**
 * Debug test for VBlank detection
 */
import { describe, it, expect } from 'vitest';
import { Emulator, ROMLoader } from '../../index';
import * as fs from 'fs';
import * as path from 'path';

describe('VBlank Debug', () => {
  it('should check VBlank detection during frames', async () => {
    const TEST_ROM = 'D:\\yosi資料夾\\AI\\games\\sfc\\0045 - 超時空之鑰 (繁)(Beta)(Goldegg+Emukim).zip';
    
    if (!fs.existsSync(TEST_ROM)) {
      console.log('ROM not found, skipping');
      return;
    }

    const fileData = fs.readFileSync(TEST_ROM);
    const result = await ROMLoader.loadFromZip(new Uint8Array(fileData), path.basename(TEST_ROM));
    
    expect(result.success).toBe(true);
    
    const emulator = new Emulator();
    emulator.loadROM(result.rom!.data);
    emulator.reset();
    emulator.enableTrace(5000);  // Enable longer trace after reset
    
    // Check PPU state during a single frame
    const ppuBefore = emulator.getPPUDebugInfo();
    console.log('PPU before frame:', ppuBefore.scanline, ppuBefore.dot);
    
    // Run multiple frames and check PPU state each time
    for (let i = 0; i < 5; i++) {
      const cpuBefore = emulator.getCPUDebugInfo();
      emulator.runFrame();
      const cpuAfter = emulator.getCPUDebugInfo();
      const ppuState = emulator.getPPUDebugInfo();
      const cyclesThisFrame = Number(cpuAfter.totalCycles - cpuBefore.totalCycles);
      console.log(`Frame ${i+1}: PPU scanline=${ppuState.scanline} dot=${ppuState.dot}, NMI=${cpuAfter.nmiEnabled}, cycles=${cyclesThisFrame}`);
    }
    
    const ppuAfter = emulator.getPPUDebugInfo();
    console.log('PPU after 5 frames:', ppuAfter.scanline, ppuAfter.dot);
    
    // Check CPU trace for $4212 reads
    const trace = emulator.getTraceLog();
    console.log(`Total trace entries: ${trace.length}`);
    
    // Find first 5 trace entries
    console.log('\nFirst 10 trace entries:');
    for (let i = 0; i < Math.min(10, trace.length); i++) {
      console.log(trace[i]);
    }
    
    // Look for $4212 reads
    const reads4212 = trace.filter(line => line.includes('4212'));
    console.log(`\n$4212 (HVBJOY) reads: ${reads4212.length}`);
    reads4212.slice(0, 5).forEach(line => console.log('  ', line));
    
    // Look for APU port reads
    const apuReads = trace.filter(line => 
      line.includes('2140') || line.includes('2141') || 
      line.includes('2142') || line.includes('2143')
    );
    console.log(`\nAPU port reads: ${apuReads.length}`);
    apuReads.slice(0, 5).forEach(line => console.log('  ', line));

    // Look for writes to NMITIMEN ($4200)
    const nmitimenWrites = trace.filter(line => 
      line.includes('4200')
    );
    console.log(`\nNMITIMEN ($4200) accesses: ${nmitimenWrites.length}`);
    nmitimenWrites.slice(0, 20).forEach(line => console.log('  ', line));

    // Also check what the NMITIMEN register value is
    console.log('\nChecking if NMI is ever enabled...');
    // Look for STA $4200 or STZ $4200 patterns
    const nmitimen2 = trace.filter(line => 
      line.includes('00 42') || // might be STA $4200
      line.includes('8d') || line.includes('9c') // STA or STZ
    );
    console.log(`Total potential writes: ${nmitimen2.length}`);
    
    // Check for loops - find most visited addresses
    const pcCounts: Map<string, number> = new Map();
    for (const line of trace) {
      const match = line.match(/^([0-9a-f]{2}:[0-9a-f]{4})/i);
      if (match) {
        const pc = match[1].toLowerCase();
        pcCounts.set(pc, (pcCounts.get(pc) || 0) + 1);
      }
    }
    
    // Sort by count and show top loops
    const sorted = [...pcCounts.entries()].sort((a, b) => b[1] - a[1]);
    console.log('\nTop 20 most visited addresses (potential loops):');
    for (let i = 0; i < Math.min(20, sorted.length); i++) {
      // Get the full trace line for context
      const traceLine = trace.find(l => l.startsWith(sorted[i][0]));
      console.log(`  ${sorted[i][0]}: ${sorted[i][1]} times | ${traceLine?.substring(0, 80)}`);
    }
    
    expect(true).toBe(true);
  });
});
