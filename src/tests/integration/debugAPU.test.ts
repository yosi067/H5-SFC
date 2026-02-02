/**
 * Debug test for APU/SPC700 communication
 */
import { describe, it, expect } from 'vitest';
import { Emulator, ROMLoader } from '../../index';
import * as fs from 'fs';
import * as path from 'path';

describe('APU Debug', () => {
  it('should trace SPC700 execution', async () => {
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
    
    // Get APU state before running
    const apuBefore = emulator.getAPUDebugInfo();
    console.log('APU before:', apuBefore);
    
    // Run frames to see APU behavior
    let jumpedFromIPL = false;
    for (let i = 0; i < 200; i++) {
      emulator.runFrame();
      const apuState = emulator.getAPUDebugInfo();
      
      // Only print every 10 frames, or on significant events
      if (i % 10 === 9 || (apuState.PC < 0xFFC0 && !jumpedFromIPL)) {
        console.log(`Frame ${i+1}: PC=$${apuState.PC.toString(16)}, cycles=${apuState.cycles}, ports=[${apuState.ports.map((p: number) => p.toString(16)).join(',')}]`);
      }
      
      if (apuState.PC < 0xFFC0 && !jumpedFromIPL) {
        jumpedFromIPL = true;
        console.log(`*** APU jumped out of IPL ROM at frame ${i+1}! ***`);
      }
      
      // Check if port 1 ever changes from $BB
      if (apuState.ports[1] !== 0xBB && !jumpedFromIPL) {
        console.log(`*** Port 1 changed at frame ${i+1}! ***`);
      }
    }
    
    expect(true).toBe(true);
  });
});
