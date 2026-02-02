/**
 * Debug test for boot sequence and APU handshake
 */
import { describe, it, expect } from 'vitest';
import { Emulator, ROMLoader } from '../../index';
import * as fs from 'fs';
import * as path from 'path';

describe('Boot Debug', () => {
  it('should trace early boot with APU port state', async () => {
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
    
    // Get APU state immediately after reset
    const apuInit = emulator.getAPUDebugInfo();
    console.log('\n=== APU State immediately after reset ===');
    console.log(`APU->CPU ports: [${apuInit.ports.map((p: number) => '$' + p.toString(16)).join(', ')}]`);
    console.log(`CPU->APU ports: [${apuInit.portsFromCPU.map((p: number) => '$' + p.toString(16)).join(', ')}]`);
    
    emulator.enableTrace(10000);  // Enable long trace
    
    // Run just 1 frame to see early boot
    emulator.runFrame();
    
    const trace = emulator.getTraceLog();
    console.log(`Total trace entries: ${trace.length}`);
    
    // Look for writes to APU ports $2140-$2143
    console.log('\n=== APU Port Writes ===');
    let writeCount = 0;
    for (const line of trace) {
      // Look for STA $2140, STA $2141, etc
      if (line.match(/8d 4[0-3] 21|9c 4[0-3] 21/i)) {
        console.log(line);
        writeCount++;
        if (writeCount > 20) break;
      }
    }
    
    // Look for reads from APU ports (CMP $2140, LDA $2140, etc)
    console.log('\n=== APU Port Reads ===');
    let readCount = 0;
    for (const line of trace) {
      // Look for CMP $2140, LDA $2140, etc (cd 40 21, ad 40 21)
      if (line.match(/cd 4[0-3] 21|ad 4[0-3] 21/i)) {
        console.log(line);
        readCount++;
        if (readCount > 20) break;
      }
    }
    
    // Get APU state
    const apuState = emulator.getAPUDebugInfo();
    console.log('\n=== APU State after 1 frame ===');
    console.log(`PC: $${apuState.PC.toString(16)}`);
    console.log(`Cycles: ${apuState.cycles}`);
    console.log(`APU->CPU ports: [${apuState.ports.map((p: number) => '$' + p.toString(16)).join(', ')}]`);
    console.log(`CPU->APU ports: [${apuState.portsFromCPU.map((p: number) => '$' + p.toString(16)).join(', ')}]`);
    console.log(`IPL enabled: ${apuState.iplEnabled}`);
    
    expect(true).toBe(true);
  });
});
