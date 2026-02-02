/**
 * Debug test for APU step-by-step execution
 */
import { describe, it, expect } from 'vitest';
import { Emulator, ROMLoader } from '../../index';
import * as fs from 'fs';
import * as path from 'path';

describe('APU Step Debug', () => {
  it('should trace why game gets stuck after APU transfer', async () => {
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
    emulator.enableTrace(50000);  // Large trace buffer
    
    // Run for 1 full frame to let APU transfer complete
    emulator.runFrame();
    
    let apu = emulator.getAPUDebugInfo();
    let cpu = emulator.getCPUDebugInfo();
    
    console.log('=== After 1 frame ===');
    console.log(`CPU: ${cpu.PB}:${cpu.PC}, NMI: ${cpu.nmiEnabled}`);
    console.log(`APU: PC=$${apu.PC.toString(16)}, cycles=${apu.cycles}`);
    console.log(`APU->CPU: [${apu.ports.map((p: number) => '$' + p.toString(16)).join(', ')}]`);
    console.log(`CPU->APU: [${apu.portsFromCPU.map((p: number) => '$' + p.toString(16)).join(', ')}]`);
    
    // Run for 10 more frames
    for (let f = 2; f <= 10; f++) {
      emulator.runFrame();
    }
    
    apu = emulator.getAPUDebugInfo();
    cpu = emulator.getCPUDebugInfo();
    
    console.log('\n=== After 10 frames ===');
    console.log(`CPU: ${cpu.PB}:${cpu.PC}, NMI: ${cpu.nmiEnabled}`);
    console.log(`APU: PC=$${apu.PC.toString(16)}, cycles=${apu.cycles}`);
    console.log(`APU->CPU: [${apu.ports.map((p: number) => '$' + p.toString(16)).join(', ')}]`);
    console.log(`CPU->APU: [${apu.portsFromCPU.map((p: number) => '$' + p.toString(16)).join(', ')}]`);
    
    // Get trace and analyze
    const trace = emulator.getTraceLog();
    console.log(`\nTotal trace entries: ${trace.length}`);
    
    // Count how often each address is visited
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
    console.log('\nTop 10 most visited addresses:');
    for (let i = 0; i < Math.min(10, sorted.length); i++) {
      const traceLine = trace.find(l => l.toLowerCase().startsWith(sorted[i][0]));
      const opcode = traceLine?.substring(8, 17) || '';
      console.log(`  ${sorted[i][0]}: ${sorted[i][1]} times - ${opcode}`);
    }
    
    // Look for VBlank-related register accesses
    const vblankAccesses = trace.filter(line => 
      line.includes('4210') || line.includes('4212') || line.includes('4200')
    );
    console.log(`\nVBlank register accesses: ${vblankAccesses.length}`);
    vblankAccesses.slice(0, 10).forEach(line => console.log('  ', line));
    
    expect(true).toBe(true);
  });
});
