/**
 * ROM Loader Tests
 */

import { describe, it, expect } from 'vitest';
import { ROMLoader, loadROMData } from './romLoader';

describe('ROMLoader', () => {
  describe('Supported Formats', () => {
    it('should list supported formats', () => {
      const formats = ROMLoader.getSupportedFormats();
      expect(formats).toContain('.smc');
      expect(formats).toContain('.sfc');
      expect(formats).toContain('.zip');
    });
    
    it('should check if format is supported', () => {
      expect(ROMLoader.isSupported('game.smc')).toBe(true);
      expect(ROMLoader.isSupported('game.sfc')).toBe(true);
      expect(ROMLoader.isSupported('game.zip')).toBe(true);
      expect(ROMLoader.isSupported('game.nes')).toBe(false);
      expect(ROMLoader.isSupported('game.txt')).toBe(false);
    });
  });
  
  describe('Raw ROM Loading', () => {
    it('should load raw ROM data without header', () => {
      // Create a mock ROM (512KB)
      const romSize = 512 * 1024;
      const rom = new Uint8Array(romSize);
      
      // Set some ROM header values at LoROM location
      rom[0x7FC0] = 0x54; // 'T'
      rom[0x7FC1] = 0x45; // 'E'
      rom[0x7FC2] = 0x53; // 'S'
      rom[0x7FC3] = 0x54; // 'T'
      
      const result = loadROMData(rom, 'test.sfc');
      
      expect(result.success).toBe(true);
      expect(result.rom).toBeDefined();
      expect(result.rom!.data.length).toBe(romSize);
      expect(result.rom!.hadHeader).toBe(false);
      expect(result.rom!.format).toBe('sfc');
    });
    
    it('should detect and remove SMC copier header', () => {
      // Create a mock ROM with 512-byte copier header
      const romSize = 512 * 1024;
      const headerSize = 512;
      const total = romSize + headerSize;
      const romWithHeader = new Uint8Array(total);
      
      // SMC header: first 8 bytes have data, rest mostly zeros
      romWithHeader[0] = 0x00;
      romWithHeader[1] = 0x80; // ROM size
      romWithHeader[2] = 0x00;
      // Bytes 8-511 are zeros (typical for copier header)
      
      // Put ROM data after header
      romWithHeader[headerSize + 0x7FC0] = 0x54; // 'T'
      
      const result = loadROMData(romWithHeader, 'test.smc');
      
      expect(result.success).toBe(true);
      expect(result.rom).toBeDefined();
      expect(result.rom!.data.length).toBe(romSize);
      expect(result.rom!.hadHeader).toBe(true);
      expect(result.rom!.originalSize).toBe(total);
    });
    
    it('should handle various file extensions', () => {
      const rom = new Uint8Array(512 * 1024);
      
      expect(loadROMData(rom, 'game.smc').rom?.format).toBe('smc');
      expect(loadROMData(rom, 'game.sfc').rom?.format).toBe('sfc');
      expect(loadROMData(rom, 'game.fig').rom?.format).toBe('fig');
      expect(loadROMData(rom, 'game.SFC').rom?.format).toBe('sfc');
      expect(loadROMData(rom, 'GAME.SMC').rom?.format).toBe('smc');
    });
  });
  
  describe('ZIP Detection', () => {
    it('should detect invalid ZIP signature', async () => {
      // Not a valid ZIP file
      const notZip = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
      
      const result = await ROMLoader.loadFromZip(notZip, 'fake.zip');
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid ZIP');
    });
    
    it('should handle empty ZIP with no ROM', async () => {
      // Valid ZIP with a non-ROM file (txt)
      // Local file header for "test.txt"
      const filename = 'test.txt';
      const fileContent = new Uint8Array([0x48, 0x69]); // "Hi"
      
      const localHeader = new Uint8Array([
        0x50, 0x4B, 0x03, 0x04, // Local file header signature
        0x0A, 0x00, // Version needed
        0x00, 0x00, // General purpose flag
        0x00, 0x00, // Compression method (STORE)
        0x00, 0x00, // File time
        0x00, 0x00, // File date
        0x00, 0x00, 0x00, 0x00, // CRC-32 (ignored)
        fileContent.length, 0x00, 0x00, 0x00, // Compressed size
        fileContent.length, 0x00, 0x00, 0x00, // Uncompressed size
        filename.length, 0x00, // Filename length
        0x00, 0x00, // Extra field length
      ]);
      
      // Build ZIP
      const filenameBytes = new TextEncoder().encode(filename);
      const zip = new Uint8Array(localHeader.length + filenameBytes.length + fileContent.length);
      zip.set(localHeader, 0);
      zip.set(filenameBytes, localHeader.length);
      zip.set(fileContent, localHeader.length + filenameBytes.length);
      
      const result = await ROMLoader.loadFromZip(zip, 'test.zip');
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('No ROM file found');
    });
  });
  
  describe('ROM Size Validation', () => {
    it('should accept standard ROM sizes', () => {
      // 256KB - 2Mbit
      const rom256k = new Uint8Array(256 * 1024);
      expect(loadROMData(rom256k, 'test.sfc').success).toBe(true);
      
      // 1MB - 8Mbit
      const rom1m = new Uint8Array(1024 * 1024);
      expect(loadROMData(rom1m, 'test.sfc').success).toBe(true);
      
      // 4MB - 32Mbit
      const rom4m = new Uint8Array(4 * 1024 * 1024);
      expect(loadROMData(rom4m, 'test.sfc').success).toBe(true);
    });
    
    it('should still load unusual sized ROMs with warning', () => {
      // Unusual size (not power of 2)
      const oddRom = new Uint8Array(123456);
      const result = loadROMData(oddRom, 'test.sfc');
      
      // Should still succeed
      expect(result.success).toBe(true);
      expect(result.rom!.data.length).toBe(123456);
    });
  });
});
