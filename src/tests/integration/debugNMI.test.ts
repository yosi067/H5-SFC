/**
 * Debug test for NMI enable check
 */
import { describe, it, expect } from 'vitest';
import { Emulator, ROMLoader } from '../../index';
import * as fs from 'fs';
import * as path from 'path';

describe('NMI Debug', () => {
  it('should trace execution around $11F2 to find guard condition', async () => {
    const TEST_ROM = 'D:\\yosi資料夾\\AI\\games\\sfc\\0045 - 超時空之鑰 (繁)(Beta)(Goldegg+Emukim).zip';
    
    if (!fs.existsSync(TEST_ROM)) {
      console.log('ROM not found, skipping');
      return;
    }

    const fileData = fs.readFileSync(TEST_ROM);
    const result = await ROMLoader.loadFromZip(new Uint8Array(fileData), path.basename(TEST_ROM));
    
    expect(result).toBeDefined();
    
    const emulator = new Emulator();
    emulator.loadROM(result.rom!.data);
    emulator.reset();
    
    const apu = (emulator as any).apu;
    
    // Run to frame 100 first to get past IPL
    for (let f = 1; f <= 100; f++) {
      emulator.runFrame();
    }
    
    // Disassemble $11E0-$1200 properly with SPC700 instruction sizes
    console.log('=== Proper SPC700 disassembly of $11E0-$1210 ===');
    
    // SPC700 opcode info: [mnemonic, size, description]
    const opcodes: {[key: number]: [string, number]} = {
      0x00: ['NOP', 1],
      0x10: ['BPL rel', 2],
      0x2F: ['BRA rel', 2],
      0x3E: ['CMP X, dp', 2],
      0x3F: ['CALL abs', 3],
      0x5F: ['JMP abs', 3],
      0x6F: ['RET', 1],
      0x7F: ['RETI', 1],
      0xC4: ['MOV dp, A', 2],
      0xD0: ['BNE rel', 2],
      0xD8: ['MOV dp, X', 2],
      0xE4: ['MOV A, dp', 2],
      0xE8: ['MOV A, #imm', 2],
      0xF0: ['BEQ rel', 2],
      0xF1: ['TCALL 15', 1],
      0xF4: ['MOV A, dp+X', 2],
      0xF6: ['MOV A, abs+Y', 3],
      0xF8: ['MOV X, dp', 2],
      0xFA: ['MOV dp, dp', 3],
      0xFC: ['INC Y', 1],
    };
    
    let pc = 0x11E0;
    while (pc < 0x1210) {
      const op = apu.ram[pc];
      const b1 = apu.ram[(pc + 1) & 0xFFFF];
      const b2 = apu.ram[(pc + 2) & 0xFFFF];
      
      const info = opcodes[op];
      if (info) {
        const [mnemonic, size] = info;
        let bytes = '';
        for (let i = 0; i < size; i++) {
          bytes += apu.ram[(pc + i) & 0xFFFF].toString(16).padStart(2,'0') + ' ';
        }
        console.log(`$${pc.toString(16).padStart(4,'0')}: ${bytes.padEnd(10)} ${mnemonic}`);
        pc += size;
      } else {
        console.log(`$${pc.toString(16).padStart(4,'0')}: ${op.toString(16).padStart(2,'0')}          ???`);
        pc++;
      }
    }
    
    // Check what code calls $11E4 (the subroutine containing TCALL 15)
    console.log('\n=== Searching for CALL $11E4 ===');
    for (let addr = 0x200; addr < 0x5000; addr++) {
      if (apu.ram[addr] === 0x3F) { // CALL
        const target = apu.ram[addr + 1] | (apu.ram[addr + 2] << 8);
        if (target >= 0x11E0 && target <= 0x11F5) {
          console.log(`  $${addr.toString(16)}: CALL $${target.toString(16)}`);
        }
      }
    }
    
    expect(true).toBe(true);
  });
});
