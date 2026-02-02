/**
 * Debug script to analyze why games are stuck during initialization
 */

import { Emulator, ROMLoader } from '../../index';
import * as fs from 'fs';
import * as path from 'path';

const TEST_ROM = 'D:\\yosi資料夾\\AI\\games\\sfc\\0045 - 超時空之鑰 (繁)(Beta)(Goldegg+Emukim).zip';

async function debugInit() {
  console.log('=== Game Initialization Debug ===\n');
  
  // Load ROM
  if (!fs.existsSync(TEST_ROM)) {
    console.error('ROM file not found:', TEST_ROM);
    return;
  }
  
  const fileData = fs.readFileSync(TEST_ROM);
  const result = await ROMLoader.loadFromZip(new Uint8Array(fileData), path.basename(TEST_ROM));
  
  if (!result.success || !result.rom) {
    console.error('Failed to load ROM:', result.error);
    return;
  }
  
  console.log('ROM loaded:', result.rom.title);
  console.log('Mapping:', result.rom.isHiROM ? 'HiROM' : 'LoROM');
  console.log('Reset Vector: $' + result.rom.resetVector?.toString(16));
  console.log('');
  
  // Create emulator
  const emulator = new Emulator();
  emulator.loadROM(result.rom.data);
  emulator.reset();
  
  // Track register reads
  const registerReads: Map<number, number> = new Map();
  const registerWrites: Map<number, number> = new Map();
  
  // Run for several frames and check state
  for (let frame = 0; frame < 10; frame++) {
    emulator.runFrame();
    
    const cpuInfo = emulator.getCPUDebugInfo();
    console.log(`Frame ${frame + 1}:`);
    console.log(`  PC: ${cpuInfo.PB.toString(16)}:${cpuInfo.PC.toString(16).padStart(4, '0')}`);
    console.log(`  A=${cpuInfo.A.toString(16).padStart(4, '0')} X=${cpuInfo.X.toString(16).padStart(4, '0')} Y=${cpuInfo.Y.toString(16).padStart(4, '0')}`);
    console.log(`  SP=${cpuInfo.SP.toString(16).padStart(4, '0')} P=${cpuInfo.P.toString(16).padStart(2, '0')} E=${cpuInfo.E}`);
    console.log(`  Cycles: ${cpuInfo.totalCycles}`);
    console.log(`  NMI Enabled: ${cpuInfo.nmiEnabled}`);
    console.log(`  Waiting: ${cpuInfo.waiting}, Halted: ${cpuInfo.halted}`);
    
    if (cpuInfo.nmiEnabled) {
      console.log('\n*** NMI has been enabled! ***\n');
      break;
    }
    
    console.log('');
  }
  
  // Get trace log
  const trace = emulator.getTraceLog();
  console.log('\n=== CPU Trace (first 50 instructions) ===\n');
  for (let i = 0; i < Math.min(50, trace.length); i++) {
    console.log(trace[i]);
  }
  
  // Look for patterns in the trace
  console.log('\n=== Pattern Analysis ===\n');
  
  // Check for loops reading $4212 (VBlank status)
  const vblankReads = trace.filter(line => line.includes('4212'));
  if (vblankReads.length > 0) {
    console.log(`Found ${vblankReads.length} reads of $4212 (HVBJOY)`);
    vblankReads.slice(0, 5).forEach(l => console.log('  ', l));
  }
  
  // Check for APU port reads
  const apuReads = trace.filter(line => 
    line.includes('2140') || line.includes('2141') || 
    line.includes('2142') || line.includes('2143')
  );
  if (apuReads.length > 0) {
    console.log(`Found ${apuReads.length} APU port accesses`);
    apuReads.slice(0, 5).forEach(l => console.log('  ', l));
  }
  
  // Check for repeated PC values (potential infinite loops)
  const pcCounts: Map<string, number> = new Map();
  for (const line of trace) {
    const match = line.match(/^([0-9a-f]{2}:[0-9a-f]{4})/i);
    if (match) {
      const pc = match[1];
      pcCounts.set(pc, (pcCounts.get(pc) || 0) + 1);
    }
  }
  
  console.log('\nMost visited PC addresses:');
  const sortedPCs = [...pcCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [pc, count] of sortedPCs) {
    console.log(`  ${pc}: ${count} times`);
  }
}

debugInit().catch(console.error);
