/**
 * Project 16-bit: SFC Emulator
 * ROM Loader Module
 * 
 * Handles loading ROM files from various formats:
 * - .smc / .sfc - Raw SNES ROM files
 * - .zip - Compressed ROM archives
 * - Automatic SMC header detection and removal
 */

// ============================================================================
// Types
// ============================================================================

export interface LoadedROM {
  /** Raw ROM data with header removed */
  data: Uint8Array;
  /** Original filename */
  filename: string;
  /** Whether a copier header was detected and removed */
  hadHeader: boolean;
  /** Original file size before processing */
  originalSize: number;
  /** Source format */
  format: ROMFormat;
}

export type ROMFormat = 'smc' | 'sfc' | 'fig' | 'zip' | 'unknown';

export interface LoadResult {
  success: boolean;
  rom?: LoadedROM;
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** SMC/SWC copier header size */
const COPIER_HEADER_SIZE = 512;

/** Supported ROM file extensions */
const SUPPORTED_EXTENSIONS = ['.smc', '.sfc', '.fig', '.swc', '.zip'];

/** ROM file signatures inside ZIP */
const ROM_EXTENSIONS_IN_ZIP = ['.smc', '.sfc', '.fig', '.swc'];

// ============================================================================
// ROMLoader Class
// ============================================================================

export class ROMLoader {
  /**
   * Load ROM from a File object (browser FileReader API)
   */
  static async loadFromFile(file: File): Promise<LoadResult> {
    try {
      const extension = this.getExtension(file.name);
      
      if (!SUPPORTED_EXTENSIONS.includes(extension)) {
        return {
          success: false,
          error: `Unsupported file format: ${extension}. Supported formats: ${SUPPORTED_EXTENSIONS.join(', ')}`
        };
      }
      
      const arrayBuffer = await this.readFileAsArrayBuffer(file);
      const data = new Uint8Array(arrayBuffer);
      
      if (extension === '.zip') {
        return await this.loadFromZip(data, file.name);
      }
      
      return this.processROMData(data, file.name, extension as ROMFormat);
    } catch (error) {
      return {
        success: false,
        error: `Failed to load file: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  
  /**
   * Load ROM from raw Uint8Array data
   */
  static loadFromData(data: Uint8Array, filename: string = 'rom.sfc'): LoadResult {
    const extension = this.getExtension(filename);
    const format = this.extensionToFormat(extension);
    return this.processROMData(data, filename, format);
  }
  
  /**
   * Load ROM from a URL (fetch API)
   */
  static async loadFromURL(url: string): Promise<LoadResult> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return {
          success: false,
          error: `Failed to fetch ROM: ${response.status} ${response.statusText}`
        };
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      const filename = this.extractFilenameFromURL(url);
      const extension = this.getExtension(filename);
      
      if (extension === '.zip') {
        return await this.loadFromZip(data, filename);
      }
      
      return this.processROMData(data, filename, this.extensionToFormat(extension));
    } catch (error) {
      return {
        success: false,
        error: `Failed to load from URL: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  
  /**
   * Load ROM from ArrayBuffer (for Node.js fs.readFile)
   */
  static loadFromArrayBuffer(buffer: ArrayBuffer, filename: string = 'rom.sfc'): LoadResult {
    return this.loadFromData(new Uint8Array(buffer), filename);
  }
  
  // ============================================================================
  // ZIP Processing (using JSZip or built-in decompression)
  // ============================================================================
  
  /**
   * Load ROM from ZIP file
   * Uses a simple ZIP parser for single-file archives
   */
  static async loadFromZip(zipData: Uint8Array, zipFilename: string): Promise<LoadResult> {
    try {
      // Try to extract ROM file from ZIP
      const extracted = await this.extractFromZip(zipData);
      
      if (!extracted) {
        return {
          success: false,
          error: 'No ROM file found in ZIP archive. Looking for: ' + ROM_EXTENSIONS_IN_ZIP.join(', ')
        };
      }
      
      // Process the extracted ROM
      const result = this.processROMData(extracted.data, extracted.filename, extracted.format);
      
      if (result.success && result.rom) {
        result.rom.format = 'zip';
      }
      
      return result;
    } catch (error) {
      return {
        success: false,
        error: `Failed to extract ZIP: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  
  /**
   * Simple ZIP extractor for single-file ROM archives
   * Supports STORE (no compression) and DEFLATE compression
   */
  private static async extractFromZip(zipData: Uint8Array): Promise<{
    data: Uint8Array;
    filename: string;
    format: ROMFormat;
  } | null> {
    // Check ZIP signature
    if (zipData[0] !== 0x50 || zipData[1] !== 0x4B || 
        zipData[2] !== 0x03 || zipData[3] !== 0x04) {
      throw new Error('Invalid ZIP file signature');
    }
    
    // Parse local file header
    const view = new DataView(zipData.buffer, zipData.byteOffset, zipData.byteLength);
    
    let offset = 0;
    
    while (offset < zipData.length - 30) {
      // Check for local file header signature
      const signature = view.getUint32(offset, true);
      if (signature !== 0x04034B50) {
        break;
      }
      
      const compressionMethod = view.getUint16(offset + 8, true);
      const compressedSize = view.getUint32(offset + 18, true);
      const uncompressedSize = view.getUint32(offset + 22, true);
      const filenameLength = view.getUint16(offset + 26, true);
      const extraLength = view.getUint16(offset + 28, true);
      
      // Extract filename
      const filenameBytes = zipData.slice(offset + 30, offset + 30 + filenameLength);
      const filename = new TextDecoder().decode(filenameBytes);
      
      // Calculate data offset
      const dataOffset = offset + 30 + filenameLength + extraLength;
      
      // Check if this is a ROM file
      const ext = this.getExtension(filename);
      if (ROM_EXTENSIONS_IN_ZIP.includes(ext)) {
        let fileData: Uint8Array;
        
        if (compressionMethod === 0) {
          // STORE - no compression
          fileData = zipData.slice(dataOffset, dataOffset + compressedSize);
        } else if (compressionMethod === 8) {
          // DEFLATE - need decompression
          const compressed = zipData.slice(dataOffset, dataOffset + compressedSize);
          fileData = await this.inflateData(compressed, uncompressedSize);
        } else {
          // Unsupported compression method
          offset = dataOffset + compressedSize;
          continue;
        }
        
        return {
          data: fileData,
          filename: filename,
          format: this.extensionToFormat(ext)
        };
      }
      
      // Move to next file
      offset = dataOffset + compressedSize;
    }
    
    return null;
  }
  
  /**
   * Decompress DEFLATE data using DecompressionStream API
   * Falls back to pure JavaScript implementation if not available
   */
  private static async inflateData(compressed: Uint8Array, expectedSize: number): Promise<Uint8Array> {
    // Try using DecompressionStream API (modern browsers)
    if (typeof DecompressionStream !== 'undefined') {
      try {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        
        writer.write(compressed);
        writer.close();
        
        const chunks: Uint8Array[] = [];
        let totalLength = 0;
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          totalLength += value.length;
        }
        
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        
        return result;
      } catch (e) {
        console.warn('DecompressionStream failed, using fallback:', e);
        // Fall through to JavaScript implementation
      }
    }
    
    // Fallback: Pure JavaScript DEFLATE decompression
    return this.inflateJS(compressed, expectedSize);
  }
  
  /**
   * Pure JavaScript DEFLATE decompression implementation
   */
  private static inflateJS(compressed: Uint8Array, expectedSize: number): Uint8Array {
    const output = new Uint8Array(expectedSize);
    let outPos = 0;
    let bitBuf = 0;
    let bitCnt = 0;
    let pos = 0;
    
    const getBits = (n: number): number => {
      while (bitCnt < n) {
        if (pos >= compressed.length) return 0;
        bitBuf |= compressed[pos++] << bitCnt;
        bitCnt += 8;
      }
      const result = bitBuf & ((1 << n) - 1);
      bitBuf >>= n;
      bitCnt -= n;
      return result;
    };
    
    // Fixed Huffman code lengths
    const fixedLitLen = new Uint8Array(288);
    for (let i = 0; i <= 143; i++) fixedLitLen[i] = 8;
    for (let i = 144; i <= 255; i++) fixedLitLen[i] = 9;
    for (let i = 256; i <= 279; i++) fixedLitLen[i] = 7;
    for (let i = 280; i <= 287; i++) fixedLitLen[i] = 8;
    
    const fixedDistLen = new Uint8Array(32).fill(5);
    
    const buildHuffman = (lengths: Uint8Array): { symbols: Uint16Array; counts: Uint16Array } => {
      const maxLen = Math.max(...lengths);
      const counts = new Uint16Array(maxLen + 1);
      const symbols = new Uint16Array(lengths.length);
      
      for (const len of lengths) if (len) counts[len]++;
      
      const offsets = new Uint16Array(maxLen + 1);
      for (let i = 1; i <= maxLen; i++) {
        offsets[i] = offsets[i - 1] + counts[i - 1];
      }
      
      for (let i = 0; i < lengths.length; i++) {
        if (lengths[i]) symbols[offsets[lengths[i]]++] = i;
      }
      
      return { symbols, counts };
    };
    
    const decodeSymbol = (huff: { symbols: Uint16Array; counts: Uint16Array }): number => {
      let code = 0;
      let first = 0;
      let idx = 0;
      
      for (let len = 1; len < huff.counts.length; len++) {
        code |= getBits(1);
        const count = huff.counts[len];
        if (code < first + count) {
          return huff.symbols[idx + code - first];
        }
        idx += count;
        first = (first + count) << 1;
        code <<= 1;
      }
      return 0;
    };
    
    // Length and distance extra bits tables
    const lenBase = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
    const lenExtra = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
    const distBase = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
    const distExtra = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
    
    // Process blocks
    let lastBlock = false;
    while (!lastBlock && outPos < expectedSize) {
      lastBlock = getBits(1) === 1;
      const blockType = getBits(2);
      
      if (blockType === 0) {
        // Stored block
        bitBuf = 0;
        bitCnt = 0;
        const len = compressed[pos] | (compressed[pos + 1] << 8);
        pos += 4; // skip len and nlen
        for (let i = 0; i < len && outPos < expectedSize; i++) {
          output[outPos++] = compressed[pos++];
        }
      } else {
        let litHuff: { symbols: Uint16Array; counts: Uint16Array };
        let distHuff: { symbols: Uint16Array; counts: Uint16Array };
        
        if (blockType === 1) {
          // Fixed Huffman
          litHuff = buildHuffman(fixedLitLen);
          distHuff = buildHuffman(fixedDistLen);
        } else {
          // Dynamic Huffman
          const hlit = getBits(5) + 257;
          const hdist = getBits(5) + 1;
          const hclen = getBits(4) + 4;
          
          const codeLenOrder = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
          const codeLens = new Uint8Array(19);
          for (let i = 0; i < hclen; i++) {
            codeLens[codeLenOrder[i]] = getBits(3);
          }
          
          const codeHuff = buildHuffman(codeLens);
          const allLens = new Uint8Array(hlit + hdist);
          let i = 0;
          
          while (i < allLens.length) {
            const sym = decodeSymbol(codeHuff);
            if (sym < 16) {
              allLens[i++] = sym;
            } else if (sym === 16) {
              const repeat = getBits(2) + 3;
              const val = allLens[i - 1];
              for (let j = 0; j < repeat && i < allLens.length; j++) allLens[i++] = val;
            } else if (sym === 17) {
              i += getBits(3) + 3;
            } else {
              i += getBits(7) + 11;
            }
          }
          
          litHuff = buildHuffman(allLens.slice(0, hlit));
          distHuff = buildHuffman(allLens.slice(hlit));
        }
        
        // Decode symbols
        while (outPos < expectedSize) {
          const sym = decodeSymbol(litHuff);
          
          if (sym < 256) {
            output[outPos++] = sym;
          } else if (sym === 256) {
            break; // End of block
          } else {
            // Length-distance pair
            const lenIdx = sym - 257;
            const length = lenBase[lenIdx] + getBits(lenExtra[lenIdx]);
            const distIdx = decodeSymbol(distHuff);
            const distance = distBase[distIdx] + getBits(distExtra[distIdx]);
            
            for (let i = 0; i < length && outPos < expectedSize; i++) {
              output[outPos] = output[outPos - distance];
              outPos++;
            }
          }
        }
      }
    }
    
    return output.slice(0, outPos);
  }
  
  // ============================================================================
  // ROM Processing
  // ============================================================================
  
  /**
   * Process raw ROM data - detect and remove copier header
   */
  private static processROMData(data: Uint8Array, filename: string, format: ROMFormat): LoadResult {
    const originalSize = data.length;
    let hadHeader = false;
    let romData = data;
    
    // Check for copier header (512 bytes)
    // A copier header is present if (filesize % 1024) == 512
    if (data.length >= COPIER_HEADER_SIZE && (data.length % 1024) === COPIER_HEADER_SIZE) {
      // Verify this looks like a copier header (first bytes are usually 0x00 or specific patterns)
      // The header typically has metadata in first few bytes, rest are zeros
      const headerLooksValid = this.validateCopierHeader(data.slice(0, COPIER_HEADER_SIZE));
      
      if (headerLooksValid) {
        romData = data.slice(COPIER_HEADER_SIZE);
        hadHeader = true;
      }
    }
    
    // Validate ROM size (should be power of 2 or common ROM sizes)
    if (!this.isValidROMSize(romData.length)) {
      // Still try to use it, but warn
      console.warn(`Unusual ROM size: ${romData.length} bytes`);
    }
    
    return {
      success: true,
      rom: {
        data: romData,
        filename,
        hadHeader,
        originalSize,
        format
      }
    };
  }
  
  /**
   * Validate that this looks like a copier header
   */
  private static validateCopierHeader(header: Uint8Array): boolean {
    // SMC header typically has:
    // - Bytes 0-1: ROM size in 8KB units (little endian)
    // - Byte 2: Flags
    // - Bytes 8-511: Usually zeros
    
    // Check if most of bytes 8-511 are zeros (typical for copier headers)
    let zeroCount = 0;
    for (let i = 8; i < header.length; i++) {
      if (header[i] === 0) zeroCount++;
    }
    
    // If more than 90% zeros, likely a copier header
    return zeroCount > (header.length - 8) * 0.9;
  }
  
  /**
   * Check if ROM size is valid
   */
  private static isValidROMSize(size: number): boolean {
    // Common ROM sizes: 256KB to 6MB
    const validSizes = [
      256 * 1024,   // 2Mbit
      512 * 1024,   // 4Mbit
      768 * 1024,   // 6Mbit
      1024 * 1024,  // 8Mbit
      1536 * 1024,  // 12Mbit
      2048 * 1024,  // 16Mbit
      3072 * 1024,  // 24Mbit
      4096 * 1024,  // 32Mbit
      6144 * 1024,  // 48Mbit
    ];
    
    // Allow exact matches or close (within 64KB)
    return validSizes.some(vs => Math.abs(size - vs) < 65536);
  }
  
  // ============================================================================
  // Utility Functions
  // ============================================================================
  
  private static getExtension(filename: string): string {
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex === -1) return '';
    return filename.slice(dotIndex).toLowerCase();
  }
  
  private static extensionToFormat(ext: string): ROMFormat {
    switch (ext) {
      case '.smc': return 'smc';
      case '.sfc': return 'sfc';
      case '.fig': return 'fig';
      case '.swc': return 'smc';
      case '.zip': return 'zip';
      default: return 'unknown';
    }
  }
  
  private static extractFilenameFromURL(url: string): string {
    try {
      const pathname = new URL(url).pathname;
      const parts = pathname.split('/');
      return parts[parts.length - 1] || 'rom.sfc';
    } catch {
      return 'rom.sfc';
    }
  }
  
  private static readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }
  
  /**
   * Get list of supported file formats
   */
  static getSupportedFormats(): string[] {
    return [...SUPPORTED_EXTENSIONS];
  }
  
  /**
   * Check if a filename has a supported extension
   */
  static isSupported(filename: string): boolean {
    const ext = this.getExtension(filename);
    return SUPPORTED_EXTENSIONS.includes(ext);
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Load ROM from a File object
 */
export async function loadROMFile(file: File): Promise<LoadResult> {
  return ROMLoader.loadFromFile(file);
}

/**
 * Load ROM from a URL
 */
export async function loadROMFromURL(url: string): Promise<LoadResult> {
  return ROMLoader.loadFromURL(url);
}

/**
 * Load ROM from raw data
 */
export function loadROMData(data: Uint8Array, filename?: string): LoadResult {
  return ROMLoader.loadFromData(data, filename);
}

/**
 * Get supported file extensions
 */
export function getSupportedFormats(): string[] {
  return ROMLoader.getSupportedFormats();
}
